import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DoubaoAdapter, historyNavigationExpression } from '../adapters/doubao.mjs';
import { PageNotReady, ReviewRequired } from '../core/store.mjs';
import { submissionState, summarize } from '../core/observation.mjs';
import { hash } from '../core/store.mjs';

function fixture({ missing = false, hydrated = true, reload = false, draft = '' } = {}) {
  const events = [], clock = { timeOrigin: 1000 };
  let href = 'chrome://doubao-chat/chat/2';
  const location = {};
  Object.defineProperty(location, 'href', { get: () => href, set: () => { throw new Error('Forbidden document reload'); } });
  const link = { tagName: 'A', getAttribute: () => '/chat/1',
    dispatchEvent: event => { events.push(event.type); return true; },
    click: () => { events.push('click'); link.__reactPropsTest.onClick(); } };
  if (hydrated) link.__reactPropsTest = { onClick: () => { href = 'chrome://doubao-chat/chat/1'; if (reload) clock.timeOrigin = 2000; } };
  const context = { document: { getElementById: id => id === 'conversation_1' && !missing ? link : null },
    location, performance: clock, URL, Date, window: {}, MouseEvent: class { constructor(type) { this.type = type; } } };
  const adapter = new DoubaoAdapter();
  const evaluations = [];
  adapter.pages = async () => [{ id: 'page', url: href }];
  adapter.use = async () => {};
  adapter.client = { evaluate: async expression => { evaluations.push(expression); return vm.runInNewContext(expression, context); } };
  adapter.snapshot = async () => ({ url: href, inputExists: true, inputText: draft, timeOrigin: clock.timeOrigin,
    sent: [{ id: 'last' }], received: [], ordered: [] });
  adapter.waitPage = async predicate => { const info = await adapter.snapshot(); assert.ok(predicate(info)); return info; };
  adapter.latestSnapshot = async () => adapter.snapshot();
  return { context, adapter, events, evaluations, link };
}

test('历史入口沿用原生路由和鼠标准备钩子，页面实例保持不变', async () => {
  const f = fixture();
  const info = await f.adapter.openKnown('/chat/1');
  assert.equal(new URL(info.url).pathname, '/chat/1');
  assert.deepEqual(f.events, ['mousedown', 'mouseup', 'click']);
  assert.equal(info.timeOrigin, 1000);
  assert.equal(f.adapter.navigationEvidence.method, 'history_link');
  assert.equal(f.adapter.navigationEvidence.afterTimeOrigin, 1000);
});

test('历史入口缺失或事件尚未挂载时先等待，不退回整页加载', async () => {
  for (const options of [{ missing: true }, { hydrated: false }]) {
    const f = fixture(options);
    await assert.rejects(f.adapter.openKnown('/chat/1'), error => error instanceof PageNotReady && error.code === 'history_entry_loading');
    assert.deepEqual(f.events, []);
    assert.equal(f.context.performance.timeOrigin, 1000);
  }
});

test('历史入口意外发生整页重载时停止在提交前', async () => {
  const f = fixture({ reload: true });
  await assert.rejects(f.adapter.openKnown('/chat/1'), error => error instanceof ReviewRequired && error.code === 'history_document_reloaded');
});

test('已经位于目标会话时不再触发历史入口或比较旧导航记录', async () => {
  const f = fixture();
  await f.adapter.openKnown('/chat/1');
  f.context.performance.timeOrigin = 3000;
  await f.adapter.openKnown('/chat/1');
  assert.deepEqual(f.events, ['mousedown', 'mouseup', 'click']);
  assert.equal(f.evaluations.length, 1);
  assert.equal(f.adapter.navigationEvidence.method, 'already_open');
});

test('现有草稿阻止会话切换，异常地址不能生成导航动作', async () => {
  const f = fixture({ draft: 'operator draft' });
  await assert.rejects(f.adapter.openKnown('/chat/1'), /草稿/);
  assert.equal(f.evaluations.length, 0);
  assert.throws(() => historyNavigationExpression('https://other.example/chat/1'), /地址/);
});

test('输入框残留、清空、变化分别识别，不据此自动重发', () => {
  const pending = { text: 'expected' };
  assert.equal(submissionState({ inputText: 'expected' }, pending).kind, 'draft_retained');
  assert.equal(submissionState({ inputText: '\n' }, pending).kind, 'draft_cleared');
  assert.equal(submissionState({ inputText: 'different' }, pending).kind, 'draft_changed');
  assert.equal(submissionState(null, pending).kind, 'page_unavailable');
});

test('诊断摘要记录草稿哈希和焦点，日志不包含草稿原文', () => {
  const info = { url: 'chrome://doubao-chat/chat/1', inputText: 'private prompt', sent: [], received: [],
    focused: true, visibility: 'hidden', readyState: 'complete', timeOrigin: 1000, sendReady: true };
  const result = summarize(info);
  assert.equal(result.draftHash, hash('private prompt'));
  assert.equal(result.draftLength, 14);
  assert.equal(result.focused, true);
  assert.ok(!JSON.stringify(result).includes('private prompt'));
});
