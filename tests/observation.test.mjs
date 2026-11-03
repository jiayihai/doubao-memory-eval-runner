import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DoubaoAdapter, SNAPSHOT } from '../adapters/doubao.mjs';
import { replyState, submissionState, summarize, messageFailure } from '../core/observation.mjs';
import { loadExecutionPolicy } from '../core/policy.mjs';
import { PageNotReady, ReviewRequired, saveJSON } from '../core/store.mjs';

test('完成标记不能覆盖思考和生成状态；单独文字稳定不能确认结束', () => {
  const answer = { id: 'a', text: 'partial', explicitComplete: true };
  assert.equal(replyState({ thinking: true }, answer).stage, 'thinking');
  assert.equal(replyState({ busy: true }, answer).stage, 'generating');
  assert.equal(replyState({}, { ...answer, explicitComplete: false }).stage, 'awaiting_completion');
  assert.equal(replyState({}, { ...answer, explicitComplete: false, completionControls: true }).stableMs, 8000);
});

test('账号与模式使用传入的同一快照核对，加载缺失与真实变化分开', async () => {
  const adapter = new DoubaoAdapter(); adapter.snapshot = () => { throw new Error('不应额外读取'); };
  const info = { account: 'account', dialogue: true, inputExists: true };
  assert.equal(await adapter.verifyAccount('account', info), info);
  await assert.rejects(adapter.verifyAccount('account', { ...info, account: '' }), PageNotReady);
  await assert.rejects(adapter.verifyAccount('account', { ...info, account: 'other' }), ReviewRequired);
  await assert.rejects(adapter.verifyAccount('account', { ...info, dialogue: false, mode: null }), PageNotReady);
  await assert.rejects(adapter.verifyAccount('account', { ...info, dialogue: false, mode: '工作' }), ReviewRequired);
});

test('等待回答时只读当前会话，不反复导航或滚动', async () => {
  const adapter = new DoubaoAdapter(); let reads = 0;
  const info = { url: 'chrome://doubao-chat/chat/1' };
  adapter.client = { evaluate: async expression => { assert.equal(expression, SNAPSHOT); reads++; return info; } };
  adapter.pages = () => { throw new Error('不应反复查找页面'); };
  adapter.openKnown = () => { throw new Error('不应重新打开会话'); };
  adapter.scrollLatest = () => { throw new Error('不应每次滚动'); };
  assert.equal(await adapter.observe({ href: '/chat/1' }, {}), info);
  assert.equal(await adapter.observe({ href: '/chat/1' }, {}), info);
  assert.equal(reads, 2);
});

test('页面快照能区分正在思考和已完成思考', () => {
  const rect = () => ({ width: 20, height: 20 });
  for (const label of ['思考中', '已完成思考']) {
    const status = { innerText: label, getBoundingClientRect: rect, getAttribute: () => null };
    const part = { innerText: 'answer', getAttribute: name => name === 'data-streaming' ? 'false' : null };
    const root = {
      getAttribute: name => name === 'data-testid' ? 'receive_message' : null,
      querySelector: selector => selector === '[data-testid="message_content"]' ? { getAttribute: () => 'a1' } : null,
      querySelectorAll: selector => selector === '[data-testid="message_text_content"]' ? [part]
        : selector.includes('thinking') ? [status] : []
    };
    const document = { visibilityState: 'visible',
      querySelectorAll: selector => selector.includes('send_message') ? [root] : [],
      querySelector: () => null };
    const info = vm.runInNewContext(SNAPSHOT, { document, location: { href: 'chrome://doubao-chat/chat/1' } });
    assert.equal(info.thinking, label === '思考中');
    assert.equal(info.received[0].explicitComplete, true);
  }
});

test('恢复预算与测评间隔无关，配置缺失用默认值，非法配置拒绝', () => {
  const directory = mkdtempSync(join(tmpdir(), 'doubao-policy-'));
  const file = join(directory, '执行设置.json');
  try {
    assert.deepEqual(loadExecutionPolicy(directory), { confirmMs: 90000, recoveryMs: 90000, responseMs: 600000 });
    saveJSON(file, { confirmSeconds: 120, recoverySeconds: 45, responseSeconds: 900 });
    assert.deepEqual(loadExecutionPolicy(directory), { confirmMs: 120000, recoveryMs: 45000, responseMs: 900000 });
    saveJSON(file, { responseSeconds: -1 }); assert.throws(() => loadExecutionPolicy(directory), /执行设置/);
  } finally { unlinkSync(file); rmdirSync(directory); }
});

test('新会话仍在/chat时保留原页面草稿，不当作发送成功或页面断开', async () => {
  const adapter = new DoubaoAdapter();
  const info = { url: 'chrome://doubao-chat/chat', inputText: 'expected', sent: [], received: [], ordered: [], inputExists: true };
  adapter.client = { target: { id: 'origin' } };
  adapter.pages = async () => [{ id: 'origin', url: info.url }];
  adapter.snapshot = async () => info;
  adapter.use = async () => {};
  const pending = { href: null, attemptedAt: 100, beforeHrefs: [], text: 'expected' };
  const observed = await adapter.observe(pending, { targetId: 'origin' });
  assert.equal(observed.inputText, 'expected');
  assert.equal(observed.matchedConversation, false);
  assert.equal(observed.observationScope, 'unmatched_new');
  assert.equal(submissionState(observed, pending).kind, 'draft_retained');
  assert.equal(summarize(observed).available, true);
  assert.equal(await adapter.restore(pending, { targetId: 'origin' }), null);
});

test('失败标记只对应当前消息，旧消息失败或正文含失败字样不会误判', () => {
  const old = { id: 'old', text: 'old', failed: true };
  const current = { id: 'new', text: '发送失败只是待测试的文字', failed: false };
  const snapshot = { url: 'chrome://doubao-chat/chat/1', sent: [old, current], received: [] };
  const pending = { text: current.text, knownSentIds: ['old'], beforeSentId: 'old', href: '/chat/1' };
  assert.equal(messageFailure(snapshot, pending), null);
  current.failed = true;
  assert.equal(messageFailure(snapshot, pending).direction, 'send');
  assert.equal(messageFailure({ ...snapshot, pendingPage: false }, pending), null);
});

test('失败回答的结束标记不触发完成', () => {
  assert.equal(replyState({}, { id: 'a', text: 'partial', failed: true, explicitComplete: true }).stage, 'platform_failure');
});

test('实际快照仅依据每条消息内部的产品失败控件设置failed', () => {
  for (const hasIcon of [false, true]) {
    const root = {
      getAttribute: name => name === 'data-testid' ? 'send_message' : null,
      querySelector: selector => selector === '[data-testid="message_content"]' ? { getAttribute: () => 'u1' }
        : selector === '[data-testid="message_box_failed_icon"]' && hasIcon ? { getAttribute: key => key === 'title' ? '发送失败' : null } : null,
      querySelectorAll: selector => selector === '[data-testid="message_text_content"]'
        ? [{ innerText: '这段正文包含红色感叹号和发送失败', getAttribute: () => null }] : []
    };
    const document = { querySelectorAll: selector => selector.includes('send_message') ? [root] : [], querySelector: () => null };
    const info = vm.runInNewContext(SNAPSHOT, { document, location: { href: 'chrome://doubao-chat/chat/1' } });
    assert.equal(info.sent[0].failed, hasIcon);
    if (hasIcon) assert.equal(info.sent[0].failureHint, '发送失败');
  }
});
