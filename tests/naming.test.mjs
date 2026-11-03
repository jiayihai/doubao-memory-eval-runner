import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { namingExpression, renameConversation } from '../adapters/doubao-naming.mjs';
import { conversationNameFor, queueConversationName, RenameError } from '../core/naming.mjs';
import { Interrupted } from '../core/store.mjs';
import { ConnectionError } from '../adapters/cdp.mjs';

const OWNER = 'data-doubao-runner-rename-owner';
function fixture(options = {}) {
  let now = 100000;
  const events = [], pointerEvents = [], state = { title: options.title || 'Original title', value: '', menu: false, dialog: false, ...options };
  const job = { id: 'run:M01', target: 'M01', href: '/chat/1', desiredName: 'M01', phase: 'queued' };
  const attrs = values => ({ values: { ...values }, getAttribute(name) { return this.values[name] ?? null; },
    setAttribute(name, value) { this.values[name] = value; }, removeAttribute(name) { delete this.values[name]; } });
  const foreignDialog = { ...attrs({ role: 'dialog', 'data-state': 'open' }) };
  const titleRoot = { tagName: 'SPAN', classList: { contains: key => key === 'min-w-0' },
    cloneNode() { const clone = { textContent: state.title.repeat(3) }; clone.querySelectorAll = () => [{ remove: () => { clone.textContent = state.title; } }]; return clone; } };
  const item = { children: [titleRoot] };
  // The product's Radix trigger opens on primary pointerdown, NOT DOM click.
  // A click-only fake previously hid the production failure.
  const trigger = { ...attrs({ 'aria-controls': 'owned-menu', 'aria-expanded': 'false', 'data-state': 'closed' }),
    disabled: !!state.triggerDisabled,
    click() { events.push('trigger-click'); },
    dispatchEvent(event) {
      pointerEvents.push({ type: event.type, button: event.button, buttons: event.buttons,
        pointerType: event.pointerType, bubbles: event.bubbles, ctrlKey: event.ctrlKey });
      if (event.type === 'pointerdown' && !trigger.disabled && event.button === 0 && event.ctrlKey === false && !state.blockedPointer) {
        events.push(state.menu ? 'close-menu' : 'open-menu'); state.menu = !state.menu;
        trigger.values['aria-expanded'] = String(state.menu); trigger.values['data-state'] = state.menu ? 'open' : 'closed';
        // Radix prevents default while opening; dispatchEvent returning false is
        // expected and must not be interpreted as failed activation.
        return false;
      }
      return true;
    } };
  class FakeInput {
    constructor() { this.tagName = 'INPUT'; this.maxLength = 20; this.disabled = false; this.readOnly = false; this.__reactPropsTest = { value: state.value }; }
    get value() { return state.value; }
    set value(text) { state.value = text; }
    dispatchEvent(event) { if (event.type === 'input') { events.push('fill-name'); if (!state.staleReact) this.__reactPropsTest.value = state.value; } return true; }
  }
  const input = new FakeInput();
  const closeDialog = () => { state.dialog = false; dialog.removeAttribute(OWNER); };
  const confirm = { disabled: false, getAttribute: () => null, click() {
    events.push('save-name'); if (state.saveError) return;
    state.title = input.__reactPropsTest.value; closeDialog();
  } };
  const cancel = { click() { events.push('cancel-name'); closeDialog(); } };
  const dialog = { ...attrs({ role: 'dialog', 'data-state': 'open' }), querySelector(selector) {
    if (selector.includes('name_input')) return state.missingInput ? null : input;
    if (selector.includes('confirm_button')) return confirm;
    if (selector.includes('cancel_button')) return state.missingCancel ? null : cancel;
    return null;
  } };
  const renameItem = { getAttribute: () => null, click() {
    events.push('open-rename'); state.menu = false; trigger.values['aria-expanded'] = 'false';
    state.dialog = true; state.value = state.title; input.__reactPropsTest.value = state.title; dialog.removeAttribute(OWNER);
  } };
  const menu = { ...attrs({ role: 'menu', 'data-state': 'open' }), querySelector: selector => selector.includes('edit_name_icon') && !state.missingRenameItem ? { closest: () => renameItem } : null };
  const entry = { querySelector: selector => selector.includes('more_button') ? trigger : selector.includes('conversation-list-v2-item') ? item : null };
  const document = {
    getElementById: id => id === 'conversation_1' ? entry : id === 'owned-menu' && state.menu ? menu : null,
    querySelector: selector => selector.includes('edit_conversation_dialog') ? state.dialog ? dialog : null : selector.includes('chat_input_input') ? {} : null,
    querySelectorAll: selector => selector.includes('role="dialog"')
      ? [...state.dialog ? [dialog] : [], ...state.foreignDialog ? [foreignDialog] : []] : selector.includes('role="menu"') && state.menu ? [menu] : []
  };
  const context = { document, location: { pathname: '/chat/1' }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    HTMLInputElement: FakeInput, Event: class { constructor(type) { this.type = type; } },
    PointerEvent: class { constructor(type, properties) { this.type = type; Object.assign(this, properties); } } };
  let lostReceipt = false;
  const adapter = { choose: async () => ({ inputText: '', busy: false, thinking: false }), verifyAccount: async () => {},
    openKnown: async href => { assert.equal(href, '/chat/1'); }, client: {
      evaluate: async expression => {
        const result = vm.runInNewContext(expression, context);
        if (state.loseSaveReceipt && !lostReceipt && expression.includes('const action="confirm"')) { lostReceipt = true; throw new ConnectionError('save receipt lost'); }
        return result;
      }, send: () => { throw new Error('Naming must never use general keyboard input or send a chat message'); }
    } };
  const run = extra => renameConversation(adapter, job, 'account', { clock: () => now, delay: async ms => { now += ms; }, timeoutMs: 1000, ...extra });
  return { state, job, events, pointerEvents, adapter, run, dialog, trigger, context };
}

