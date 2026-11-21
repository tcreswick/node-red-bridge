'use strict';
// Integration test: two real Node-RED runtimes (installed into a temp dir) on different ports.
// Pairs them, passes msgs both ways, checks ACL, call/reply, status events, drop + reconnect, unpair.
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const assert = require('assert');

const PKG = path.resolve(__dirname, '..');
const BASE = process.env.BRIDGE_IT_DIR || path.join(os.tmpdir(), 'nr-bridge-it');
const PA = 18801, PB = 18802, SINK = 18899;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ensureNodeRed() {
  if (fs.existsSync(path.join(BASE, 'node_modules', 'node-red', 'red.js'))) return;
  fs.mkdirSync(BASE, { recursive: true });
  console.log('installing node-red into', BASE);
  execSync('npm init -y >/dev/null && npm i node-red --no-audit --no-fund --loglevel=error', { cwd: BASE, stdio: 'inherit' });
}

const fn = (id, func, wires) => ({ id, type: 'function', func, outputs: 1, wires: [wires], x: 0, y: 0 });
function flows(side) {
  const A = side === 'A', cfg = 'cfg' + side, other = A ? 'B' : 'A', S = 'http://127.0.0.1:' + SINK;
  const f = [
    { id: 'tab' + side, type: 'tab', label: side },
    { id: cfg, type: 'bridge-remote', name: 'remote' + other, role: A ? 'listen' : 'connect', url: '', path: '/bridge/ws',
      publicUrl: `ws://127.0.0.1:${PA}/bridge/ws`, pingInterval: 0.3, pingTimeout: 1, backoffMin: 0.2, backoffMax: 1, maxSize: 1, shareAll: false },
    // receiving side
    { id: 'in' + side, type: 'bridge-in', z: 'tab' + side, name: 'in' + side, remotes: [cfg], wires: [['rx' + side]], x: 0, y: 0 },
    { id: 'secret' + side, type: 'bridge-in', z: 'tab' + side, name: 'secret' + side, remotes: [], wires: [['rx' + side]], x: 0, y: 0 },
    fn('rx' + side, "msg.payload={payload:msg.payload,bridge:msg._bridge}; msg.url='" + S + "/rx" + side + "'; msg.method='POST'; return msg;", ['post' + side]),
    { id: 'post' + side, type: 'http request', z: 'tab' + side, method: 'use', ret: 'txt', url: '', wires: [[]], x: 0, y: 0 },
    // send via HTTP: {target, payload}
    { id: 'http' + side, type: 'http in', z: 'tab' + side, url: '/send', method: 'post', wires: [['prep' + side]], x: 0, y: 0 },
    fn('prep' + side, "msg.bridgeTarget=msg.payload.target; msg.payload=msg.payload.payload; return msg;", ['out' + side, 'resp' + side]),
    { id: 'out' + side, type: 'bridge-out', z: 'tab' + side, name: 'out' + side, remote: cfg, target: 'x', remotes: [cfg], offline: 'error', wires: [], x: 0, y: 0 },
    { id: 'resp' + side, type: 'http response', z: 'tab' + side, statusCode: '202', wires: [], x: 0, y: 0 },
    { id: 'catch' + side, type: 'catch', z: 'tab' + side, scope: null, wires: [['err' + side]], x: 0, y: 0 },
    fn('err' + side, "msg.payload={error:msg.error.message}; msg.url='" + S + "/err" + side + "'; msg.method='POST'; return msg;", ['post' + side]),
    { id: 'st' + side, type: 'bridge-status', z: 'tab' + side, remote: '_all', emitOnDeploy: false, wires: [['stf' + side]], x: 0, y: 0 },
    fn('stf' + side, "msg.payload={payload:msg.payload,remote:msg.remote,reason:msg.reason}; msg.url='" + S + "/st" + side + "'; msg.method='POST'; return msg;", ['post' + side])
  ];
  if (A) { // echo service for call/reply
    f.push({ id: 'echoIn', type: 'bridge-in', z: 'tabA', name: 'echoA', remotes: [cfg], wires: [['echoFn']], x: 0, y: 0 },
      fn('echoFn', "msg.payload='echo:'+msg.payload; return msg;", ['echoRep']),
      { id: 'echoRep', type: 'bridge-reply', z: 'tabA', wires: [], x: 0, y: 0 });
  } else {
    f.push({ id: 'callHttp', type: 'http in', z: 'tabB', url: '/call', method: 'post', wires: [['callN']], x: 0, y: 0 },
      { id: 'callN', type: 'bridge-call', z: 'tabB', name: 'callN', remote: cfg, target: 'echoA', remotes: [cfg], timeout: 3, wires: [['callResp']], x: 0, y: 0 },
      { id: 'callResp', type: 'http response', z: 'tabB', statusCode: '200', wires: [], x: 0, y: 0 });
  }
  f.forEach(n => { if (n.type !== 'tab' && n.type !== 'bridge-remote' && !n.z) n.z = 'tab' + side; });
  return f;
}

