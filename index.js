/**
 * dsh-system-net — make DeepSeek Harness follow your system network settings
 * (proxy + certificates).
 *
 * 让 DeepSeek Harness 跟随系统网络设置（代理 + 证书）。
 *
 * It closes two **independent** gaps:
 *
 *  ① Routing — Node does not read the Windows/macOS "system proxy"; it only
 *     honours the http_proxy/https_proxy environment variables. The official
 *     guidance is to export them *before* startup; this plugin does it at runtime.
 *
 *     ① 走不走代理 —— Node 不读 Windows/macOS 的"系统代理"，只认
 *     http_proxy/https_proxy 环境变量。官方要求在启动前设好，插件在运行时补上。
 *
 *  ② Trust — accelerators and corporate proxies decrypt HTTPS and re-sign it
 *     with their own self-signed CA. Browsers work because they read the OS
 *     certificate store; Node does not, so it raises
 *     UNABLE_TO_VERIFY_LEAF_SIGNATURE. The official guidance is
 *     NODE_EXTRA_CA_CERTS or NODE_OPTIONS=--use-system-ca before startup;
 *     this plugin does it at runtime.
 *
 *     ② 信不信证书 —— 加速器/企业代理解密 HTTPS 后用自签 CA 重签。浏览器能用
 *     是因为它读系统证书库，而 Node 默认不读，于是报 UNABLE_TO_VERIFY_LEAF_SIGNATURE。
 *     官方要求在启动前设 NODE_EXTRA_CA_CERTS 或 NODE_OPTIONS=--use-system-ca。
 *
 * Both are done through **official runtime entry points**, so this plugin can
 * never disagree with the host:
 *
 *  - Proxy: {@link installProxyFromEnvironment}. It updates the global
 *    dispatcher *and* the policy read by `proxyRouteFor()` in one step, which is
 *    why web_search / web_fetch route correctly too. A plugin that only swaps
 *    the dispatcher cannot achieve this.
 *  - Certificates: `tls.setDefaultCACertificates` (Node 22.19+ / 24.5+).
 *
 * 两件事都通过官方运行时入口完成，因此与宿主永远一致：
 *  - 代理：installProxyFromEnvironment 会同时更新全局 dispatcher 与
 *    proxyRouteFor() 读取的策略，所以 web_search / web_fetch 也正确走代理；
 *    只换 dispatcher 的插件做不到这一点。
 *  - 证书：tls.setDefaultCACertificates（Node 22.19+ / 24.5+）。
 *
 * This plugin modifies no user configuration file. Every change lives in the
 * current process's memory and disappears when the process exits.
 *
 * 本插件不修改任何用户配置文件；所有改动都在当前进程内存里，进程退出即消失。
 *
 * @module dsh-system-net
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import Schema from '@deepseek-ai/schemastery';

export const name = 'system-net';

/** Version-independent fallback: common local ports used by proxy software. 常见代理软件的本地端口。 */
const DEFAULT_PROBE_PORTS = [7890, 7897, 10808, 10809, 1080, 2080, 8888, 8080, 26561];

