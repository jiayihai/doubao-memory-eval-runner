import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,copyFileSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,readdirSync } from 'node:fs';
import { resolve,join,sep,basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectDatasetFile } from '../tools/spreadsheets/preview-worker.mjs';
import { compileExcelDataset,freezeExcelDataset,loadExcelDataset } from '../core/excel-dataset.mjs';
import { ExcelEngine,ManualStepRequired } from '../core/excel-engine.mjs';
import { excelArchive,collectExcelResultInput,generateExcelResults,publishResultCopy,runExcelResultWorker } from '../core/excel-output.mjs';
import { manualStepDetails,commitManualResult } from '../core/manual-results.mjs';
import { hash,saveJSON,Interrupted } from '../core/store.mjs';
import { Controller } from '../server.mjs';

const project=fileURLToPath(new URL('..',import.meta.url));
const shortFile=resolve(project,'examples/short-flow.xlsx');
const xlsxIntegration=process.env.DOUBAO_XLSX_TESTS==='1';
const cache=new Map();
const readPreview=file=>{if(!cache.has(file)){
  if(!xlsxIntegration&&file===shortFile){const fixture=JSON.parse(readFileSync(resolve(project,'examples/short-flow.preview.json'),'utf8'));
    const bytes=readFileSync(file);assert.equal(hash(bytes),fixture.inputSha256,'样例与纯核心测试夹具不同步');
    cache.set(file,{...fixture,file:{path:file,name:basename(file),sha256:hash(bytes),size:bytes.length}});
  }else cache.set(file,inspectDatasetFile(file));
}return cache.get(file);};
function scratch(t){const base=mkdtempSync(join(tmpdir(),'doubao-excel-run-'));t.after(()=>{const p=resolve(base);assert.ok(p.startsWith(resolve(tmpdir())+sep)&&basename(p).startsWith('doubao-excel-run-'));rmSync(p,{recursive:true});});return base;}
const snapshot=(href='/chat',ordered=[])=>({url:'chrome://doubao-chat'+href,ordered,sent:ordered.filter(m=>m.role==='user'),received:ordered.filter(m=>m.role==='assistant'),inputText:'',busy:false});
class Adapter{
  constructor(){this.chats=new Map();this.current=snapshot();this.client={target:{id:'page'}};this.sends=[];this.names=[];}
  close(){}
  async verifyAccount(account){if(account!=='account-A')throw new Error('账号不匹配');return this.current;}
  async prepareNew(){const beforeHrefs=[...this.chats.keys()];this.current=snapshot();return {targetId:'page',beforeHrefs};}
  async restoreUnsent(){return this.current;}
  async openKnown(href){this.current=this.chats.get(href);if(!this.current)throw new Error('chat missing');return this.current;}
  async restore(pending){return pending.href?this.openKnown(pending.href):this.current;}
  async fill(text){this.draft=text;return this.current;}
  async send(){let href=new URL(this.current.url).pathname;if(href==='/chat')href='/chat/'+(this.chats.size+1);
    const n=this.sends.length+1;this.sends.push({text:this.draft,href});
    this.current=snapshot(href,[...this.current.ordered,{id:'u'+n,text:this.draft,role:'user'},
      {id:'a'+n,text:'自动完整回复'+n,role:'assistant',streaming:false,explicitComplete:true}]);this.chats.set(href,this.current);return {clicked:true};}
  async renameConversation(job){this.names.push(job.desiredName);return {title:job.desiredName};}
}
async function setup(t,file=shortFile){
  const base=scratch(t),sourceDir=join(base,'source'),directory=join(base,'runs','excel-test');mkdirSync(sourceDir,{recursive:true});mkdirSync(directory,{recursive:true});
  const source=join(sourceDir,basename(file));copyFileSync(file,source);
  const original=await readPreview(file),report=structuredClone(original);report.file.path=source;
  const dataset=compileExcelDataset(report);freezeExcelDataset(directory,report,dataset);
  const state={runId:'excel-test',datasetId:'excel',datasetHash:dataset.fingerprint,account:'account-A',purpose:'technical_regression',
    features:{captureReplies:true,renameConversations:true,autoGenerateResults:true},createdAt:1793428910000,
    phase:'navigation',status:'running',stepIndex:0,messageIndex:0,transitionIndex:0,navigation:null,pending:null,wait:null,
    conversations:{},completions:[],manualResults:{},identityAccounts:{[dataset.data.automatic_identity]:'account-A'},deviations:[],renameJobs:{}};
  let now=1793428910000,request=null;const adapter=new Adapter(),events=[];
  const make=()=>new ExcelEngine({dataset,adapter,state,clock:()=>now,delay:async ms=>{now+=ms;},request:()=>request,
    save:s=>saveJSON(join(directory,'state.json'),s),event:(type,message,details)=>{events.push({type,message,details,at:now});},
    archiveReply:excelArchive({directory,state,dataset}),confirmMs:5000,responseMs:10000,recoveryMs:5000});
  saveJSON(join(directory,'state.json'),state);
  return {base,sourceDir,source,directory,report,dataset,state,adapter,events,make,now:()=>now,advance:ms=>{now+=ms;},request:mode=>{request=mode;}};
}
function submit(run,{skip=false,reason='PRECONDITION_UNMET: 测试跳过'}={}){
  const details=manualStepDetails(run.state,run.dataset,run.now());
  if(details.readyAt>run.now())run.advance(details.readyAt-run.now());
  return commitManualResult({directory:run.directory,state:run.state,dataset:run.dataset,now:run.now(),
    options:{stepId:details.stepId,answer:'人工首次完整回复 '+details.stepId,account:details.independentIdentity?'account-B':'account-A',confirmed:true,skip,reason}});
}
test('通用短表按原文发送、按2/3秒等待，会话新建返回后停在人工节点',async t=>{
  const r=await setup(t);await assert.rejects(r.make().run(),ManualStepRequired);
  assert.equal(r.adapter.sends.length,4);assert.deepEqual(r.adapter.sends.map(m=>m.text),r.dataset.data.steps.slice(0,4).map(s=>s.messages[0].send_text));
  assert.equal(r.adapter.sends[0].href,r.adapter.sends[1].href);assert.notEqual(r.adapter.sends[2].href,r.adapter.sends[0].href);assert.equal(r.adapter.sends[3].href,r.adapter.sends[0].href);
  assert.deepEqual(r.adapter.names,['M0','T01']);assert.equal(r.state.phase,'manual');assert.equal(r.state.stepIndex,4);
  assert.deepEqual(r.state.intervals.map(i=>i.actualGapMs),[2000,3000,2000]);
  assert.equal(r.state.completions.length,4);assert.ok(existsSync(join(r.directory,'身份/A/会话备份/M0.md')));
});
test('人工保存后恢复自动，计入人工处理和不确定时间，不伪造消息ID',async t=>{
  const r=await setup(t);await assert.rejects(r.make().run(),ManualStepRequired);
  const manual=submit(r);assert.equal(manual.scope,'operator_entered_reply');assert.equal(manual.userMessageId,undefined);
  assert.equal(r.state.phase,'gap');assert.equal(r.state.status,'paused');assert.equal(r.adapter.sends.length,4);
  await r.make().run();assert.equal(r.adapter.sends.length,5);assert.equal(r.state.status,'completed');
  assert.equal(r.state.completions.length+Object.keys(r.state.manualResults).length,6);
  assert.equal(r.state.intervals.at(-1).source,'manual_confirmation');assert.equal(r.state.intervals.at(-1).actualGapMs,2000);
  const input=collectExcelResultInput(r);assert.equal(input.records.length,6);assert.equal(input.records.filter(x=>x.source==='manual_entry').length,1);
});
test('同样的读取器直接运行另一个66行文件，无需把它的消息写入脚本',{skip:!xlsxIntegration},async t=>{
  const file=resolve(project,'examples/optional/long-flow.xlsx');if(!existsSync(file))return t.skip('可选的新表不存在');
  const r=await setup(t,file);await assert.rejects(r.make().run(),ManualStepRequired);
  assert.equal(r.adapter.sends.length,60);assert.equal(r.state.completions.length,60);assert.equal(r.state.stepIndex,60);
  assert.deepEqual(r.adapter.sends.map(m=>m.text),r.report.steps.filter(s=>s.mode==='AUTO').map(s=>s.content));
  assert.equal(r.adapter.names.length,25);assert.ok(r.state.intervals.some(i=>i.plannedGapMs===300000));
  while(r.state.stepIndex<r.dataset.total)submit(r,{skip:r.state.stepIndex===65});
  assert.equal(r.state.phase,'finished');assert.equal(Object.keys(r.state.manualResults).length,6);
  const input=collectExcelResultInput(r);assert.equal(input.records.length,66);assert.equal(input.records.filter(x=>x.status==='跳过').length,1);
});
test('文件快照固定，原文件后续变化不会改写本轮发送，快照损坏拒绝恢复',async t=>{
  const r=await setup(t),before=r.dataset.fingerprint;writeFileSync(r.source,'original file was changed externally');
  assert.equal(loadExcelDataset(r.directory,r.state).fingerprint,before);
  writeFileSync(join(r.directory,'输入测评集.xlsx'),'damaged');assert.throws(()=>loadExcelDataset(r.directory,r.state),/快照校验失败/);
});
test('只允许一个自动身份，人工账号和消息不进入自动发送器',async t=>{
  const r=await setup(t),report=structuredClone(r.report);report.steps[1].identityId='B';assert.throws(()=>compileExcelDataset(report),/一个自动账号/);
  await assert.rejects(r.make().run(),ManualStepRequired);assert.equal(r.adapter.sends.length,4);
  const d=manualStepDetails(r.state,r.dataset,r.now());assert.throws(()=>commitManualResult({...r,now:r.now(),options:{stepId:d.stepId,confirmed:true,answer:'',account:'account-A'}}),/完整回复/);
});
test('暂停后的等待沿用原截止时间，恢复不重发已保存消息',async t=>{
  const r=await setup(t),engine=r.make();const event=engine.event;
  engine.event=(...args)=>{event(...args);if(args[0]==='message_completed'&&r.state.completions.length===1)r.request('paused');};
  await assert.rejects(engine.run(),Interrupted);const deadline=r.state.wait.deadline;r.advance(1000);r.request(null);
  await assert.rejects(r.make().run(),ManualStepRequired);assert.equal(r.state.intervals[0].earliestSendAt,deadline);assert.equal(r.state.intervals[0].actualGapMs,2000);assert.equal(r.adapter.sends.length,4);
});
test('人工重复保存复用已落盘记录的确认时间，跳过不伪造回答',async t=>{
  const r=await setup(t);await assert.rejects(r.make().run(),ManualStepRequired);const prior=structuredClone(r.state),first=submit(r);
  Object.keys(r.state).forEach(k=>delete r.state[k]);Object.assign(r.state,prior);r.advance(5000);const again=submit(r);assert.equal(first.confirmedAt,again.confirmedAt);
  const skipped=await setup(t);await assert.rejects(skipped.make().run(),ManualStepRequired);const rec=submit(skipped,{skip:true});assert.equal(rec.status,'跳过');assert.equal(rec.answer,'');
});
test('人工未经产品核验的会话不被自动续写，不能盲目接受额外消息',async t=>{
  const r=await setup(t);await assert.rejects(r.make().run(),ManualStepRequired);submit(r);
  r.dataset.data.steps[5].target=r.dataset.data.steps[4].target;
  await assert.rejects(r.make().run(),e=>e.code==='manual_conversation_unverified');assert.equal(r.adapter.sends.length,4);
});
test('双份结果从同一文件复制，复制失败只补存而不再调用回填器',async t=>{
  const root=scratch(t),directory=join(root,'run'),sourceDir=join(root,'not-created');mkdirSync(directory);
  let calls=0;const file=join(directory,'豆包_结果.xlsx');writeFileSync(file,'same workbook bytes');
  const input={directory,sourcePath:join(sourceDir,'input.xlsx'),signature:'signature-1',run:{id:'run'}};
  const worker=async()=>{calls++;return {file,resultHash:hash(readFileSync(file))};};
  const first=await generateExcelResults(input,worker);assert.equal(first.copyStatus,'failed');assert.ok(existsSync(file));
  mkdirSync(sourceDir);const second=await generateExcelResults(input,worker);assert.equal(second.copyStatus,'saved');assert.equal(calls,1);
  assert.deepEqual(readFileSync(file),readFileSync(second.sourceFile));
  writeFileSync(second.sourceFile,'user-edited');const conflict=await publishResultCopy(second,input);assert.equal(conflict.copyStatus,'failed');assert.equal(readFileSync(second.sourceFile,'utf8'),'user-edited');
});
test('真实Excel回填按步骤和问题ID，原表与快照保留，两处结果字节一致',{skip:!xlsxIntegration},async t=>{
  const r=await setup(t);await assert.rejects(r.make().run(),ManualStepRequired);submit(r);await r.make().run();
  const input=collectExcelResultInput(r),before=hash(readFileSync(r.source)),frozen=hash(readFileSync(input.template));
  const result=await generateExcelResults(input);assert.equal(result.savedReplies,6);assert.equal(result.questionsFilled,3);assert.equal(result.copyStatus,'saved');
  assert.equal(hash(readFileSync(result.file)),hash(readFileSync(result.sourceFile)));assert.equal(hash(readFileSync(r.source)),before);assert.equal(hash(readFileSync(input.template)),frozen);
  const report=JSON.parse(readFileSync(result.report,'utf8'));assert.equal(report.rows.length,6);assert.equal(report.manualReplies,1);
});
test('通用结果中的人工跳过保留空白和状态，不填写成0分或成功',{skip:!xlsxIntegration},async t=>{
  const r=await setup(t);await assert.rejects(r.make().run(),ManualStepRequired);submit(r,{skip:true});await r.make().run();
  const result=await generateExcelResults(collectExcelResultInput(r));assert.equal(result.savedReplies,5);assert.equal(result.processedRows,6);assert.equal(result.skippedRows,1);assert.equal(result.questionsFilled,2);
});
test('控制器启动时重新校验已选文件，过期选择不触发连接；成功后绑定快照',{skip:!xlsxIntegration},async t=>{
  const r=await setup(t),controller=new Controller(r.base);let checks=0;controller.check=async()=>{checks++;return {account:'account-A',draft:false};};controller.execute=()=>{};
  const opts={datasetId:'excel',excelPath:r.source,excelHash:'stale',purpose:'technical_regression',acknowledgeExistingMemory:true};
  await assert.rejects(controller.start(opts),/重新校验/);assert.equal(checks,0);
  await controller.start({...opts,excelHash:r.report.file.sha256});assert.equal(checks,1);assert.equal(controller.state.datasetId,'excel');
  assert.ok(existsSync(join(controller.directory,'输入测评集.xlsx')));assert.equal(controller.status().run.total,6);
});
test('预览同时告知通用执行能力，不支持的自动多身份不能用于本轮执行',async t=>{
  const r=await setup(t),controller=new Controller(r.base),report=structuredClone(r.report);report.steps[1].identityId='B';
  const result=await controller.previewDataset({},async()=>report);assert.equal(result.valid,true);assert.equal(result.executionSupported,false);assert.match(result.executionError,/一个自动账号/);
});
test('自动结束和人工结束各生成对应快照，结果错误不改变发送完成记录',async t=>{
  const r=await setup(t),controller=new Controller(r.base);controller.state=r.state;controller.directory=r.directory;controller.configureAutomaticResults();
  await assert.rejects(r.make().run(),ManualStepRequired);let outputs=0;
  const fake=async input=>{outputs++;const file=join(r.directory,'result-'+outputs+'.xlsx');writeFileSync(file,'result '+outputs);return {file,resultHash:hash(readFileSync(file)),savedReplies:input.records.length};};
  // Automatic messages remain after this manual node: no premature auto export.
  await controller.finishAutomaticResults(fake);assert.equal(outputs,0);submit(r);await r.make().run();await controller.finishAutomaticResults(fake);
  assert.equal(outputs,1);assert.equal(controller.automaticResults.record.status,'succeeded');assert.equal(r.state.completions.length,5);assert.equal(r.state.status,'completed');
});
test('66行原表通用回填自动部分和人工收尾，两次结果双份一致且原表不改',{skip:!xlsxIntegration},async t=>{
  const file=resolve(project,'examples/optional/long-flow.xlsx');if(!existsSync(file))return t.skip('可选新表不存在');
  const r=await setup(t,file),before=hash(readFileSync(r.source));await assert.rejects(r.make().run(),ManualStepRequired);
  const first=await generateExcelResults(collectExcelResultInput(r));assert.equal(first.savedReplies,60);assert.equal(first.questionsFilled,22);assert.equal(first.unexecutedRows,6);
  assert.equal(hash(readFileSync(first.file)),hash(readFileSync(first.sourceFile)));
  while(r.state.stepIndex<r.dataset.total)submit(r,{skip:r.state.stepIndex===65});
  const second=await generateExcelResults(collectExcelResultInput(r));assert.equal(second.savedReplies,65);assert.equal(second.processedRows,66);assert.equal(second.skippedRows,1);assert.equal(second.questionsFilled,23);
  assert.notEqual(first.file,second.file);assert.equal(hash(readFileSync(second.file)),hash(readFileSync(second.sourceFile)));assert.equal(hash(readFileSync(r.source)),before);
});