class Instance {
  constructor(side, port) { this.side = side; this.port = port; this.ud = path.join(BASE, 'ud' + side); this.log = ''; }
  prepare() {
    fs.rmSync(this.ud, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.ud, 'node_modules', '@tcreswick'), { recursive: true });
    fs.symlinkSync(PKG, path.join(this.ud, 'node_modules', '@tcreswick', 'node-red-bridge'), 'dir');
    fs.writeFileSync(path.join(this.ud, 'package.json'), JSON.stringify({ name: 'ud' + this.side, version: '1.0.0', dependencies: { '@tcreswick/node-red-bridge': '*' } }));
    fs.writeFileSync(path.join(this.ud, 'flows.json'), JSON.stringify(flows(this.side)));
    fs.writeFileSync(path.join(this.ud, 'settings.js'), `module.exports={uiPort:${this.port},flowFile:'flows.json',credentialSecret:false,logging:{console:{level:'info'}}}`);
  }
  async start() {
    this.p = spawn('node', [path.join(BASE, 'node_modules', 'node-red', 'red.js'), '-u', this.ud, '-p', this.port], { cwd: BASE });
    const onData = d => { this.log += d; };
    this.p.stdout.on('data', onData); this.p.stderr.on('data', onData);
    for (let i = 0; i < 100; i++) { if (/Started flows/.test(this.log)) return; await sleep(200); }
    throw new Error('node-red ' + this.side + ' did not start:\n' + this.log);
  }
  kill(sig = 'SIGKILL') { return new Promise(r => { if (!this.p || this.p.exitCode !== null) return r(); this.p.once('exit', r); this.p.kill(sig); }); }
  url(p) { return `http://127.0.0.1:${this.port}${p}`; }
  async api(method, p, body) {
    const r = await fetch(this.url(p), { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, body: j };
  }
  state(id) { return this.api('GET', `/bridge/${id}/state`).then(r => r.body); }
}

async function until(fn, what, ms = 10000) {
  const t = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timeout waiting for ' + what);
    await sleep(100);
  }
}