/** Observable state left by the plugin, for self-check and diagnosis. 插件加载后留下的可观测状态。 */
export const state = {
  cert: { installed: false, reason: null, defaultCount: null, systemCount: null, mergedCount: null, extraCount: null },
  proxy: { installed: false, reason: null, mode: null, url: null, source: null, noProxy: null, probed: [] },
  selfCheck: null,
  statusFile: null,
};

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),

  // ---- Proxy 代理 ----
  /**
   * auto   — honour an existing proxy environment; otherwise read the system
   *          proxy, then probe common local ports.
   * manual — use proxyUrl only.
   * off    — never touch the proxy.
   *
   * auto   — 环境里已有代理变量则尊重它；否则读系统代理、再探测常见端口。
   * manual — 只使用 proxyUrl。
   * off    — 不碰代理。
   */
  proxyMode: Schema.union(['auto', 'manual', 'off']).default('auto'),
  /** Proxy URL for manual mode, e.g. http://127.0.0.1:7890. manual 模式使用的代理地址。 */
  proxyUrl: Schema.string().default(''),
  /** Local ports probed in auto mode. auto 模式要探测的本地端口。 */
  probePorts: Schema.array(Schema.number()).default(DEFAULT_PROBE_PORTS),
  /** Per-port probe timeout. 探测时每个端口的超时。 */
  probeTimeoutMs: Schema.number().default(600),
  /**
   * In auto mode, retry at an interval when no proxy was found at startup.
   * This rescues the common ordering "start DSH first, turn on the accelerator later".
   *
   * auto 模式下若首次未检测到代理，则按间隔重试。
   * 用于救"先启动 DSH、之后才打开加速器"这一常见顺序。
   */
  watchProxy: Schema.boolean().default(true),
  /** Retry interval in milliseconds. 重试间隔（毫秒）。 */
  watchIntervalMs: Schema.number().default(10000),
  /** Extra NO_PROXY entries (comma separated). loopback is guaranteed by the official library. 额外追加到 NO_PROXY 的条目；loopback 由官方库自动保证。 */
  noProxy: Schema.string().default(''),

  // ---- Certificates 证书 ----
  /** Merge the operating system certificate store. 并入操作系统证书库。 */
  includeSystem: Schema.boolean().default(true),
  /** Keep Node's bundled Mozilla root set (should stay enabled). 保留 Node 自带的 Mozilla 根证书集合（应当保持开启）。 */
  includeDefault: Schema.boolean().default(true),
  /** Extra PEM files to trust. 额外要信任的 PEM 文件路径。 */
  extraCaFiles: Schema.array(Schema.string()).default([]),

  // ---- Shared 公共 ----
  /**
   * Write the effective state to this JSON file so users and agents can verify it.
   * Empty string means the default: $DSH_HOME/system-net-status.json.
   *
   * 把生效状态写入这个 JSON 文件，便于用户与 agent 核验。
   * 空字符串表示默认位置：$DSH_HOME/system-net-status.json。
   */
  statusFile: Schema.string().default(''),
  /** Perform one real TLS request after loading to verify the whole chain. 加载后做一次真实 TLS 请求，验证整条链路。 */
  selfCheck: Schema.boolean().default(true),
  selfCheckUrl: Schema.string().default('https://api.github.com/rate_limit'),
  selfCheckTimeoutMs: Schema.number().default(15000),
});

// ─────────────────────────────────────────────────────────────
// Certificates 证书
// ─────────────────────────────────────────────────────────────

/** Whether the runtime APIs are available. 运行时 API 是否可用。 */
function caApiAvailable() {
  return typeof tls.getCACertificates === 'function'
    && typeof tls.setDefaultCACertificates === 'function';
}

