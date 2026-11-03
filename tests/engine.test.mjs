import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine.mjs';
import { loadDataset } from '../datasets/index.mjs';
import { ConnectionError } from '../adapters/cdp.mjs';
import { RenameError } from '../core/naming.mjs';
import { ReplyArchive } from '../core/reply-archive.mjs';
import { mkdtempSync, readdirSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findSent, findAnswer, renderedKey, normalize, ReviewRequired, PageNotReady, Interrupted } from '../core/store.mjs';

const clone = structuredClone;
const user = (id, text) => ({ id, text, role: 'user' });
const answer = id => ({ id, text: 'OK', role: 'assistant', streaming: false, explicitComplete: true });
const snapshot = (href = '/chat', ordered = []) => ({ url: `chrome://doubao-chat${href}`, ordered,
  sent: ordered.filter(x => x.role === 'user'), received: ordered.filter(x => x.role === 'assistant'), inputText: '', busy: false });
class Adapter {
  constructor() { this.chats = new Map(); this.current = snapshot(); this.client = { target: { id: 'page' } }; this.sends = 0; this.clicks = 0; this.fault = null; this.draft = ''; }
  close() {}
  async pages() { return [...this.chats.keys()].map(href => ({ url: `chrome://doubao-chat${href}`, id: href })); }
  async verifyAccount(account) { if (account !== 'test-account') throw new Error('账号不一致'); return this.current; }
  async prepareNew(account) {
    await this.verifyAccount(account); const beforeHrefs = [...this.chats.keys()];
    this.current = snapshot(); this.draft = ''; return { targetId: 'page', beforeHrefs };
  }
  async restoreUnsent() { return this.current; }
  async openKnown(href) { this.current = this.chats.get(href); return this.current; }
  async restore(pending, navigation) {
    if (this.fault === 'read_disconnect') { this.fault = null; throw new ConnectionError('模拟读取断开'); }
    if (pending.href) return this.openKnown(pending.href);
    if (pending.attemptedAt === null) return this.restoreUnsent(navigation);
    const pair = [...this.chats.entries()].find(([href, info]) => !pending.beforeHrefs.includes(href) && info.sent.length === 1 && renderedKey(info.sent[0].text) === renderedKey(pending.text));
    if (!pair) return null;
    this.current = pair[1]; return this.current;
  }
  async fill(text) { this.draft = text; }
  async send() {
    this.clicks++;
    if (this.fault === 'before_send') { this.fault = null; throw new ConnectionError('点击未到达'); }
    this.sends++;
    let href = new URL(this.current.url).pathname;
    if (!/^\/chat\/\d+$/.test(href)) href = `/chat/${this.chats.size + 1}`;
    const reply = answer(`a${this.sends}`);
    if (this.expectedReplies) reply.text = this.expectedReplies[this.sends - 1];
    this.current = snapshot(href, [...this.current.ordered, user(`u${this.sends}`, this.draft), reply]);
    this.chats.set(href, this.current);
    if (this.fault === 'after_send') { this.fault = null; throw new ConnectionError('发送成功但回执丢失'); }
  }
}
function setup(options = {}) {
  let now = options.now || 100000;
  const adapter = options.adapter || new Adapter(); adapter.fault = options.fault || null;
  const dataset = options.dataset || { total: (options.messages || ['hello']).length, data: { wait_profiles_seconds: { message_gap: [15, 15], short: [60, 60] }, steps: options.steps || [
    { id: 'S01', target: 'M01', name: 'test', execution: 'automatic', navigation: 'new',
      messages: (options.messages || ['hello']).map(send_text => ({ send_text })), transition_actions: [] }
  ] } };
  const state = options.state || { account: 'test-account', phase: 'navigation', status: 'running', stepIndex: 0,
    messageIndex: 0, transitionIndex: 0, navigation: null, pending: null, wait: null,
    conversations: {}, completions: [], deviations: [] };
  const saved = [], events = [];
  const engine = new Engine({ dataset, adapter, state, clock: () => now,
    delay: async ms => { now += ms; options.onDelay?.(ms); },
    save: s => saved.push(clone(s)), event: (type, message, details) => { events.push({ type, message, details }); options.event?.(type); },
    request: options.request || (() => null), confirmMs: 5000, reconnectMs: 15000, ...options.engineOptions });
  return { engine, dataset, adapter, state, saved, events, now: () => now, advance: ms => { now += ms; } };
}

function removeArchiveTest(root) {
  const absolute=resolve(root);
  if(!absolute.startsWith(resolve(tmpdir(),'doubao-engine-archive-')))throw new Error('Unexpected cleanup path');
  const walk=dir=>{if(dir!==absolute&&!dir.startsWith(absolute+'\\'))throw new Error('Cleanup escaped test directory');
    for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())walk(p);else unlinkSync(p);}rmdirSync(dir);};
  walk(absolute);
}