(async () => {
  ensureNodeRed();
  const got = { rxA: [], rxB: [], errA: [], errB: [], stA: [], stB: [] };
  const sink = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => { try { got[req.url.slice(1)].push(JSON.parse(b)); } catch (e) { /* ignore */ } res.end('ok'); });
  }).listen(SINK, '127.0.0.1');
  const A = new Instance('A', PA), B = new Instance('B', PB);
  let ok = false;
  try {
    A.prepare(); B.prepare();
    await A.start(); await B.start();
    assert(!/Error|Failed to load/i.test(A.log.replace(/Started flows/, '')) || console.log(A.log));
    console.log('both runtimes started');

    // --- pairing ---
    assert.equal((await A.state('cfgA')).state, 'waiting');
    const code = (await A.api('POST', '/bridge/cfgA/code', {})).body.code;
    assert(code, 'pairing code created');
    const pr = await B.api('POST', '/bridge/cfgB/pair', { code });
    assert.equal(pr.status, 200, JSON.stringify(pr.body));
    await until(async () => (await A.state('cfgA')).state === 'online' && (await B.state('cfgB')).state === 'online', 'both online');
    console.log('paired + online');
    const second = await B.api('POST', '/bridge/cfgB/pair', { code });
    assert.equal(second.status, 400, 'pairing code is single use');
    assert(['online'].includes((await B.state('cfgB')).state), 'failed re-pair must not break the link');

    // --- discovery + ACL ---
    const sb = await until(async () => { const s = await B.state('cfgB'); return s.ins.length ? s : null; }, 'discovery');
    assert.deepEqual(sb.ins, ['echoA', 'inA']); // secretA not advertised
    const sa = await until(async () => { const s = await A.state('cfgA'); return s.ins.length ? s : null; }, 'discovery A');
    assert.deepEqual(sa.ins, ['inB']);
    assert.equal(sa.peerFingerprint, (await B.state('cfgB')).localFingerprint);
    console.log('discovery ok:', sb.ins.join(','), '|', sa.ins.join(','));

    // --- messages both ways ---
    await B.api('POST', '/send', { target: 'inA', payload: 'hello A' });
    await until(() => got.rxA.length, 'msg B->A');
    assert.equal(got.rxA[0].payload, 'hello A'); assert.equal(got.rxA[0].bridge.from, 'outB'); assert.equal(got.rxA[0].bridge.remote, 'remoteB');
    await A.api('POST', '/send', { target: 'inB', payload: { n: 42 } });
    await until(() => got.rxB.length, 'msg A->B');
    assert.deepEqual(got.rxB[0].payload, { n: 42 });
    console.log('messages flow both ways');

    // --- invisible / unknown target -> error to Catch ---
    await B.api('POST', '/send', { target: 'secretA', payload: 'x' });
    await until(() => got.errB.length, 'ACL error');
    assert.match(got.errB[0].error, /no bridge-in named "secretA"/);
    assert.equal(got.rxA.length, 1, 'hidden node must not receive');

    // --- call / reply ---
    const cr = await B.api('POST', '/call', 'ping'.length ? { x: 1 } : {}); // payload object
    assert.equal(cr.status, 200); assert.equal(cr.body, 'echo:[object Object]');
    console.log('call/reply ok');

    // --- drop + reconnect ---
    got.stB.length = 0;
    await A.kill('SIGKILL');
    await until(async () => (await B.state('cfgB')).state !== 'online', 'B notices drop');
    await until(() => got.stB.some(s => s.payload === 'offline'), 'offline status event');
    got.errB.length = 0;
    await B.api('POST', '/send', { target: 'inA', payload: 'while down' });
    await until(() => got.errB.length, 'offline error');
    assert.match(got.errB[0].error, /bridge link.*(offline|connecting|auth)/);
    await A.start();
    await until(async () => (await B.state('cfgB')).state === 'online' && (await A.state('cfgA')).state === 'online', 'reconnect after restart', 15000);
    assert(got.stB.some(s => s.payload === 'online'));
    got.rxA.length = 0;
    await B.api('POST', '/send', { target: 'inA', payload: 'after reconnect' });
    await until(() => got.rxA.length, 'msg after reconnect');
    assert.equal(got.rxA[0].payload, 'after reconnect');
    console.log('drop + reconnect ok (no re-pairing needed)');

    // --- B restart: URL is remembered from pairing ---
    await B.kill('SIGKILL'); B.log = ''; await B.start();
    await until(async () => (await B.state('cfgB')).state === 'online', 'B reconnect after own restart', 15000);
    console.log('connect side restart ok');

    // --- unpair ---
    const up = await A.api('POST', '/bridge/cfgA/unpair');
    assert.equal(up.status, 200);
    await until(async () => (await B.state('cfgB')).state === 'unpaired', 'B sees unpair');
    assert.equal((await A.state('cfgA')).paired, false);
    console.log('unpair ok');
    ok = true;
  } catch (e) {
    console.error('FAILED:', e.stack || e);
    console.error('--- A log ---\n' + A.log.slice(-3000) + '\n--- B log ---\n' + B.log.slice(-3000));
  } finally {
    await A.kill(); await B.kill(); sink.close();
  }
  console.log(ok ? 'INTEGRATION PASSED' : 'INTEGRATION FAILED');
  process.exit(ok ? 0 : 1);
})();