/** Read the OS certificate store; degrade to "none" on unsupported platforms or versions. 读系统证书库；平台或版本不支持时降级为"没有"。 */
function readSystemCertificates() {
  try {
    const list = tls.getCACertificates('system');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Read Node's bundled default root set. 读 Node 自带的默认根证书集合。 */
function readDefaultCertificates() {
  try {
    const list = tls.getCACertificates('default');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Read extra PEM files; failures are recorded, never thrown.
 * 读取额外的 PEM 文件，失败只记录不抛出。
 *
 * @param {string[]} files File paths. 文件路径。
 * @returns {Promise<{loaded: string[], failed: string[]}>} Result 结果。
 */
async function readExtraCaFiles(files) {
  const loaded = [];
  const failed = [];
  if (!files || files.length === 0) return { loaded, failed };
  for (const file of files) {
    try {
      const text = await fs.promises.readFile(file, 'utf8');
      if (text.includes('BEGIN CERTIFICATE')) loaded.push(text);
      else failed.push(`${file} (未发现 PEM 证书)`);
    } catch (error) {
      failed.push(`${file} (${error.code ?? error.message})`);
    }
  }
  return { loaded, failed };
}

/**
 * Merge the OS certificate store into this process's default TLS trust chain.
 * 把系统证书库并入进程的默认 TLS 信任链。
 *
 * @param {object} config Plugin config. 插件配置。
 * @returns {Promise<{ok: boolean, reason?: string}>} Result 结果。
 */
export async function installTrust(config) {
  const cert = state.cert;
  if (!config.enabled) {
    cert.reason = 'disabled by config';
    return { ok: false, reason: cert.reason };
  }
  if (!caApiAvailable()) {
    cert.reason = `Node ${process.version} 缺少 tls.getCACertificates / tls.setDefaultCACertificates`
      + '（需要 Node 22.19+ 或 24.5+）；请改用 NODE_EXTRA_CA_CERTS 或升级 Node';
    return { ok: false, reason: cert.reason };
  }

  const defaults = config.includeDefault ? readDefaultCertificates() : [];
  const system = config.includeSystem ? readSystemCertificates() : [];

  const { loaded, failed } = await readExtraCaFiles(config.extraCaFiles);

  cert.defaultCount = defaults.length;
  cert.systemCount = system.length;
  cert.extraCount = loaded.length;

  const parts = [...defaults, ...system, ...loaded];
  if (parts.length === 0) {
    cert.reason = 'no certificates collected';
    return { ok: false, reason: cert.reason };
  }

  // Per the official docs this function de-duplicates, so repeat calls are idempotent.
  // 官方文档：该函数会先对证书去重，因此重复调用是幂等的。
  tls.setDefaultCACertificates(parts);
  cert.mergedCount = readDefaultCertificates().length;
  cert.installed = true;
  cert.reason = failed.length ? `部分额外证书读取失败: ${failed.join('; ')}` : null;
  return { ok: true, reason: cert.reason ?? undefined };
}

// ─────────────────────────────────────────────────────────────
// Proxy 代理
// ─────────────────────────────────────────────────────────────

/**
 * Read Windows' Internet Settings and decide which mode the accelerator uses.
 *
 * This doubles as **condition detection**: the plugin only applies to
 * "system proxy" mode, so PAC and "nothing configured" must be told apart to
 * produce an accurate message instead of failing silently.
 *
 * 读 Windows 的 Internet Settings，判定加速器用的是哪种模式。
 * 这一步同时承担条件检测：本插件只适用于「系统代理」模式，因此必须把 PAC 和
 * "什么都没设"区分出来，好给出准确提醒，而不是静默失败。
 *
 * @returns {Promise<{mode: 'system-proxy'|'pac'|'none', server: string|null,
 *   override: string, pacUrl: string|null}>} Detection result; non-Windows is always `none`.
 *   判定结果（非 Windows 一律 none）。
 */
async function readWindowsSystemProxy() {
  const none = { mode: 'none', server: null, override: '', pacUrl: null };
  if (process.platform !== 'win32') return none;

  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const query = (name) => new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', name], { windowsHide: true, timeout: 4000 }, (error, stdout) => {
      if (error) return resolve(null);
      const match = /REG_\w+\s+(.+?)\s*$/m.exec(stdout);
      return resolve(match ? match[1].trim() : null);
    });
  });

  const [enabled, server, override, pacUrl] = await Promise.all([
    query('ProxyEnable'), query('ProxyServer'), query('ProxyOverride'), query('AutoConfigURL'),
  ]);

  if ((enabled === '0x1' || enabled === '1') && server) {
    return { mode: 'system-proxy', server, override: override ?? '', pacUrl: pacUrl ?? null };
  }
  // No static proxy but a PAC is set: this plugin does not parse PAC, and the user must be told.
  // 没有静态代理但有 PAC：本插件不解析 PAC，必须让用户知道。
  if (pacUrl) return { mode: 'pac', server: null, override: '', pacUrl };
  return none;
}

/**
 * Windows' ProxyServer allows `http=host:port;https=host:port`. Take the
 * http/https entry and add a scheme.
 *
 * Windows 的 ProxyServer 允许多协议写法，这里只取 http/https 那一项并补上 scheme。
 *
 * @param {string} server Raw registry value. 注册表里的原始值。
 * @returns {string|null} An address like http://127.0.0.1:7890. 形如 http://127.0.0.1:7890 的地址。
 */
export function normalizeProxyServer(server) {
  if (!server) return null;
  const text = String(server).trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (!text.includes('=')) return `http://${text}`;
  const entries = new Map();
  for (const part of text.split(';')) {
    const [scheme, value] = part.split('=');
    if (scheme && value) entries.set(scheme.trim().toLowerCase(), value.trim());
  }
  const picked = entries.get('https') ?? entries.get('http');
  return picked ? `http://${picked}` : null;
}