test('旧B54条逐条保存后才增加进度，23个命名会话备份含全部本轮问答',async()=>{
  const root=mkdtempSync(join(tmpdir(),'doubao-engine-archive-'));
  try {
    const run=setup({dataset:loadDataset('doubao-b')});
    Object.assign(run.state,{runId:'test-run',features:{captureReplies:true,renameConversations:true}});
    const archive=new ReplyArchive({directory:root,runId:'test-run',datasetId:run.dataset.id,datasetHash:run.dataset.fingerprint,account:run.state.account});
    run.adapter.expectedReplies=Array.from({length:54},(_,i)=>`第${i+1}条完整回答`+'正文'.repeat(i===0?1500:2));
    run.adapter.renameConversation=async job=>({title:job.desiredName});
    run.engine.archiveReply=payload=>{
      assert.equal(run.state.completions.length,payload.sequence-1);
      assert.equal(run.saved.at(-1).pending.replyToSave.answer,payload.answer);
      return archive.save(payload);
    };
    await run.engine.run();
    assert.equal(run.adapter.sends,54);assert.equal(run.state.completions.length,54);assert.equal(run.state.status,'awaiting_manual');
    assert.equal(readdirSync(join(root,'回复记录')).filter(x=>x.endsWith('.json')).length,54);
    const files=readdirSync(join(root,'会话备份'));
    assert.equal(files.filter(x=>x.endsWith('.md')).length,23);
    const index=JSON.parse(readFileSync(join(root,'会话备份/_备份索引.json'),'utf8'));
    assert.equal(index.savedTurns,54);assert.equal(index.conversationCount,23);
    const messages=files.filter(x=>x.endsWith('.json')&&!x.startsWith('_')).flatMap(name=>JSON.parse(readFileSync(join(root,'会话备份',name),'utf8')).messages);
    assert.equal(messages.length,108);assert.equal(new Set(messages.map(x=>x.messageId)).size,108);
    for(const completion of run.state.completions){
      const saved=JSON.parse(readFileSync(join(root,completion.replyArchive.replyFile),'utf8'));
      assert.equal(saved.prompt,run.dataset.data.steps.find(s=>s.id===completion.stepId).messages[completion.messageIndex].send_text);
      assert.equal(saved.answer,run.adapter.expectedReplies[saved.sequence-1]);
    }
    for(let i=1;i<54;i++)assert.equal(run.state.completions[i].sendAttemptedAt-run.state.completions[i-1].answerCompletionObservedAt,30000);
  } finally {removeArchiveTest(root);}
});

test('保存失败保留正文，恢复先补本地保存，不重发、不重新计时',async()=>{
  let run,reads=0;
  run=setup({messages:['one','two'],engineOptions:{archiveReply:()=>{throw new Error('磁盘写入失败');}}});
  run.state.features={captureReplies:true};
  const restore=run.adapter.restore.bind(run.adapter);
  run.adapter.restore=async(...args)=>{reads++;return restore(...args);};
  await assert.rejects(run.engine.run(),error=>error.code==='reply_archive_failed');
  assert.equal(run.state.completions.length,0);assert.equal(run.state.messageIndex,0);assert.equal(run.adapter.sends,1);
  const saved=clone(run.saved.at(-1)),originalTime=saved.pending.replyToSave.completion.answerCompletionObservedAt,readsAtFailure=reads;
  assert.equal(saved.pending.replyToSave.answer,'OK');
  let saves=0;
  const resumed=setup({messages:['one','two'],state:saved,adapter:run.adapter,now:originalTime+60000,engineOptions:{archiveReply:payload=>{
    if(++saves===1){assert.equal(reads,readsAtFailure);assert.equal(payload.completion.answerCompletionObservedAt,originalTime);assert.equal(run.adapter.sends,1);}
    return {status:'saved'};
  }}});
  await resumed.engine.run();
  assert.equal(run.adapter.sends,2);assert.equal(saves,2);assert.equal(resumed.state.completions[0].answerCompletionObservedAt,originalTime);
  assert.equal(resumed.state.intervals[0].actualGapMs,60000);
});

test('文件已保存但提交进度前退出，重启重建备份不重复记录或读取会话',async()=>{
  const root=mkdtempSync(join(tmpdir(),'doubao-engine-archive-'));
  try {
    const archive=new ReplyArchive({directory:root,runId:'test-run',datasetId:'test',datasetHash:'fixed',account:'test-account'});
    const run=setup({engineOptions:{archiveReply:payload=>{archive.save(payload);throw new Error('模拟保存后退出');}}});
    run.state.features={captureReplies:true};
    await assert.rejects(run.engine.run(),error=>error.code==='reply_archive_failed');
    run.adapter.restore=()=>{throw new Error('不应重新读取');};run.adapter.send=()=>{throw new Error('不应重发');};
    const resumed=setup({state:clone(run.saved.at(-1)),adapter:run.adapter,now:run.now()+10000,engineOptions:{archiveReply:payload=>archive.save(payload)}});
    await resumed.engine.run();
    assert.equal(resumed.state.completions.length,1);
    assert.equal(readdirSync(join(root,'回复记录')).filter(x=>x.endsWith('.json')).length,1);
    assert.equal(JSON.parse(readFileSync(join(root,'会话备份/M01.json'),'utf8')).counts.turns,1);
  } finally {removeArchiveTest(root);}
});

test('已保存且完成进度后暂停退出，继续只采集后续消息',async()=>{
  const keys=[];
  const archiveReply=payload=>{keys.push(payload.completion.key);return {status:'saved'};};
  const run=setup({messages:['one','two'],engineOptions:{archiveReply},event:type=>{if(type==='message_completed')throw new Error('exit');}});
  run.state.features={captureReplies:true};await assert.rejects(run.engine.run(),/exit/);
  const resumed=setup({messages:['one','two'],adapter:run.adapter,state:clone(run.saved.at(-1)),now:run.now(),engineOptions:{archiveReply}});
  await resumed.engine.run();assert.deepEqual(keys,['S01:0','S01:1']);assert.equal(run.adapter.sends,2);
});

