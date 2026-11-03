import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, validate } from '../datasets/index.mjs';
import { lockDirectory, saveJSON, loadJSON } from '../core/store.mjs';
import { connect, ConnectionError } from '../adapters/cdp.mjs';
import { serve, Controller } from '../server.mjs';

function cleanup(path) {
  // Only remove explicitly created test files, with no recursive deletion command.
  for (const file of readdirSync(path)) { const item = join(path, file); if (statSync(item).isDirectory()) cleanup(item); else unlinkSync(item); }
  rmdirSync(path);
}
test('旧流程消息与源哈希、等待规则保持不变', () => {
  const data = loadDataset(); assert.equal(data.total, 54); assert.equal(data.data.steps.length, 31);
  assert.deepEqual(data.data.wait_profiles_seconds, { message_gap: [15, 15], short: [60, 180], long: [600, 900] });
  assert.equal(data.data.steps.at(-1).target, 'T17'); assert.equal(data.data.steps.at(-1).execution, 'manual');
});
test('长流程技术回归明确标注用途，不伪造初始状态确认', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doubao-v1-regression-'));
  try {
    const controller = new Controller(dir);
    controller.check = async () => ({ account: 'test-account', draft: false });
    controller.execute = () => {};
    await assert.rejects(controller.start({ datasetId: 'doubao-b', purpose: 'technical_regression' }), /确认沿用/);
    await controller.start({ datasetId: 'doubao-b', purpose: 'technical_regression', acknowledgeExistingMemory: true });
    assert.equal(controller.state.purpose, 'technical_regression');
    assert.equal(controller.state.cleanStateDeclaredAt, null);
    assert.equal(controller.state.completions.length, 0);
    assert.equal(controller.state.features.renameConversations, true);
    assert.equal(controller.state.features.captureReplies, true);
    assert.equal(controller.state.features.autoGenerateResults, true);
  } finally { cleanup(dir); }
});

test('已检测到平台失败标记时禁用核对后重试，接口也拒绝重发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doubao-v1-failure-'));
  try {
    const controller = new Controller(dir);
    controller.state = { status: 'needs_review', phase: 'messages', datasetId: 'smoke',
      stepIndex: 0, messageIndex: 0, completions: [], deviations: [],
      pending: { userId: null, deliveryFailure: { direction: 'send' } },
      renameJobs: { M01: { status: 'failed' }, T01: { status: 'done' } }, features: { renameConversations: true } };
    const view = controller.status();
    assert.equal(view.run.canReviewRetry, false);
    assert.equal(view.run.namingFailed, 1); assert.equal(view.run.namingDone, 1);
    await assert.rejects(controller.retryNotSent(), /处理原消息/);
  } finally { cleanup(dir); }
});
test('连通性流程独立且包含新建和返回操作', () => {
  const smoke = loadDataset('smoke'); assert.equal(smoke.total, 4);
  assert.equal(smoke.data.steps.at(-1).navigation, 'return');
  assert.ok(smoke.data.steps[0].messages[0].send_text.includes('Do not remember'));
});
test('损坏格式、未知等待、先返回后创建被拒绝', () => {
  const data = loadDataset('smoke').data;
  data.steps[0].navigation = 'return'; assert.throws(() => validate(data), /尚未建立/);
  const next = loadDataset('smoke').data;
  next.steps[0].transition_actions = [{ action: 'wait', profile: 'missing' }]; assert.throws(() => validate(next), /等待/);
});
test('进度原子写入与运行锁防止重复启动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doubao-v1-test-'));
  try {
    saveJSON(join(dir, 'state.json'), { pointer: 1 }); saveJSON(join(dir, 'state.json'), { pointer: 2 });
    assert.deepEqual(loadJSON(join(dir, 'state.json')), { pointer: 2 });
    const release = lockDirectory(dir);
    assert.throws(() => lockDirectory(dir), /已经运行/); release();
    assert.ok(readFileSync(join(dir, 'state.json'), 'utf8').includes('2'));
  } finally { cleanup(dir); }
});

class FakeSocket extends EventTarget {
  static latest;
  constructor() { super(); FakeSocket.latest = this; this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
  send(text) { this.last = JSON.parse(text); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  reply(value) { const event = new Event('message'); event.data = JSON.stringify(value); this.dispatchEvent(event); }
}
const target = { id: 'fake', webSocketDebuggerUrl: 'ws://fake' };
test('连接关闭时立即拒绝在途请求', async () => {
  const c = await connect(target, { WebSocketImpl: FakeSocket });
  const call = c.send('Runtime.evaluate'); const reject = assert.rejects(call, ConnectionError);
  FakeSocket.latest.close(); await reject; await assert.rejects(c.send('Runtime.evaluate'), ConnectionError);
});
test('协议按ID匹配响应；无响应会超时', async () => {
  const c = await connect(target, { WebSocketImpl: FakeSocket, timeoutMs: 20 });
  const call = c.send('Runtime.evaluate'); FakeSocket.latest.reply({ id: FakeSocket.latest.last.id, result: { ok: true } });
  assert.deepEqual(await call, { ok: true }); await assert.rejects(c.send('Runtime.evaluate'), ConnectionError); c.close();
});
test('本地接口需要随机凭证；正式流程没有初始状态确认不会发送', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doubao-v1-api-'));
  const token = 'test-token-only-for-local-automated-testing';
  const service = await serve({ root: dir, token });
  const endpoint = `http://127.0.0.1:${service.port}`;
  try {
    assert.equal((await fetch(endpoint + '/status')).status, 403);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const status = await (await fetch(endpoint + '/status', { headers })).json(); assert.equal(status.active, false);
    const start = await fetch(endpoint + '/start', { method: 'POST', headers, body: JSON.stringify({ datasetId: 'doubao-b' }) });
    assert.equal(start.status, 409); assert.match((await start.json()).error, /初始状态/);
    assert.equal(service.controller.state, null);
  } finally {
    await new Promise(resolve => service.server.close(resolve)); cleanup(dir);
  }
});