/**
 * Turn Windows' ProxyOverride into NO_PROXY entries.
 *
 * The registry uses `;` and often contains forms this library cannot faithfully
 * translate:
 *  - `<local>`    — Windows' "local addresses"; loopback is guaranteed by the official library anyway
 *  - `10.*` etc.  — Windows prefix wildcards; the official matcher only does suffix matching, so these become inert
 *  - `10.0.0.0/8` — CIDR, explicitly not matched
 *  - `*`          — **must be dropped**: the official matcher reads a bare `*` as "bypass everything", which would disable the proxy entirely
 *
 * Only faithfully translatable entries are kept: plain hostnames, domains and `host:port`.
 *
 * 把 Windows 的 ProxyOverride 转成 NO_PROXY 条目。注册表用 `;` 分隔，且常含本库
 * 无法忠实翻译的写法（见上）。因此只保留普通主机名 / 域名 / host:port。
 *
 * @param {string} override Raw registry value. 注册表原始值。
 * @returns {string[]} Entries that are safe to use. 可安全使用的条目。
 */
export function normalizeProxyOverride(override) {
  if (!override) return [];
  return String(override)
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry || entry === '<local>' || entry.includes('/') || entry.includes('=')) return false;
      // A bare `*` is read as "bypass everything" by the official matcher and must be dropped.
      // 裸 `*` 会被官方匹配器读作"全部放行"，必须丢弃。
      if (entry === '*') return false;
      // A leading `*.` is officially supported (the matcher strips `^\*?\.`); other `*` cannot be translated.
      // 前导 `*.` 是官方支持的写法（匹配器会剥掉 `^\*?\.`）；其余位置的 `*` 无法翻译。
      const rest = entry.startsWith('*.') ? entry.slice(2) : entry;
      return !rest.includes('*');
    });
}

/**
 * Probe which local ports have a proxy listening.
 * 探测本机哪些端口有代理在监听。
 *
 * @param {number[]} ports Candidate ports. 候选端口。
 * @param {number} timeoutMs Per-port timeout. 每个端口的超时。
 * @returns {Promise<number[]>} Ports that answered. 有响应的端口。
 */
export async function probeLocalProxyPorts(ports, timeoutMs) {
  const results = await Promise.all((ports ?? []).map((port) => new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (alive) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive ? port : null);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  })));
  return results.filter((port) => port !== null);
}

/**
 * Let the official resolver read a plain object.
 * 让官方库的解析器读到一个普通对象。
 *
 * @param {Record<string, string|undefined>} values Variable table. 变量表。
 * @returns {{get: (name: string) => {value: string}|undefined}} EnvLookup
 */
function makeEnvLookup(values) {
  return {
    get(name) {
      const value = values[name];
      return value === undefined || value === '' ? undefined : { value };
    },
  };
}

/** Whether a usable proxy config already exists in the environment (launcher or user handled it). 环境里是否已经有可用的代理配置。 */
function inheritedProxyEnv() {
  const read = (name) => process.env[name] ?? process.env[name.toUpperCase()];
  const http = read('http_proxy');
  const https = read('https_proxy');
  const all = process.env.ALL_PROXY ?? process.env.all_proxy;
  return { http, https, all, present: Boolean(http || https || all) };
}

/**
 * Decide which proxy to use, and where it came from.
 * 决定要用哪个代理，以及它的来源。
 *
 * @param {object} config Plugin config. 插件配置。
 * @returns {Promise<{url: string|null, source: string|null, noProxy: string, probed: number[]}>} Decision 决策。
 */