test('保存耗时占用已确定的30秒间隔，不在保存结束后另加30秒',async()=>{
  const run=setup({messages:['one','two']});run.state.features={captureReplies:true};
  run.engine.archiveReply=payload=>{if(payload.sequence===1)run.advance(35000);return {status:'saved'};};
  await run.engine.run();assert.equal(run.state.intervals[0].actualGapMs,35000);assert.equal(run.state.intervals[0].additionalMs,5000);
});

test('未开启采集的旧断点不会伪造旧回复，待保存正文被改变则拒绝继续',async()=>{
  const legacy=setup({engineOptions:{archiveReply:()=>{throw new Error('旧轮不应调用');}}});
  await legacy.engine.run();assert.equal(legacy.state.completions[0].replyArchive,undefined);
  const run=setup({engineOptions:{archiveReply:()=>{throw new Error('save failed');}}});run.state.features={captureReplies:true};
  await assert.rejects(run.engine.run());const state=clone(run.saved.at(-1));state.pending.replyToSave.answer='改动正文';
  const resumed=setup({state,adapter:run.adapter,engineOptions:{archiveReply:()=>{throw new Error('不应调用');}}});
  await assert.rejects(resumed.engine.run(),error=>error.code==='reply_archive_mismatch');assert.equal(run.adapter.sends,1);
});

test('开启命名后旧B仍发送54条，仅对新建会话按目标编号命名，返回不重复命名', async () => {
  const run = setup({ dataset: loadDataset('doubao-b') }), names = [];
  run.state.features = { renameConversations: true };
  run.adapter.renameConversation = async job => {
    assert.ok(run.state.completions.some(x => x.href === job.href));
    assert.ok(run.saved.at(-1).completions.length > 0);
    names.push(job.desiredName); return { title: job.desiredName };
  };
  await run.engine.run();
  const expected = run.dataset.data.steps.filter(x => x.navigation === 'new' && x.execution !== 'manual').map(x => x.target);
  assert.deepEqual(names, expected); assert.equal(new Set(names).size, names.length);
  assert.equal(run.adapter.sends, 54); assert.equal(run.state.completions.length, 54);
  assert.equal(run.state.status, 'awaiting_manual');
  assert.ok(Object.values(run.state.renameJobs).every(x => x.status === 'done'));
});

test('改名超过30秒只记额外耗时，不在改名后重新等待30秒', async () => {
  let run;
  run = setup({ messages: ['one', 'two'] }); run.state.features = { renameConversations: true };
  run.adapter.renameConversation = async () => { await run.engine.delay(35000); return { title: 'M01' }; };
  await run.engine.run();
  assert.equal(run.state.intervals[0].actualGapMs, 35000);
  assert.equal(run.state.intervals[0].additionalMs, 5000); assert.equal(run.adapter.sends, 2);
});

test('改名安全失败至多重试一次，保留警告并继续，不重发已完成消息', async () => {
  const run = setup({ messages: ['one', 'two'] }); run.state.features = { renameConversations: true }; let attempts = 0;
  run.adapter.renameConversation = async () => { attempts++; throw new RenameError('已取消编辑但标题未更新', true); };
  await run.engine.run();
  assert.equal(attempts, 2); assert.equal(run.state.renameJobs.M01.status, 'failed');
  assert.equal(run.adapter.sends, 2); assert.equal(run.state.status, 'completed');
  assert.ok(run.events.some(x => x.type === 'rename_failed'));
});

test('无法安全退出改名时暂停，恢复只处理改名，再发下一条', async () => {
  const run = setup({ messages: ['one', 'two'] }); run.state.features = { renameConversations: true };
  run.adapter.renameConversation = async () => { throw new RenameError('弹窗尚未退出', false); };
  await assert.rejects(run.engine.run(), error => error.code === 'rename_ui_unresolved');
  assert.equal(run.state.completions.length, 1); assert.equal(run.state.messageIndex, 1); assert.equal(run.adapter.sends, 1);
  const deadline = run.state.wait.deadline;
  run.adapter.renameConversation = async () => ({ title: 'M01' });
  const resumed = setup({ messages: ['one', 'two'], adapter: run.adapter, state: clone(run.saved.at(-1)), now: deadline + 1000 });
  await resumed.engine.run();
  assert.equal(run.adapter.sends, 2); assert.equal(resumed.state.renameJobs.M01.status, 'done');
  assert.equal(resumed.state.intervals[0].actualGapMs, 31000);
});

