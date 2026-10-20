// Exercise the actual packaged Intel agent in a temporary workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import clientModule from './app-server-client.cjs';

const { AppServerClient } = clientModule;
const here = path.dirname(fileURLToPath(import.meta.url));
const executable = path.join(here, 'dist/Codex Intel.app/Contents/Resources/codex');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-intel-coding-'));
const backend = new AppServerClient(executable, workspace);
const events = [];
let timer;
try {
  backend.on('request', message => {
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      backend.respond(message.id, { decision: 'decline' });
    } else backend.rejectRequest(message.id, 'Unexpected request during the isolated coding check');
  });
  backend.on('notification', message => events.push(message));
  await backend.start();
  const { thread } = await backend.request('thread/start', {
    cwd: workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'workspace-write',
    developerInstructions: 'This is an isolated compatibility test. Only access files inside the supplied temporary working directory. Do not use network tools.',
  });
  const finished = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Coding check timed out after 180 seconds')), 180000);
    backend.on('notification', message => {
      if (message.method === 'item/agentMessage/delta') process.stdout.write(message.params.delta);
      if (message.method === 'turn/completed' && message.params.threadId === thread.id) resolve(message.params.turn);
    });
  });
  await backend.request('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: '这是 Intel 客户端的功能验证。请在当前工作目录创建 intel-check.txt，内容恰好为 CODEX_INTEL_OK 后跟一个换行符。然后读取文件核对，最终只回复“Intel 编码验证通过”。不要联网，不要修改其他文件。', text_elements: [] }],
  });
  const turn = await finished;
  assert.equal(turn.status, 'completed', JSON.stringify(turn.error));
  assert.equal(fs.readFileSync(path.join(workspace, 'intel-check.txt'), 'utf8'), 'CODEX_INTEL_OK\n');
  const report = { checkedAt: new Date().toISOString(), status: 'passed',
    threadId: thread.id, turnId: turn.id, modelTurnCompleted: true, fileCreatedAndRead: true,
    commandEvents: events.filter(event => event.method === 'item/completed' && event.params.item?.type === 'commandExecution').length,
    fileChangeEvents: events.filter(event => event.method === 'item/completed' && event.params.item?.type === 'fileChange').length };
  fs.writeFileSync(path.join(here, 'dist/coding-e2e-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('\nPASS: the packaged Intel agent completed a model turn and created the expected file.');
} finally {
  clearTimeout(timer);
  backend.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}