export async function resolveProxy(config) {
  const base = { url: null, source: null, noProxy: config.noProxy ?? '', probed: [] };

  if (config.proxyMode === 'off') return { ...base, source: 'off' };

  if (config.proxyMode === 'manual') {
    return config.proxyUrl
      ? { ...base, url: config.proxyUrl, source: 'manual' }
      : { ...base, source: 'manual(未填地址)' };
  }

  // auto: respect an existing configuration rather than fighting it.
  // auto：环境里已经配好就尊重现状，不抢。
  const inherited = inheritedProxyEnv();
  if (inherited.present) {
    return { ...base, url: inherited.https ?? inherited.http ?? inherited.all, source: 'environment' };
  }

  // 1) System proxy — the only **reliable** detection, and the plugin's condition of use.
  // 1) 系统代理设置 —— 本插件唯一可靠的检测方式，也是适用条件。
  const system = await readWindowsSystemProxy();
  if (system.mode === 'pac') {
    return { ...base, source: 'pac-unsupported', pacUrl: system.pacUrl };
  }
  if (system.mode === 'system-proxy') {
    const url = normalizeProxyServer(system.server);
    if (url) {
      const extra = normalizeProxyOverride(system.override);
      const noProxy = [config.noProxy, ...extra].filter(Boolean).join(',');
      return { url, source: 'system-proxy', noProxy, probed: [] };
    }
    return { ...base, source: 'unparsable', rawServer: system.server };
  }

  // 2) Fallback: probe common local ports. A hit proves some proxy software is
  //    listening, but it never wrote a system proxy — so we cannot confirm it is
  //    an HTTP proxy, nor obtain its bypass list.
  // 2) 兜底：探测常见本地端口。命中说明有代理软件在监听，但它没写系统代理，
  //    因此无法确认它是不是 HTTP 代理，也拿不到它的绕过名单。
  const probed = await probeLocalProxyPorts(config.probePorts, config.probeTimeoutMs);
  if (probed.length > 0) {
    return { url: `http://127.0.0.1:${probed[0]}`, source: 'port-probe', noProxy: config.noProxy ?? '', probed };
  }

  return { ...base, source: 'not-found' };
}

/**
 * Turn "no proxy found" into a message the user can act on.
 *
 * The plugin only applies to **system-proxy-mode** accelerators, and the most
 * common failure causes are: the accelerator is off, it runs in hosts/TUN mode,
 * or DSH was started before the accelerator.
 *
 * 把"没找到代理"翻译成用户能照做的提醒。本插件只适用于系统代理模式的加速器，
 * 而最常见的失败原因是：加速器没开、用的是 hosts/TUN 模式，或先开了 DSH。
 *
 * @param {{source: string, pacUrl?: string|null, rawServer?: string}} decision Decision 决策结果。
 * @returns {string} A user-facing message. 面向用户的提醒。
 */
export function explainProxyFailure(decision) {
  switch (decision.source) {
    case 'pac-unsupported':
      return `检测到 PAC 自动配置（${decision.pacUrl}），本插件不解析 PAC，无法自动配置代理。`
        + '请在加速器里改用「系统代理」模式，或手工设置 http_proxy/https_proxy 环境变量。';
    case 'unparsable':
      return `系统代理已开启但地址无法解析（原始值：${decision.rawServer}）。`
        + '请检查加速器的代理设置，或用 proxyMode: manual 手工指定。';
    case 'manual(未填地址)':
      return 'proxyMode 为 manual 但 proxyUrl 为空；请填写代理地址（例如 http://127.0.0.1:7890）。';
    case 'not-found':
      return '未检测到系统代理。请依次确认：'
        + '① 加速器**已经启动**（本插件在 DSH 启动时检测，加速器要先开好）；'
        + '② 加速器使用的是「**系统代理**」模式，而不是 hosts / DNS / TUN 模式——'
        + '后几种不会写 Windows 系统代理设置，本插件读不到；'
        + '③ 若确实用的是其他模式，请用 proxyMode: manual 手工指定代理地址。';
    default:
      return `代理未装配（${decision.source ?? 'unknown'}）。`;
  }
}

let proxyDisposer = null;

/**
 * Install the proxy at runtime through the official entry point, so the global
 * dispatcher and proxyRouteFor() both take effect.
 *
 * 通过官方入口在运行时装配代理，使全局 dispatcher 与 proxyRouteFor() 同时生效。
 *
 * @param {object} config Plugin config. 插件配置。
 * @returns {Promise<{ok: boolean, reason?: string}>} Result 结果。
 */