test('改名中暂停保留已完成消息，恢复继续同一任务，旧断点不会补改历史名称', async () => {
  const run = setup({ messages: ['one', 'two'] }); run.state.features = { renameConversations: true };
  run.adapter.renameConversation = async () => { throw new Interrupted('paused'); };
  await assert.rejects(run.engine.run(), Interrupted);
  assert.equal(run.state.pending, null); assert.equal(run.state.completions.length, 1);
  run.adapter.renameConversation = async () => ({ title: 'M01' });
  const resumed = setup({ messages: ['one', 'two'], adapter: run.adapter, state: clone(run.saved.at(-1)), now: run.now() });
  await resumed.engine.run(); assert.equal(run.adapter.sends, 2);
  const legacy = setup(); legacy.adapter.renameConversation = async () => { throw new Error('不应触发'); };
  await legacy.engine.run(); assert.equal(legacy.state.renameJobs, undefined);
});
test('旧B全流程模拟执行54条，每条回复后30秒，人工T17不发送', async () => {
  const run = setup({ dataset: loadDataset('doubao-b') });
  await run.engine.run();
  assert.equal(run.adapter.sends, 54); assert.equal(run.state.completions.length, 54);
  assert.equal(run.state.status, 'awaiting_manual'); assert.ok(run.state.t17);
  const ids = run.state.completions.map(x => x.key);
  assert.equal(new Set(ids).size, 54);
  for (let i = 1; i < 54; i++) assert.equal(run.state.completions[i].sendAttemptedAt - run.state.completions[i - 1].answerCompletionObservedAt, 30000);
  assert.equal(run.now(), run.state.completions.at(-1).answerCompletionObservedAt);
});
test('连通性测试仅在4个回复标记全部匹配时显示通过', async () => {
  const adapter = new Adapter();
  adapter.expectedReplies = ['CDP_V1_OK_20261028', 'CDP_V1_SECOND_OK', 'CDP_V1_OK_20261028', 'CDP_V1_RETURN_OK'];
  const run = setup({ adapter, dataset: loadDataset('smoke') }); await run.engine.run();
  assert.equal(run.state.completions.length, 4);
  assert.equal(run.state.status, 'completed'); assert.match(run.state.activity, /测试通过/);
  assert.ok(run.state.completions.every(x => x.replyMatched));
});
test('四条已执行但标记错误时不宣称通过', async () => {
  const run = setup({ dataset: loadDataset('smoke') }); await run.engine.run();
  assert.equal(run.adapter.sends, 4); assert.equal(run.state.status, 'check_failed');
  assert.ok(run.state.completions.every(x => x.replyMatched === false));
});
test('发送完成与游标、下一段等待原子保存', async () => {
  const run = setup({ messages: ['one', 'two'] }); await run.engine.run();
  const gap = run.saved.find(x => x.phase === 'gap');
  assert.equal(gap.completions.length, 1); assert.equal(gap.messageIndex, 1);
  assert.equal(gap.wait.deadline - gap.wait.startedAt, 30000);
  assert.ok(run.state.completions[1].sendAttemptedAt >= gap.wait.deadline);
});
test('发送成功后断开，重连不重发', async () => {
  const run = setup({ fault: 'after_send' }); await run.engine.run();
  assert.equal(run.adapter.sends, 1); assert.equal(run.adapter.clicks, 1);
  assert.equal(run.state.completions[0].recovered, true);
});
test('点击是否送达不明时暂停核对，禁止盲目重试', async () => {
  const run = setup({ fault: 'before_send' });
  await assert.rejects(run.engine.run(), ReviewRequired);
  assert.equal(run.adapter.clicks, 1); assert.equal(run.adapter.sends, 0);
  assert.ok(run.state.pending.attemptedAt);
});
test('发送回执落盘后进程退出，重新启动继续原回答', async () => {
  const run = setup({ event: type => { if (type === 'sent') throw new Error('模拟退出'); } });
  await assert.rejects(run.engine.run(), /模拟退出/);
  const resumed = setup({ adapter: run.adapter, state: clone(run.saved.at(-1)), now: run.now() + 120000 });
  await resumed.engine.run();
  assert.equal(run.adapter.sends, 1); assert.equal(resumed.state.completions.length, 1);
});
test('确认前退出且超过确认时限，先核对已发送消息而非直接报错重发', async () => {
  const run = setup({ event: type => { if (type === 'sent') throw new Error('exit'); } });
  await assert.rejects(run.engine.run());
  const state = clone(run.saved.findLast(x => x.pending && !x.pending.userId));
  const resumed = setup({ state, adapter: run.adapter, now: run.now() + 120000 });
  await resumed.engine.run(); assert.equal(run.adapter.sends, 1);
});
test('消息完成后退出，恢复不会再次发送已完成消息', async () => {
  const run = setup({ messages: ['one', 'two'], event: type => { if (type === 'message_completed') throw new Error('exit'); } });
  await assert.rejects(run.engine.run());
  const resumed = setup({ messages: ['one', 'two'], adapter: run.adapter, state: clone(run.saved.at(-1)), now: run.now() });
  await resumed.engine.run(); assert.equal(run.adapter.sends, 2);
  assert.deepEqual(resumed.state.completions.map(x => x.userMessageId), ['u1', 'u2']);
});
test('等待期间暂停并恢复，保留截止时间', async () => {
  let requested = null;
  const run = setup({ messages: ['one', 'two'], request: () => requested,
    event: type => { if (type === 'message_completed') requested = 'paused'; } });
  await assert.rejects(run.engine.run(), Interrupted);
  assert.equal(run.state.phase, 'gap');
  const state = clone(run.saved.at(-1));
  const resumed = setup({ messages: ['one', 'two'], adapter: run.adapter, state, now: state.wait.deadline + 10000 });
  await resumed.engine.run();
  assert.equal(resumed.state.deviations.length, 1); assert.equal(run.adapter.sends, 2);
});
test('等待回答时暂停，继续时不再次发送', async () => {
  let requested = null;
  const run = setup({ request: () => requested, event: type => { if (type === 'sent') requested = 'paused'; } });
  await assert.rejects(run.engine.run(), Interrupted);
  assert.equal(run.state.pending.userId, 'u1');
  const resumed = setup({ state: clone(run.saved.at(-1)), adapter: run.adapter, now: run.now() });
  await resumed.engine.run(); assert.equal(run.adapter.sends, 1);
});
test('开始前暂停不发送；停止信号也保留断点', async () => {
  const run = setup({ request: () => 'stopped' });
  await assert.rejects(run.engine.run(), x => x instanceof Interrupted && x.mode === 'stopped');
  assert.equal(run.adapter.sends, 0);
});
test('账号不匹配不发送', async () => {
  const run = setup(); run.state.account = 'different';
  await assert.rejects(run.engine.run(), /账号不一致/); assert.equal(run.adapter.sends, 0);
});
test('同文问题分属两个新会话，不误绑定旧会话', async () => {
  const steps = [1, 2].map(n => ({ id: `S0${n}`, target: `T0${n}`, execution: 'automatic', navigation: 'new',
    messages: [{ send_text: 'same' }], transition_actions: [] }));
  const run = setup({ steps }); await run.engine.run();
  assert.deepEqual(run.state.completions.map(x => x.href), ['/chat/1', '/chat/2']);
});
test('切换会话仍按原顺序，只等待回复后30秒，不叠加旧等待', async () => {
  const steps = [
    { id: 'S01', target: 'M01', execution: 'automatic', navigation: 'new', messages: [{ send_text: 'input' }], transition_actions: [] },
    { id: 'S02', target: 'T01', execution: 'automatic', navigation: 'new', messages: [{ send_text: 'check' }], transition_actions: [
      { action: 'wait', profile: 'short' }, { action: 'navigate_next_target' }, { action: 'wait', profile: 'short' }] },
    { id: 'S03', target: 'M01', execution: 'automatic', navigation: 'return', messages: [{ send_text: 'more' }], transition_actions: [] }
  ];
  const run = setup({ steps }); await run.engine.run();
  assert.deepEqual(run.state.completions.map(x => x.href), ['/chat/1', '/chat/2', '/chat/1']);
  assert.equal(run.state.completions[2].sendAttemptedAt - run.state.completions[1].answerCompletionObservedAt, 30000);
});

