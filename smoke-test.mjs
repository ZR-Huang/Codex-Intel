// Exercise native modules and start the Intel GUI against temporary UI settings.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(process.argv[2] || path.join(here, 'dist/Codex Intel.app'));
const out = path.join(here, 'dist');
fs.mkdirSync(out, { recursive: true });
const resources = path.join(app, 'Contents/Resources');
const executable = path.join(app, 'Contents/MacOS/Codex Intel');
const report = { app, startedAt: new Date().toISOString() };
const nativeScript = `
const assert = require('node:assert/strict');
const base = ${JSON.stringify(resources)};
const Database = require(base + '/app.asar/node_modules/better-sqlite3');
const db = new Database(':memory:');
assert.equal(db.prepare('SELECT 6 * 7 AS answer').get().answer, 42);
db.close();
let objc = 'not included';
if (require('node:fs').existsSync(base + '/app.asar/node_modules/objc-js/package.json')) {
  const bridge = require(base + '/app.asar/node_modules/objc-js');
  assert.ok(Object.keys(bridge).length > 0);
  objc = 'loaded';
}
const pty = require(base + '/app.asar/node_modules/node-pty');
const terminal = pty.spawn('/bin/zsh', ['-c', 'printf CODEX_INTEL_PTY_OK'], {
  cwd: require('node:os').tmpdir(), env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
});
let text = '';
terminal.onData(value => text += value);
const timeout = setTimeout(() => { terminal.kill(); process.exit(2); }, 10000);
terminal.onExit(event => {
  clearTimeout(timeout);
  assert.equal(event.exitCode, 0);
  assert.ok(text.includes('CODEX_INTEL_PTY_OK'));
  console.log(JSON.stringify({ sqlite: 'passed', terminal: 'passed', objc, arch: process.arch, electron: process.versions.electron }));
});
`;
const native = spawnSync(executable, ['-e', nativeScript], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000,
});
if (native.status !== 0) throw new Error(`Native checks failed: ${native.stderr}\n${native.stdout}`);
report.native = JSON.parse(native.stdout.trim());
assert.equal(report.native.arch, 'x64');
console.log('Native SQLite and terminal checks passed.');

// Verify protocol initialization and authentication without starting a paid model turn.
if (!process.env.CODEX_INTEL_SKIP_BACKEND_TEST) {
const backend = spawn(path.join(resources, 'codex'), ['app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'ignore'],
});
const lines = readline.createInterface({ input: backend.stdout });
const backendPending = new Map();
let backendSequence = 0;
lines.on('line', text => {
  let message;
  try { message = JSON.parse(text); } catch { return; }
  const callback = backendPending.get(message.id);
  if (!callback) return;
  backendPending.delete(message.id);
  clearTimeout(callback.timer);
  message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
});
const backendRpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++backendSequence;
  const timer = setTimeout(() => { backendPending.delete(id); reject(new Error(`Backend timed out: ${method}`)); }, 20000);
  backendPending.set(id, { resolve, reject, timer });
  backend.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
const retryBackend = async (method, params) => {
  for (let attempt = 0; ; attempt++) {
    try { return await backendRpc(method, params); }
    catch (error) {
      if (attempt >= 2 || !/routing discovery timed out/.test(error.message)) throw error;
      console.log(`Retrying transient workspace routing discovery: ${method}.`);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
};
try {
  await backendRpc('initialize', { clientInfo: { name: 'codex_intel_smoke', title: 'Codex Intel smoke check', version: '0.1.0' } });
  backend.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const account = await retryBackend('account/read', { refreshToken: false });
  const models = await retryBackend('model/list', {});
  report.backend = { initialized: true, signedIn: Boolean(account.account), modelCount: models.data?.length ?? 0 };
  assert.ok(report.backend.modelCount > 0, 'The backend should provide a model catalog.');
  console.log(`Codex backend initialized; signed in: ${report.backend.signedIn}; models: ${report.backend.modelCount}.`);
} finally {
  lines.close();
  backend.stdin.end();
  backend.kill('SIGTERM');
}
}

const reservation = net.createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-intel-smoke-'));
const log = fs.openSync(path.join(out, 'smoke-app.log'), 'w');
const env = { ...process.env, CODEX_ELECTRON_USER_DATA_PATH: profile };
delete env.ELECTRON_RUN_AS_NODE;
const processApp = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
  env, stdio: ['ignore', log, log], detached: false,
});
let socket;
try {
  let target;
  for (let count = 0; count < 120; count++) {
    if (processApp.exitCode !== null) throw new Error(`GUI exited with code ${processApp.exitCode}; inspect smoke-app.log`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl && !item.url.includes('initialRoute='));
      if (target) break;
    } catch { /* The GUI is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(target, 'The GUI must expose a loaded page within 60 seconds.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  const rendererEvents = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (['Runtime.exceptionThrown', 'Log.entryAdded', 'Runtime.consoleAPICalled'].includes(message.method)) {
      rendererEvents.push(message);
    }
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id);
      clearTimeout(callback.timer);
      message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await rpc('Runtime.enable');
  await rpc('Log.enable');
  let body = '';
  for (let count = 0; count < 180; count++) {
    const snapshot = await rpc('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    body = snapshot.result.value || '';
    if (body.length > 80) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  fs.writeFileSync(path.join(out, 'smoke-dom.txt'), body);
  fs.writeFileSync(path.join(out, 'smoke-renderer-events.json'), JSON.stringify(rendererEvents, null, 2));
  const screenshot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'smoke-screen.png'), Buffer.from(screenshot.data, 'base64'));
  assert.ok(body.length > 80, 'The page should contain a rendered user interface.');
  assert.ok(!body.includes('failed to start.'), 'The GUI must not show its startup failure dialog.');
  assert.ok(!/Update required|version of the app is no longer supported/i.test(body), 'The source app is obsolete; fetch the current official release.');
  report.gui = { passed: true, title: target.title, url: target.url, textCharacters: body.length };
  console.log('GUI rendered successfully.');
  fs.writeFileSync(path.join(out, 'smoke-report.json'), JSON.stringify(report, null, 2) + '\n');
} finally {
  socket?.close();
  if (processApp.exitCode === null) processApp.kill('SIGTERM');
  await Promise.race([once(processApp, 'exit'), new Promise(resolve => setTimeout(resolve, 4000))]);
  if (processApp.exitCode === null) processApp.kill('SIGKILL');
  fs.closeSync(log);
  fs.rmSync(profile, { recursive: true, force: true });
}