export async function installProxy(config) {
  const proxy = state.proxy;
  if (!config.enabled) {
    proxy.reason = 'disabled by config';
    return { ok: false, reason: proxy.reason };
  }

  const decision = await resolveProxy(config);
  proxy.mode = config.proxyMode;
  proxy.source = decision.source;
  proxy.probed = decision.probed;
  proxy.noProxy = decision.noProxy || null;

  if (config.proxyMode === 'off') {
    proxy.reason = 'proxyMode=off';
    return { ok: false, reason: proxy.reason };
  }
  if (!decision.url) {
    proxy.reason = decision.source === 'environment'
      ? '环境里已有代理配置，交由启动器处理'
      : explainProxyFailure(decision);
    return { ok: false, reason: proxy.reason };
  }

  // When the environment already carries a proxy, the official launcher has
  // installed the policy; do not install a second one.
  // 环境里已经有代理时，官方启动器已经装好了策略；不重复安装。
  if (decision.source === 'environment') {
    proxy.url = decision.url;
    proxy.installed = true;
    proxy.reason = '由启动环境提供，本插件未介入';
    return { ok: true, reason: proxy.reason };
  }

  let mod;
  try {
    mod = await import('@deepseek-ai/dsh-http-proxy');
  } catch (error) {
    proxy.reason = `无法加载 @deepseek-ai/dsh-http-proxy（${error.code ?? error.message}）`;
    return { ok: false, reason: proxy.reason };
  }
  // Older DSH versions may not expose this runtime entry point.
  // The certificate half is independent and unaffected.
  // 老版本 DSH 可能没有这个运行时入口。证书部分与此无关，不受影响。
  if (typeof mod.installProxyFromEnvironment !== 'function') {
    proxy.reason = '当前 DSH 的 @deepseek-ai/dsh-http-proxy 未导出 installProxyFromEnvironment'
      + '（本插件需要 DSH >= 0.2.0-rc.2）；证书部分不受影响。';
    return { ok: false, reason: proxy.reason };
  }

  try {
    const values = {
      http_proxy: decision.url,
      https_proxy: decision.url,
      ...(decision.noProxy ? { no_proxy: decision.noProxy } : {}),
    };
    const diagnostics = [];
    proxyDisposer = await mod.installProxyFromEnvironment(makeEnvLookup(values), (message) => {
      diagnostics.push(message);
    });
    proxy.url = decision.url;
    proxy.installed = true;
    proxy.reason = diagnostics.length ? diagnostics.join('; ') : null;
    return { ok: true, reason: proxy.reason ?? undefined };
  } catch (error) {
    proxy.reason = `装配失败：${error.message}`;
    return { ok: false, reason: proxy.reason };
  }
}

// ─────────────────────────────────────────────────────────────
// Shared 公共
// ─────────────────────────────────────────────────────────────

/**
 * Perform one real request after loading, to verify the whole chain.
 * 加载后做一次真实请求，验证整条链路。
 *
 * @param {object} config Plugin config. 插件配置。
 * @returns {Promise<object>} Self-check result. 自检结果。
 */
export async function runSelfCheck(config) {
  const url = config.selfCheckUrl;
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(config.selfCheckTimeoutMs) });
    state.selfCheck = { ok: response.ok, status: response.status, ms: Date.now() - started, url };
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? error?.name ?? 'unknown';
    state.selfCheck = {
      ok: false,
      error: String(code),
      ms: Date.now() - started,
      url,
      // Key clarification: the most common cause of a failed self-check is that
      // the URL is simply outside the accelerator's coverage — the proxy itself
      // may well be installed. Without saying so, users assume the plugin broke.
      //
      // 关键澄清：自检失败最常见的原因是"这个地址本来就不在你加速器的覆盖范围内"，
      // 而代理本身可能已经装配成功。不写清楚，用户会以为插件坏了。
      hint: '自检失败不代表插件失效。请先看上面的 proxy.installed 与 proxy.source：'
        + '若已装配，说明代理已生效，只是这个自检地址不在你加速器的覆盖范围内。'
        + '可把 selfCheckUrl 换成你确定被覆盖的地址，或设 selfCheck: false。',
    };
  }
  return state.selfCheck;
}

/**
 * Resolve the status file path.
 * 解析状态文件路径。
 *
 * @param {object} config Plugin config. 插件配置。
 * @returns {string} Absolute path. 绝对路径。
 */