test('旧等待断点升级为回复后30秒，保持消息游标并取消旧长等待', async () => {
  const run = setup({ messages: ['one', 'two'], event: type => { if (type === 'message_completed') throw new Error('exit'); } });
  await assert.rejects(run.engine.run());
  const state = clone(run.saved.at(-1)); delete state.timingPolicy;
  state.wait.deadline = state.wait.startedAt + 600000; delete state.wait.nextPhase;
  const resumed = setup({ messages: ['one', 'two'], adapter: run.adapter, state, now: run.now() });
  await resumed.engine.run();
  assert.equal(resumed.state.completions[1].sendAttemptedAt - resumed.state.completions[0].answerCompletionObservedAt, 30000);
  assert.equal(resumed.adapter.sends, 2);
});

test('显示文字的排版空格和空行变化可确认，输入框核对仍严格', () => {
  const original = '家庭档案\n\n1998年2月8日出生，28岁。';
  const displayed = '家庭档案\n1998 年 2 月 8 日出生，28 岁。';
  assert.notEqual(normalize(original), normalize(displayed));
  const observed = findSent(snapshot('/chat/1', [user('u1', displayed)]), { text: original });
  assert.equal(observed.id, 'u1');
  assert.throws(() => findSent(snapshot('/chat/1', [user('u1', displayed.replace('28', '29'))]), { text: original }), ReviewRequired);
});

test('旧长消息已发送但未确认，升级后识别排版变化并继续，不重发', async () => {
  const original = '档案\n\n1998年2月8日，28岁。';
  const run = setup({ messages: [original, 'next'], event: type => { if (type === 'sent') throw new Error('exit'); } });
  await assert.rejects(run.engine.run());
  const state = clone(run.saved.findLast(x => x.pending && !x.pending.userId)); delete state.timingPolicy;
  run.adapter.current.sent[0].text = '档案\n1998 年 2 月 8 日，28 岁。';
  const resumed = setup({ messages: [original, 'next'], state, adapter: run.adapter, now: run.now() + 120000 });
  await resumed.engine.run();
  assert.equal(resumed.adapter.sends, 2);
  assert.equal(resumed.state.completions[0].userMessageId, 'u1');
  assert.equal(resumed.state.completions[1].sendAttemptedAt - resumed.state.completions[0].answerCompletionObservedAt, 30000);
});
test('同文历史消息不算本次新发送', () => {
  const info = snapshot('/chat/1', [user('old', 'same'), answer('a')]);
  assert.equal(findSent(info, { beforeSentId: 'old', text: 'same' }), null);
});
test('临时消息尚无服务器ID时保留发送证据，等待分配编号', () => {
  const info = snapshot('/chat/1', [user('old', 'first'), answer('a'), user(null, 'second')]);
  const observed = findSent(info, { beforeSentId: 'old', text: 'second' });
  assert.equal(observed.id, null);
  assert.equal(observed.text, 'second');
});
test('缺少锚点、额外人工输入、多回答时要求核对', () => {
  assert.throws(() => findSent(snapshot('/chat/1', [user('new', 'same')]), { beforeSentId: 'lost', text: 'same' }), ReviewRequired);
  assert.throws(() => findAnswer(snapshot('/chat/1', [user('u', 'one'), answer('a'), user('u2', 'extra')]), 'u'), ReviewRequired);
  assert.throws(() => findAnswer(snapshot('/chat/1', [user('u', 'one'), answer('a'), answer('a2')]), 'u'), ReviewRequired);
});

