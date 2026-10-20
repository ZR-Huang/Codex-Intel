// Local, bidirectional JSON-RPC transport for the officially documented Codex app server.
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const readline = require('node:readline');

class AppServerClient extends EventEmitter {
  constructor(executable, cwd) {
    super();
    this.executable = executable;
    this.cwd = cwd;
    this.sequence = 0;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.ready = false;
  }

  async start() {
    this.process = spawn(this.executable, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
    });
    this.process.stderr.on('data', bytes => this.emit('log', bytes.toString()));
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', (code, signal) => this.fail(new Error(`Codex 服务已退出 (${code ?? signal})`)));
    this.lines = readline.createInterface({ input: this.process.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.emit('log', line); return; }
      if (message.method && message.id != null) {
        this.serverRequests.set(message.id, message);
        this.emit('request', message);
      } else if (message.method) {
        if (message.method === 'serverRequest/resolved') this.serverRequests.delete(message.params?.requestId);
        this.emit('notification', message);
      } else if (message.id != null) {
        const callback = this.pending.get(message.id);
        if (!callback) return;
        this.pending.delete(message.id);
        clearTimeout(callback.timer);
        if (message.error) {
          const error = new Error(message.error.message);
          error.code = message.error.code;
          error.data = message.error.data;
          callback.reject(error);
        } else callback.resolve(message.result);
      }
    });
    const result = await this.request('initialize', {
      clientInfo: { name: 'codex_intel', title: 'Codex Intel', version: '0.1.0' },
    });
    this.send({ method: 'initialized', params: {} });
    this.ready = true;
    this.emit('ready', result);
    return result;
  }

  request(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.exitCode !== null || !this.process.stdin.writable) {
        reject(new Error('Codex 服务尚未连接'));
        return;
      }
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  send(message) {
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  respond(id, result) {
    if (!this.serverRequests.has(id)) throw new Error('该请求已处理或已失效');
    this.serverRequests.delete(id);
    this.send({ id, result });
  }

  rejectRequest(id, message) {
    this.serverRequests.delete(id);
    this.send({ id, error: { code: -32601, message } });
  }

  fail(error) {
    this.ready = false;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.serverRequests.clear();
    this.emit('disconnected', error.message);
  }

  close() {
    this.lines?.close();
    this.process?.stdin.end();
    this.process?.kill('SIGTERM');
  }
}

module.exports = { AppServerClient };