export function statusFilePath(config) {
  if (config.statusFile) return config.statusFile;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'system-net-status.json');
}

/**
 * Persist the current state. A write failure is not a plugin failure — it only
 * means one fewer piece of evidence.
 *
 * 把当前状态落盘。写失败不算插件失败，只是少一份凭据。
 *
 * @param {object} config Plugin config. 插件配置。
 * @returns {string|null} The path actually written, or null. 实际写入的路径，失败为 null。
 */
export function writeStatus(config) {
  try {
    const file = statusFilePath(config);
    // Record the path before serialising, otherwise the written copy always has statusFile: null.
    // 先记录路径再序列化，否则落盘的那一份里 statusFile 永远是 null。
    state.statusFile = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      plugin: 'dsh-system-net',
      at: new Date().toISOString(),
      node: process.version,
      pid: process.pid,
      platform: process.platform,
      ...state,
    }, null, 2)}\n`, 'utf8');
    return file;
  } catch {
    return null;
  }
}

/**
 * Plugin entry point: takes effect on load.
 * 插件入口：加载即生效。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis context. Cordis 上下文。
 * @param {object} config Plugin config. 插件配置。
 */
export function apply(ctx, config) {
  const log = (level, message) => ctx.logger?.[level]?.(`[system-net] ${message}`);
  let watchTimer = null;

  // Clean up on unload: restore the proxy policy and stop the retry timer.
  // (Certificates need no restore: they live only in this process's memory.)
  // 卸载时收尾：还原代理策略、停掉重试计时器。
  // （证书无需还原：它只存在于本进程内存里，进程退出即消失。）
  ctx.effect?.(() => () => {
    if (watchTimer !== null) clearInterval(watchTimer);
    watchTimer = null;
    void proxyDisposer?.();
    proxyDisposer = null;
  });

  void (async () => {
    // Install the proxy first: the certificate self-check goes through it, and
    // the reverse order would produce a false negative.
    // 代理先装：证书自检要走代理，顺序反了会误报。
    const proxyResult = await installProxy(config);
    if (proxyResult.ok) {
      const { url, source } = state.proxy;
      log('info', `代理已装配：${url}（来源 ${source}）`);
      if (state.proxy.reason) log('warn', state.proxy.reason);
    } else {
      log('warn', `代理未装配：${proxyResult.reason}`);
      // Common case: DSH was started first and the accelerator turned on later,
      // so no system proxy was readable at startup. Retry on an interval until
      // it installs, then stop.
      // 常见情形：先启动了 DSH，之后才打开加速器——启动时读不到系统代理。
      // 因此在未装配成功时按间隔重试，装配成功即停。
      if (config.proxyMode === 'auto' && config.watchProxy) {
        watchTimer = setInterval(() => {
          void (async () => {
            const retry = await installProxy(config);
            if (!retry.ok) return;
            clearInterval(watchTimer);
            watchTimer = null;
            log('info', `代理已装配（检测到系统代理后自动补上）：${state.proxy.url}`);
            state.statusFile = writeStatus(config);
          })();
        }, config.watchIntervalMs);
        watchTimer.unref?.();
      }
    }

    const certResult = await installTrust(config);
    if (certResult.ok) {
      const { systemCount, defaultCount, extraCount, mergedCount } = state.cert;
      log('info', `已信任系统证书库：+${systemCount} 系统 / ${defaultCount} 内置 / ${extraCount} 额外 → 共 ${mergedCount} 张`);
      if (state.cert.reason) log('warn', state.cert.reason);
    } else {
      log('warn', `证书未生效：${certResult.reason}`);
    }

    if (config.selfCheck) {
      const check = await runSelfCheck(config);
      if (check.ok) log('info', `自检通过：${check.url} → HTTP ${check.status} (${check.ms}ms)`);
      else {
        log('warn', `自检未通过：${check.url} → ${check.error ?? `HTTP ${check.status}`} (${check.ms}ms)`
          + '；这不代表插件失效——请先看状态文件里的 proxy.installed 与 proxy.source');
      }
    }

    state.statusFile = writeStatus(config);
  })();
}