test('长会话卸载上一条消息时，按完整已完成编号列表核对新消息', () => {
  const pending = { href: '/chat/1', beforeSentId: 'u9', knownSentIds: ['u6', 'u7', 'u8', 'u9'], attemptedAt: 100, text: 'tenth' };
  const info = snapshot('/chat/1', [user('u10', 'tenth'), answer('a10')]);
  assert.equal(findSent(info, pending).id, 'u10');
  assert.equal(findSent(snapshot('/chat/1', [user('u9', 'previous')]), pending), null);
  assert.throws(() => findSent(info, { ...pending, attemptedAt: null }), ReviewRequired);
  assert.throws(() => findSent(info, { ...pending, knownSentIds: [] }), ReviewRequired);
});

test('虚拟列表恢复不接受旧同文消息、额外输入、错误会话和编号变化', () => {
  const pending = { href: '/chat/1', beforeSentId: 'u9', knownSentIds: ['old', 'u9'], attemptedAt: 100, text: 'same' };
  assert.equal(findSent(snapshot('/chat/1', [user('old', 'same')]), pending), null);
  assert.throws(() => findSent(snapshot('/chat/1', [user('u10', 'same'), user('extra', 'manual')]), pending), ReviewRequired);
  assert.throws(() => findSent(snapshot('/chat/2', [user('u10', 'same')]), pending), ReviewRequired);
  assert.throws(() => findSent(snapshot('/chat/1', [user('u10', 'same')]), { ...pending, userId: 'u11' }), ReviewRequired);
});

test('发送前页面只加载旧消息时先自动恢复，再核对最新位置发送', async () => {
  const adapter = new Adapter();
  const open = adapter.openKnown.bind(adapter);
  adapter.openKnown = async href => adapter.sends === 2 && !adapter.blocked
    ? (adapter.blocked = true, snapshot(href, [user('u1', 'one'), answer('a1')])) : open(href);
  // The first open after send #2 is its confirmation; return the stale view only
  // after its completion, at the preparation of message #3.
  adapter.blocked = true;
  const run = setup({ adapter, messages: ['one', 'two', 'three'],
    event: type => { if (type === 'message_completed' && adapter.sends === 2) adapter.blocked = false; } });
  await run.engine.run();
  assert.equal(adapter.sends, 3); assert.equal(run.state.completions.length, 3);
  assert.ok(run.events.some(x => x.type === 'recovering'));
});

test('发送证据延迟45秒出现时自动等待，不在30秒暂停或重发', async () => {
  const adapter = new Adapter(), read = adapter.restore.bind(adapter);
  const run = setup({ adapter, engineOptions: { confirmMs: 90000 } });
  adapter.observe = async (pending, navigation) => run.now() - pending.attemptedAt < 45000 ? null : read(pending, navigation);
  await run.engine.run();
  assert.equal(adapter.sends, 1); assert.equal(adapter.clicks, 1);
  assert.equal(run.state.completions[0].sendConfirmedAt - run.state.completions[0].sendAttemptedAt, 45000);
});

test('AI思考60秒且用户节点卸载时保持已发送，结束后才开始30秒间隔', async () => {
  const adapter = new Adapter(), read = adapter.restore.bind(adapter);
  const run = setup({ adapter, messages: ['one', 'two'], engineOptions: { confirmMs: 90000 } });
  adapter.observe = async (pending, navigation) => {
    const actual = await read(pending, navigation);
    if (pending.messageIndex !== 0) return actual;
    const age = run.now() - pending.attemptedAt;
    const a = { ...answer('a1'), thinking: age < 60000 };
    const info = snapshot('/chat/1', pending.userId ? [a] : [user('u1', 'one'), a]);
    return { ...info, busy: age < 60000, thinking: age < 60000 };
  };
  await run.engine.run();
  const first = run.state.completions[0];
  assert.ok(first.answerCompletionObservedAt - first.sendAttemptedAt >= 63000);
  assert.equal(run.state.completions[1].sendAttemptedAt - first.answerCompletionObservedAt, 30000);
  const sentIndex = run.events.findIndex(x => x.type === 'sent');
  const completedIndex = run.events.findIndex(x => x.type === 'message_completed');
  assert.ok(!run.events.slice(sentIndex + 1, completedIndex).some(x => x.type === 'observation' && x.details.stage === 'confirming_send'));
  assert.equal(adapter.clicks, 2);
});

test('稳定文字没有结束标记时不提前完成或开始间隔', async () => {
  const adapter = new Adapter(), read = adapter.restore.bind(adapter);
  const run = setup({ adapter });
  adapter.observe = async (pending, navigation) => {
    await read(pending, navigation);
    return snapshot('/chat/1', [user('u1', 'hello'), { ...answer('a1'), explicitComplete: run.now() - pending.attemptedAt >= 20000 }]);
  };
  await run.engine.run();
  assert.ok(run.state.completions[0].answerCompletionObservedAt - run.state.completions[0].sendAttemptedAt >= 23000);
});

test('已发送回答超时提示回答未结束，不退回发送未确认', async () => {
  const adapter = new Adapter();
  const run = setup({ adapter, engineOptions: { responseMs: 6000 } });
  adapter.observe = async () => ({ ...snapshot('/chat/1', [user('u1', 'hello')]), thinking: true, busy: true });
  await assert.rejects(run.engine.run(), error => error.code === 'reply_timeout' && /消息已发送/.test(error.message));
  assert.equal(run.state.pending.userId, 'u1'); assert.equal(adapter.clicks, 1);
});