test('命名值使用流程会话编号，过长名称作为独立失败不破坏消息完成记录', () => {
  assert.equal(conversationNameFor({ target: 'T16-POST', id: 'S30' }), 'T16-POST');
  const state = { features: { renameConversations: true }, completions: [{ key: 'done' }] };
  const job = queueConversationName(state, { target: 'a'.repeat(21), navigation: 'new' }, '/chat/1', 1);
  assert.equal(job.status, 'failed'); assert.equal(state.completions.length, 1);
});

test('通过精确会话菜单填写改名，保存后核对标题并退出编辑', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.title, 'M01'); assert.equal(f.state.title, 'M01'); assert.equal(f.job.cleanupVerified, true);
  assert.deepEqual(f.events, ['open-menu', 'open-rename', 'fill-name', 'save-name']);
  assert.equal(f.state.dialog, false); assert.equal(f.state.menu, false);
  assert.deepEqual(f.pointerEvents, [
    { type: 'pointerdown', button: 0, buttons: 1, pointerType: 'mouse', bubbles: true, ctrlKey: false },
    { type: 'pointerup', button: 0, buttons: 0, pointerType: 'mouse', bubbles: true, ctrlKey: false }
  ]);
});

test('DOM click不会打开实际模型的菜单，pointerdown打开后由归属核对确认', () => {
  const f = fixture(); f.trigger.click(); assert.equal(f.state.menu, false);
  vm.runInNewContext(namingExpression('open_menu', f.job), f.context);
  assert.equal(f.state.menu, true);
  assert.equal(vm.runInNewContext(namingExpression('claim_menu', f.job), f.context), true);
  const count = f.pointerEvents.length;
  vm.runInNewContext(namingExpression('inspect', f.job), f.context);
  assert.equal(f.pointerEvents.length, count);
});

test('菜单打开但改名入口缺失时用相同指针事件收起，仅安全退出后继续', async () => {
  const f = fixture({ missingRenameItem: true });
  await assert.rejects(f.run(), error => error instanceof RenameError && error.safeToContinue);
  assert.deepEqual(f.events, ['open-menu', 'close-menu']);
  assert.equal(f.state.menu, false); assert.equal(f.job.cleanupVerified, true);
  assert.deepEqual(f.pointerEvents.map(x => x.type), ['pointerdown','pointerup','pointerdown','pointerup']);
});

test('菜单展开后暂停，即使尚未认领菜单也会安全收起，恢复不重复开关', async () => {
  const f = fixture(); let stopped = false;
  await assert.rejects(f.run({ checkpoint: () => {
    if (f.state.menu && !stopped) { stopped = true; throw new Interrupted('paused'); }
  } }), Interrupted);
  assert.equal(f.state.menu, false); assert.equal(f.job.cleanupVerified, true);
  await f.run(); assert.equal(f.state.title, 'M01');
  assert.equal(f.events.filter(x => x === 'save-name').length, 1);
});

