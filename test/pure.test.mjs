/**
 * dsh-system-net — pure-function unit tests.
 *
 * These cover only what needs no network and no DSH instance. The focus is the
 * **failure-path messages** and the **Windows registry value parsing edges**,
 * because those are the two places most likely to misbehave on a real machine.
 *
 * dsh-system-net 纯函数单元测试。只测试不需要网络、不需要 DSH 实例的部分——
 * 重点是失败路径的提醒文案，以及 Windows 注册表值的解析边界，
 * 因为这两处最容易在真实机器上出问题。
 *
 * Run 运行: node test/pure.test.mjs
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '..', 'index.js')).href);

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ── normalizeProxyServer ───────────────────────────────────────
test('裸 host:port 会补上 http:// / bare host:port gains http://', () => {
  assert.equal(mod.normalizeProxyServer('127.0.0.1:26561'), 'http://127.0.0.1:26561');
});

test('已带 scheme 的原样返回 / an existing scheme is preserved', () => {
  assert.equal(mod.normalizeProxyServer('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
});

test('多协议写法优先取 https / multi-protocol form prefers https', () => {
  assert.equal(
    mod.normalizeProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891'),
    'http://127.0.0.1:7891',
  );
});

test('只有 https 项时也能取到 / an https-only entry still resolves', () => {
  assert.equal(mod.normalizeProxyServer('https=10.0.0.1:443'), 'http://10.0.0.1:443');
});

test('没有 http/https 项时返回 null（不瞎猜）/ no http/https entry yields null (never guess)', () => {
  assert.equal(mod.normalizeProxyServer('ftp=1.2.3.4:21'), null);
  assert.equal(mod.normalizeProxyServer(''), null);
  assert.equal(mod.normalizeProxyServer(null), null);
});

// ── normalizeProxyOverride ─────────────────────────────────────
test('裸 * 必须被丢掉（否则代理会整体失效）/ a bare * must be dropped (it would disable the proxy)', () => {
  assert.deepEqual(mod.normalizeProxyOverride('*'), []);
  assert.deepEqual(mod.normalizeProxyOverride('localhost;*;internal.corp'), ['localhost', 'internal.corp']);
});

test('<local> 与 CIDR 被丢弃，普通主机名保留 / <local> and CIDR dropped, plain hostnames kept', () => {
  assert.deepEqual(
    mod.normalizeProxyOverride('localhost;127.*;10.*;172.16.*;192.168.*;<local>'),
    ['localhost'],
  );
  assert.deepEqual(
    mod.normalizeProxyOverride('internal.corp;10.0.0.0/8'),
    ['internal.corp'],
  );
});

test('前导 *. 是官方支持的写法，必须保留 / a leading *. is officially supported and must be kept', () => {
  assert.deepEqual(
    mod.normalizeProxyOverride('internal.corp;*.example.com;10.0.0.0/8'),
    ['internal.corp', '*.example.com'],
  );
});

test('任何结果里都不能出现裸 * / no result may contain a bare *', () => {
  const inputs = ['*', 'a;*;b', '*.x.com;*', '10.*'];
  for (const input of inputs) {
    for (const entry of mod.normalizeProxyOverride(input)) {
      const rest = entry.startsWith('*.') ? entry.slice(2) : entry;
      assert.ok(!rest.includes('*'), `${input} -> ${entry}`);
    }
  }
});

test('真实机器上的样例能安全解析 / a real-machine sample parses safely', () => {
  assert.deepEqual(
    mod.normalizeProxyOverride('api.steampp.net;shop.api.steampp.net'),
    ['api.steampp.net', 'shop.api.steampp.net'],
  );
});

// ── explainProxyFailure: 条件不满足时必须说人话 / must speak plainly ──
test('not-found 的提醒要逐条给出可操作项 / not-found must list actionable steps', () => {
  const msg = mod.explainProxyFailure({ source: 'not-found' });
  assert.match(msg, /系统代理/);
  assert.match(msg, /已经启动|先开/);
  assert.match(msg, /manual/);
});

test('PAC 被识别为不支持并说明出路 / PAC is reported as unsupported with a way out', () => {
  const msg = mod.explainProxyFailure({ source: 'pac-unsupported', pacUrl: 'http://pac/x.pac' });
  assert.match(msg, /PAC/);
  assert.match(msg, /http:\/\/pac\/x\.pac/);
  assert.match(msg, /系统代理/);
});

test('地址无法解析时带出原始值 / an unparsable address is echoed back', () => {
  const msg = mod.explainProxyFailure({ source: 'unparsable', rawServer: 'http=::bad' });
  assert.match(msg, /http=::bad/);
});

test('manual 模式没填地址会被指出 / manual mode with an empty URL is called out', () => {
  assert.match(mod.explainProxyFailure({ source: 'manual(未填地址)' }), /proxyUrl/);
});

test('未知来源也有兜底文案，不会抛错 / an unknown source still yields text and never throws', () => {
  assert.equal(typeof mod.explainProxyFailure({ source: 'wat' }), 'string');
  assert.equal(typeof mod.explainProxyFailure({}), 'string');
});

// ── 端口探测 / port probing ─────────────────────────────────────
test('探测函数在无人监听时返回空数组而不是抛错 / returns [] instead of throwing when nothing listens', async () => {
  const result = await mod.probeLocalProxyPorts([1], 300);
  assert.deepEqual(result, []);
});

test('探测函数能接受空列表 / accepts an empty port list', async () => {
  assert.deepEqual(await mod.probeLocalProxyPorts([], 100), []);
});

// ── 配置 schema / config schema ─────────────────────────────────
test('配置默认值符合文档 / config defaults match the documented values', () => {
  const c = mod.Config({});
  assert.equal(c.proxyMode, 'auto');
  assert.equal(c.watchProxy, true);
  assert.equal(c.watchIntervalMs, 10000);
  assert.equal(c.includeSystem, true);
  assert.equal(c.includeDefault, true);
  assert.equal(c.selfCheck, true);
});

test('非法 proxyMode 会被 schema 拒绝 / an invalid proxyMode is rejected by the schema', () => {
  assert.throws(() => mod.Config({ proxyMode: 'whatever' }));
});

// ── 运行 / run ─────────────────────────────────────────────────
let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message.split('\n')[0]}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