test('继续旧发送断点时有新的核对窗口，短暂读不到消息不会立即超时', async () => {
  const original = setup({ event: type => { if (type === 'sent') throw new Error('exit'); } });
  await assert.rejects(original.engine.run());
  const state = clone(original.saved.findLast(x => x.pending && !x.pending.userId));
  let reads = 0;
  original.adapter.observe = async (pending, navigation) => ++reads <= 3 ? null : original.adapter.restore(pending, navigation);
  const resumed = setup({ state, adapter: original.adapter, now: original.now() + 3600000 });
  await resumed.engine.run();
  assert.equal(resumed.adapter.clicks, 1); assert.equal(resumed.state.completions.length, 1);
});

test('已确认发送后的持续断连共用恢复上限，不重置预算或重发', async () => {
  const adapter = new Adapter(), read = adapter.restore.bind(adapter);
  const run = setup({ adapter, engineOptions: { reconnectMs: null, recoveryMs: 7000 } });
  adapter.observe = async (pending, navigation) => {
    if (pending.userId) throw new ConnectionError('持续断连');
    return read(pending, navigation);
  };
  await assert.rejects(run.engine.run(), error => error instanceof ReviewRequired && /消息已发送/.test(error.message));
  assert.equal(adapter.clicks, 1); assert.equal(run.state.pending.userId, 'u1');
  assert.ok(run.now() - run.state.pending.confirmedAt <= 9000);
});

test('读取暂时失败可恢复，明确额外输入立即暂停', async () => {
  const adapter = new Adapter(), read = adapter.restore.bind(adapter); let failed = false;
  const run = setup({ adapter });
  adapter.observe = async (pending, navigation) => {
    if (pending.userId && !failed) { failed = true; throw new PageNotReady('回答暂未加载', 'answer_loading'); }
    return read(pending, navigation);
  };
  await run.engine.run(); assert.equal(adapter.clicks, 1);
  assert.equal(run.state.completions[0].completionTimeUncertain, true);
  const unsafe = setup();
  unsafe.adapter.observe = async () => snapshot('/chat/1', [user('u1', 'hello'), answer('a1'), user('manual', 'extra')]);
  await assert.rejects(unsafe.engine.run(), ReviewRequired);
  assert.ok(!unsafe.events.some(x => x.type === 'recovering')); assert.equal(unsafe.adapter.clicks, 1);
});

test('测评间隔截止前恢复只等剩余部分，120秒间隔不被恢复操作改写', async () => {
  const original = setup({ messages: ['one', 'two'], event: type => { if (type === 'message_completed') throw new Error('exit'); } });
  original.state.timingPolicy = { id: 'reply_then_30s_v1', replyGapMs: 120000, overridesSourceWaits: true };
  await assert.rejects(original.engine.run());
  const state = clone(original.saved.at(-1)), deadline = state.wait.deadline;
  const resumed = setup({ messages: ['one', 'two'], state, adapter: original.adapter, now: state.wait.startedAt + 10000 });
  await resumed.engine.run();
  assert.equal(resumed.state.completions[1].sendAttemptedAt, deadline);
  assert.equal(resumed.state.intervals[0].actualGapMs, 120000);
});

test('截止后会话准备发生恢复时不追加一轮间隔，并记录实际额外耗时', async () => {
  const adapter = new Adapter(), open = adapter.openKnown.bind(adapter); let failures = 0;
  const run = setup({ adapter, messages: ['one', 'two'] });
  adapter.openKnown = async href => {
    if (run.state.completions.length === 1 && failures++ < 2) throw new PageNotReady('历史加载中');
    return open(href);
  };
  await run.engine.run();
  assert.equal(run.state.intervals[0].actualGapMs, 33000);
  assert.equal(run.state.intervals[0].additionalMs, 3000);
  assert.equal(run.state.deviations.filter(x => x.type === 'interval_extended').length, 1);
});

test('新建会话后断连只恢复查找，不重复点击新建按钮', async () => {
  const adapter = new Adapter(), prepare = adapter.prepareNew.bind(adapter); let clicks = 0, restores = 0, nav;
  adapter.prepareNew = async (account, { onIntent }) => {
    nav = await prepare(account); clicks++; onIntent(nav); throw new ConnectionError('新页面加载时断连');
  };
  adapter.recoverNew = async () => { restores++; return nav; };
  const run = setup({ adapter }); await run.engine.run();
  assert.equal(clicks, 1); assert.equal(restores, 1); assert.equal(adapter.sends, 1);
});

test('当前用户消息暂时卸载时不把历史回答认作本条回答', async () => {
  const adapter = new Adapter(), read = adapter.restore.bind(adapter);
  const run = setup({ adapter, messages: ['one', 'two'] });
  adapter.observe = async (pending, navigation) => {
    const actual = await read(pending, navigation);
    if (pending.messageIndex === 0) return actual;
    const age = run.now() - pending.attemptedAt;
    if (!pending.userId) return snapshot('/chat/1', [user('u1', 'one'), answer('a1'), user('u2', 'two')]);
    return age < 20000 ? snapshot('/chat/1', [user('u1', 'one'), answer('a1')]) : snapshot('/chat/1', [answer('a2')]);
  };
  await run.engine.run();
  const last = run.state.completions.at(-1);
  assert.equal(last.answerMessageId, 'a2');
  assert.ok(last.answerCompletionObservedAt - last.sendAttemptedAt >= 23000);
});