test('非本次拥有的菜单不能由清理动作擅自切换', () => {
  const f = fixture(); f.state.menu = true; f.trigger.values['aria-expanded'] = 'true';
  vm.runInNewContext(namingExpression('cancel_owned', f.job), f.context);
  assert.equal(f.state.menu, true); assert.deepEqual(f.pointerEvents, []);
});

test('菜单未展开时记录具体阶段和控件状态，禁止进入改名或聊天输入', async () => {
  const f = fixture({ blockedPointer: true });
  await assert.rejects(f.run(), error => error instanceof RenameError && error.safeToContinue && /会话菜单展开/.test(error.message));
  assert.equal(f.job.failureStage, 'menu_open_attempted');
  assert.equal(f.job.failureView.triggerExpanded, 'false'); assert.equal(f.job.failureView.otherMenus, 0);
  assert.equal(f.job.failureView.href, '/chat/1'); assert.deepEqual(f.events, []);
});

test('禁用的菜单按钮不发送指针事件，保持原标题', async () => {
  const f = fixture({ triggerDisabled: true });
  await assert.rejects(f.run(), error => error instanceof RenameError && error.safeToContinue && /按钮不可用/.test(error.message));
  assert.deepEqual(f.pointerEvents, []); assert.equal(f.state.title, 'Original title');
  assert.equal(f.job.failureView.triggerDisabled, true);
});

test('标题已经正确时只核对，不重复打开菜单或提交改名', async () => {
  const f = fixture({ title: 'M01' }); const result = await f.run();
  assert.equal(result.status, 'already_named'); assert.deepEqual(f.events, []);
});

test('改名保存后回执丢失，重新执行读到正确标题不会再次提交', async () => {
  const f = fixture({ loseSaveReceipt: true });
  await assert.rejects(f.run(), error => error instanceof RenameError && error.safeToContinue);
  await f.run();
  assert.equal(f.events.filter(x => x === 'save-name').length, 1); assert.equal(f.state.title, 'M01');
});

test('保存失败会取消本次改名窗口，确认界面恢复后才允许流程继续', async () => {
  const f = fixture({ saveError: true });
  await assert.rejects(f.run(), error => error instanceof RenameError && error.safeToContinue);
  assert.equal(f.state.title, 'Original title'); assert.equal(f.state.dialog, false);
  assert.ok(f.events.includes('cancel-name')); assert.equal(f.job.cleanupVerified, true);
});

test('名称输入没有进入React状态时不点击保存，清理本次窗口', async () => {
  const f = fixture({ staleReact: true });
  await assert.rejects(f.run(), error => error instanceof RenameError && error.safeToContinue);
  assert.ok(!f.events.includes('save-name')); assert.equal(f.state.dialog, false);
});

test('发现非本次打开的弹窗时不擅自关闭，不继续输入发送', async () => {
  const f = fixture({ foreignDialog: true });
  await assert.rejects(f.run(), error => error instanceof RenameError && !error.safeToContinue);
  assert.deepEqual(f.events, []); assert.equal(f.state.foreignDialog, true);
});

test('无法退出改名弹窗时不允许继续测评', async () => {
  const f = fixture({ saveError: true, missingCancel: true });
  await assert.rejects(f.run(), error => error instanceof RenameError && !error.safeToContinue);
  assert.equal(f.state.dialog, true); assert.equal(f.job.cleanupVerified, false);
});

test('改名期间暂停先退出本次窗口，继续后可再次核对完成', async () => {
  const f = fixture(); let stopped = false;
  await assert.rejects(f.run({ checkpoint: () => { if (f.job.phase === 'dialog_owned' && !stopped) { stopped = true; throw new Interrupted('paused'); } } }), Interrupted);
  assert.equal(f.state.dialog, false); assert.equal(f.state.title, 'Original title');
  await f.run(); assert.equal(f.state.title, 'M01');
});

test('没有归属标记的改名窗口不能被填写或保存', () => {
  const f = fixture(); f.state.dialog = true;
  assert.throws(() => vm.runInNewContext(namingExpression('fill_input', f.job), f.context), /未取得/);
  assert.equal(f.state.value, ''); assert.deepEqual(f.events, []);
});
