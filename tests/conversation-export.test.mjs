import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, readdirSync, readFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CURRENT_LOADED_SNAPSHOT, buildConversationExport, conversationMarkdown, exportCurrentLoaded } from '../core/conversation-export.mjs';
import { Controller } from '../server.mjs';

const user={role:'user',id:'u1',text:'第一条问题\n保留换行',failed:false};
const reply={role:'assistant',id:'a1',text:'回答\n'+('完整正文 '.repeat(1000)),failed:false,streaming:false,explicitComplete:true};
const snapshot=(extra={})=>({url:'chrome://doubao-chat/chat/123',title:'M01',account:'test-account',dialogue:true,
  busy:false,thinking:false,ordered:structuredClone([user,reply]),...extra});
const metadata={account:'test-account',targetId:'page',exportedAt:'2026-10-30T04:00:00.000Z',exportId:'test'};
function cleanup(root) {
  const absolute=resolve(root),prefix=resolve(tmpdir(),'doubao-export-');
  if(!absolute.startsWith(prefix))throw new Error('Unexpected cleanup path');
  function remove(directory) {
    if(directory!==absolute&&!directory.startsWith(absolute+'\\'))throw new Error('Cleanup escaped test directory');
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      const p=join(directory,entry.name); if(entry.isDirectory())remove(p);else unlinkSync(p);
    }
    rmdirSync(directory);
  }
  remove(absolute);
}
function setup(overrides={}) {
  const root=overrides.root||mkdtempSync(join(tmpdir(),'doubao-export-'));
  const calls=[], snapshots=overrides.snapshots||[snapshot(),snapshot()];let reads=0,closed=0;
  const options={root,port:9223,expectedAccount:'test-account',clock:()=>1793332800000,
    // Real desktop target list uses doubao:, while Runtime location is chrome:.
    list:async port=>{assert.equal(port,9223);return [{id:'page',url:'doubao://doubao-chat/chat/123'}];},
    connectTo:async target=>({evaluate:async expression=>{
      assert.equal(target.id,'page');assert.equal(expression,CURRENT_LOADED_SNAPSHOT);calls.push('read');return snapshots[reads++];
    },close:()=>closed++}),delay:async()=>{},...overrides};
  delete options.snapshots;
  return {root,calls,run:()=>exportCurrentLoaded(options),closed:()=>closed};
}

test('提取保留超过2000字符的完整正文、角色和顺序，不把采集时间当平台时间',()=>{
  const record=buildConversationExport(snapshot(),metadata);
  assert.equal(record.messages[1].text,reply.text);assert.ok(record.messages[1].text.length>2000);
  assert.deepEqual(record.messages.map(m=>[m.sequence,m.role,m.messageId]),[[1,'user','u1'],[2,'assistant','a1']]);
  assert.equal(record.scope,'currently_loaded_messages');assert.equal(record.historyCompleteness,'not_verified');
  assert.equal(record.messages[0].createdAt,undefined);
});

test('Markdown保留长正文和代码围栏，并明确只含已加载内容',()=>{
  const info=snapshot(); info.ordered[1].text='  缩进\n```js\nconst a=1;\n```\n结尾  ';
  const record=buildConversationExport(info,metadata),md=conversationMarkdown(record);
  assert.ok(md.includes(info.ordered[1].text));assert.ok(md.includes('````text'));
  assert.match(md,/历史完整性：未验证/);assert.ok(md.indexOf('## 1. 用户')<md.indexOf('## 2. 豆包'));
});

test('无编号、失败标记和无文字附件不静默丢失，不误报完整',()=>{
  const info=snapshot();info.ordered.push({role:'assistant',id:null,text:'',failed:true});
  const record=buildConversationExport(info,metadata);
  assert.equal(record.counts.total,3);assert.equal(record.messages[2].failed,true);
  assert.equal(record.messages[2].messageId,null);assert.ok(record.warnings.some(x=>x.includes('没有平台消息编号')));
  assert.ok(record.warnings.some(x=>x.includes('没有可读取的文字')));
});

test('账号、页面、消息编号不可靠时不创建导出',()=>{
  assert.throws(()=>buildConversationExport(snapshot({account:'another-account'}),metadata),/账号/);
  assert.throws(()=>buildConversationExport(snapshot({url:'chrome://doubao-chat/chat'}),metadata),/已有/);
  assert.throws(()=>buildConversationExport(snapshot({url:'https://www.doubao.com/chat/123'}),metadata),/已有/);
  assert.throws(()=>buildConversationExport(snapshot({ordered:[user,{...reply,id:'u1'}]}),metadata),/重复/);
});

test('同一次纯读取保存JSON与Markdown；重复点击另存，不覆盖之前内容',async()=>{
  const run=setup();
  try {
    const result=await run.run();
    const json=JSON.parse(readFileSync(join(result.directory,'conversation.json'),'utf8'));
    assert.equal(json.messages[1].text,reply.text);assert.equal(result.total,2);
    assert.equal(run.closed(),1);assert.deepEqual(run.calls,['read','read']);
    assert.ok(readFileSync(join(result.directory,'conversation.md'),'utf8').includes(reply.text));
    assert.equal(readdirSync(join(run.root,'对话导出')).filter(x=>x.startsWith('.partial')).length,0);
    const second=setup({root:run.root});
    const next=await second.run();assert.notEqual(next.directory,result.directory);assert.ok(existsSync(result.directory));
  } finally {cleanup(run.root);}
});