test('修复旧断点错误的历史锚点，识别已发送当前条，不重发', async () => {
  const messages = ['one', 'two', 'three', 'four'];
  const adapter = new Adapter();
  const run = setup({ adapter, messages, event: type => { if (type === 'sent' && adapter.sends === 4) throw new Error('exit'); } });
  await assert.rejects(run.engine.run());
  const state = clone(run.saved.findLast(x => x.pending && !x.pending.userId));
  state.pending.beforeSentId = 'u1'; delete state.pending.knownSentIds;
  adapter.current = snapshot('/chat/1', [user('u4', 'four'), answer('a4')]);
  adapter.chats.set('/chat/1', adapter.current);
  const resumed = setup({ messages, adapter, state, now: run.now() + 120000 });
  await resumed.engine.run();
  assert.equal(adapter.sends, 4); assert.equal(resumed.state.completions.length, 4);
  assert.ok(resumed.events.some(x => x.type === 'message_anchor_restored' && x.details.previousId === 'u1' && x.details.beforeSentId === 'u3'));
});

test('原生路由地址先更新而内容仍为上一会话时等待，不误报人工输入', async () => {
  const steps = [
    { id: 'S01', target: 'M01', execution: 'automatic', navigation: 'new', messages: [{ send_text: 'one' }], transition_actions: [] },
    { id: 'S02', target: 'T01', execution: 'automatic', navigation: 'new', messages: [{ send_text: 'two' }], transition_actions: [] },
    { id: 'S03', target: 'M01', execution: 'automatic', navigation: 'return', messages: [{ send_text: 'three' }], transition_actions: [] }
  ];
  const adapter = new Adapter(), open = adapter.openKnown.bind(adapter); let stale = false;
  const run = setup({ adapter, steps }); run.dataset.total = 3;
  adapter.openKnown = async href => {
    if (run.state.stepIndex === 2 && run.state.phase === 'messages' && !run.state.pending && !stale) {
      stale = true; return snapshot(href, [user('u2', 'two'), answer('a2')]);
    }
    return open(href);
  };
  await run.engine.run();
  assert.equal(adapter.sends, 3);
  assert.ok(run.events.some(x => x.type === 'recovering' && x.details.code === 'conversation_content_loading'));
  assert.deepEqual(run.state.completions.map(x => x.href), ['/chat/1', '/chat/2', '/chat/1']);
});

test('未匹配的新会话原页面只用于诊断，不能把/chat保存为已发送地址', async () => {
  const adapter = new Adapter(), read = adapter.restore.bind(adapter);
  const run = setup({ adapter });
  adapter.observe = async (pending, navigation) => run.now() - pending.attemptedAt < 3000
    ? { ...snapshot('/chat', [user('local', 'hello')]), inputText: 'hello', matchedConversation: false, observationScope: 'unmatched_new' }
    : read(pending, navigation);
  await run.engine.run();
  assert.equal(run.state.completions[0].href, '/chat/1');
  assert.ok(!run.saved.some(x => x.pending?.userId && x.pending.href === '/chat'));
  assert.ok(run.events.some(x => x.type === 'observation' && x.details.page?.draftLength === 5));
  assert.equal(adapter.clicks, 1);
});

test('发送前日志使用输入后的新快照，而非输入前空草稿', async () => {
  const adapter = new Adapter(), fill = adapter.fill.bind(adapter);
  adapter.fill = async text => { await fill(text); return { ...adapter.current, inputText: text, sendReady: true }; };
  const run = setup({ adapter }); await run.engine.run();
  const intent = run.events.find(x => x.type === 'observation' && x.details.stage === 'confirming_send');
  assert.equal(intent.details.page.draftLength, 5); assert.equal(intent.details.page.sendReady, true);
});

test('新会话没有正式地址和编号时，红色感叹号立即暂停而非等90秒', async () => {
  const adapter = new Adapter();
  adapter.observe = async () => ({ ...snapshot('/chat', [{ ...user(null, 'hello'), failed: true }]),
    matchedConversation: false, observationScope: 'unmatched_new', pendingPage: true });
  const run = setup({ adapter });
  await assert.rejects(run.engine.run(), error => error.code === 'platform_send_failed');
  assert.equal(run.state.pending.userId, null);
  assert.equal(run.state.pending.deliveryFailure.marker, 'message_box_failed_icon');
  assert.equal(run.state.completions.length, 0); assert.equal(adapter.clicks, 1);
  assert.equal(run.now(), run.state.pending.attemptedAt);
});

test('处理原失败消息后继续，只核对原消息，不再触发发送', async () => {
  const adapter = new Adapter(), read = adapter.restore.bind(adapter);
  let failing = true;
  adapter.observe = async (pending, nav) => {
    const info = await read(pending, nav);
    return failing ? snapshot('/chat/1', [{ ...user('u1', 'hello'), failed: true }]) : info;
  };
  const run = setup({ adapter }); await assert.rejects(run.engine.run(), error => error.code === 'platform_send_failed');
  failing = false;
  const resumed = setup({ adapter, state: clone(run.saved.at(-1)), now: run.now() + 60000 });
  await resumed.engine.run();
  assert.equal(adapter.clicks, 1); assert.equal(resumed.state.completions.length, 1);
  assert.ok(!resumed.state.pending);
});

test('AI回答出现失败标志时暂停，不计完成也不进入下一条', async () => {
  const adapter = new Adapter();
  adapter.observe = async () => snapshot('/chat/1', [user('u1', 'hello'), { ...answer('a1'), failed: true }]);
  const run = setup({ adapter });
  await assert.rejects(run.engine.run(), error => error.code === 'platform_reply_failed');
  assert.equal(run.state.pending.userId, 'u1'); assert.equal(run.state.completions.length, 0);
  assert.equal(adapter.clicks, 1);
});