test('桌面调试地址与页面内部地址协议可不同，chrome与doubao组合均保留正确会话',async()=>{
  for(const targetScheme of ['chrome','doubao'])for(const pageScheme of ['chrome','doubao']) {
    const info=snapshot({url:`${pageScheme}://doubao-chat/chat/123`});
    const run=setup({snapshots:[info,structuredClone(info)],list:async()=>[{id:'page',url:`${targetScheme}://doubao-chat/chat/123`}]});
    try {
      const result=await run.run(),saved=JSON.parse(readFileSync(join(result.directory,'conversation.json'),'utf8'));
      assert.equal(saved.source.url,info.url);assert.equal(saved.source.conversationId,'123');assert.equal(saved.counts.total,2);
    } finally {cleanup(run.root);}
  }
});

test('协议兼容不放宽网站与页面范围，不连接网页、其他主机或设置页面',async()=>{
  for(const url of ['https://www.doubao.com/chat/123','https://doubao-chat/chat/123','doubao://other-host/chat/123',
    'doubao://doubao-chat.fake/chat/123','doubao://doubao-chat/settings']) {
    const run=setup({list:async()=>[{id:'page',url}],connectTo:()=>{throw new Error('不应连接');}});
    try {await assert.rejects(run.run(),/没有找到/);assert.equal(existsSync(join(run.root,'对话导出')),false);}
    finally {cleanup(run.root);}
  }
});

test('页面正在思考或生成时拒绝导出，不保存半段回答',async()=>{
  for(const info of [snapshot({busy:true}),snapshot({thinking:true}),snapshot({ordered:[user,{...reply,streaming:true}]})]) {
    const run=setup({snapshots:[info]});
    try {await assert.rejects(run.run(),/思考或生成/);assert.equal(existsSync(join(run.root,'对话导出')),false);assert.equal(run.closed(),1);}
    finally {cleanup(run.root);}
  }
});

test('两次读取间切换会话或正文变化时拒绝保存，原连接仍释放',async()=>{
  for(const info of [snapshot({url:'chrome://doubao-chat/chat/456'}),snapshot({ordered:[user,{...reply,text:'changed'}]})]) {
    const run=setup({snapshots:[snapshot(),info]});
    try {await assert.rejects(run.run(),/正在变化/);assert.equal(existsSync(join(run.root,'对话导出')),false);assert.equal(run.closed(),1);}
    finally {cleanup(run.root);}
  }
});

test('多个桌面对话目标或未核验账号时不猜测目标、不连接',async()=>{
  const run=setup({list:async()=>[{id:'a',url:'chrome://doubao-chat/chat/1'},{id:'b',url:'chrome://doubao-chat/chat/2'}],
    connectTo:()=>{throw new Error('不应连接');}});
  try {await assert.rejects(run.run(),/多个/);}
  finally {cleanup(run.root);}
  const noAccount=setup({expectedAccount:''});
  try {await assert.rejects(noAccount.run(),/检查连接/);}
  finally {cleanup(noAccount.root);}
});

test('导出不改变执行游标、等待时间、完成记录或运行事件；执行中拒绝提取',async()=>{
  const root=mkdtempSync(join(tmpdir(),'doubao-export-'));
  try {
    const controller=new Controller(root);
    controller.state={phase:'gap',messageIndex:1,wait:{deadline:999999},completions:[{key:'done'}]};
    const before=structuredClone(controller.state);
    await controller.exportLoaded({port:9223,account:'test-account'},async opts=>{
      assert.equal(opts.root,root);assert.equal(opts.expectedAccount,'test-account');return {total:2};
    });
    assert.deepEqual(controller.state,before);assert.deepEqual(controller.logs,[]);
    controller.active=true;
    await assert.rejects(controller.exportLoaded({},()=>{throw new Error('不应调用');}),/先暂停/);
  } finally {cleanup(root);}
});

test('实际页面提取表达式不截断或删去正文首尾空格，不执行页面操作',()=>{
  const long='  首行\n'+('正文'.repeat(2000))+'\n末尾  ';
  const part={innerText:long,getAttribute:name=>name==='data-streaming'?'false':null};
  const root={getAttribute:name=>name==='data-testid'?'receive_message':null,
    querySelector:selector=>selector==='[data-testid="message_content"]'?{getAttribute:()=> 'a1'}:null,
    querySelectorAll:selector=>selector==='[data-testid="message_text_content"]'?[part]:[]};
  const document={title:'M01',visibilityState:'hidden',querySelector:()=>null,getElementById:()=>null,
    querySelectorAll:selector=>selector.includes('send_message')?[root]:[]};
  const value=vm.runInNewContext(CURRENT_LOADED_SNAPSHOT,{document,location:{href:'chrome://doubao-chat/chat/123',pathname:'/chat/123'}});
  assert.equal(value.ordered[0].text,long);assert.equal(value.title,'M01');
});
