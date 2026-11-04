import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { readRunArtifacts, recordRunResult, ARTIFACT_INDEX } from '../core/run-artifacts.mjs';
import { hash, saveJSON } from '../core/store.mjs';
import { Controller } from '../server.mjs';
import { loadDataset } from '../datasets/index.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'doubao-artifact-')),directory=join(root,'运行数据','run-A');mkdirSync(join(directory,'测评结果'),{recursive:true});
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)&&basename(root).startsWith('doubao-artifact-'));rmSync(root,{recursive:true});});
  const state={runId:'run-A',datasetId:'smoke',datasetHash:loadDataset('smoke').fingerprint,account:'test-account',
    phase:'messages',status:'paused',stepIndex:0,messageIndex:0,completions:[],manualResults:{},deviations:[],features:{captureReplies:true}};
  saveJSON(join(directory,'state.json'),state);writeFileSync(join(directory,'events.jsonl'),'');
  const result=(name,processedRows=2,totalRows=6)=>{const file=join(directory,'测评结果',name+'.xlsx');writeFileSync(file,'test workbook bytes '+name);return {file,processedRows,totalRows,savedReplies:processedRows};};
  return {root,directory,state,result,view:()=>readRunArtifacts({directory,state})};
}

test('快捷入口读取阶段结果，反复查看不改状态、回执或重新生成文件',t=>{
  const f=fixture(t),result=f.result('stage');f.state.completions=[{},{},{}];
  saveJSON(join(f.directory,'结果副本状态.json'),{runId:'run-A',updatedAt:100,result});
  const files=[join(f.directory,'state.json'),join(f.directory,'结果副本状态.json')],before=files.map(p=>hash(readFileSync(p))),names=readdirSync(join(f.directory,'测评结果'));
  for(let i=0;i<3;i++){const view=f.view();assert.equal(view.result.kind,'stage');assert.equal(view.result.stale,true);assert.equal(view.result.available,true);assert.equal(view.result.file,result.file);}
  assert.deepEqual(files.map(p=>hash(readFileSync(p))),before);assert.deepEqual(readdirSync(join(f.directory,'测评结果')),names);
});
test('完整处理含跳过仍标全流程结果，但保留跳过计数而非评分通过',t=>{
  const f=fixture(t),result={...f.result('final',6,6),savedReplies:5,skippedRows:1};
  const recorded=recordRunResult({...f,result,now:200});assert.equal(recorded.artifactKind,'final');
  assert.equal(f.view().result.kind,'final');assert.equal(f.view().result.skippedRows,1);assert.equal(f.view().result.processedRows,6);
});
test('手动生成的新结果通过独立索引覆盖旧自动结果入口，不改发送状态',t=>{
  const f=fixture(t),old=f.result('old'),latest=f.result('latest',4,6),state=readFileSync(join(f.directory,'state.json'));
  saveJSON(join(f.directory,'结果生成状态.json'),{runId:'run-A',status:'succeeded',finishedAt:100,result:old});
  recordRunResult({...f,result:latest,now:300});assert.equal(f.view().result.file,latest.file);
  assert.deepEqual(readFileSync(join(f.directory,'state.json')),state);
});
test('最新结果被移动时明确不可打开，不悄悄打开旧结果或重建',t=>{
  const f=fixture(t),old=f.result('old'),latest=f.result('latest',5,6);
  // A copied/touched old generic report must use its original snapshot time,
  // not its newer filesystem timestamp, to avoid replacing the latest entry.
  saveJSON(join(f.directory,'测评结果','old.回填说明.json'),{run:{id:'run-A',snapshotAt:50},result:'old.xlsx',savedReplies:2,totalRows:6});
  saveJSON(join(f.directory,'结果生成状态.json'),{runId:'run-A',status:'succeeded',finishedAt:100,result:old});
  recordRunResult({...f,result:latest,now:300});unlinkSync(latest.file);
  const view=f.view();assert.equal(view.result.file,latest.file);assert.equal(view.result.available,false);assert.equal(readdirSync(join(f.directory,'测评结果')).filter(x=>x.endsWith('.xlsx')).length,1);
});
test('其他轮次回执不参与本轮入口，损坏回执也不写回修复',t=>{
  const f=fixture(t),result=f.result('foreign');saveJSON(join(f.directory,ARTIFACT_INDEX),{runId:'other-run',generatedAt:300,result});
  writeFileSync(join(f.directory,'结果副本状态.json'),'broken receipt');const before=readFileSync(join(f.directory,'结果副本状态.json'));
  assert.equal(f.view().result,null);assert.deepEqual(readFileSync(join(f.directory,'结果副本状态.json')),before);
});
test('旧版仅有回填说明也能定位结果，原绝对路径重新定位到本轮目录',t=>{
  const f=fixture(t),result=f.result('legacy',54,55);
  saveJSON(join(f.directory,'测评结果','legacy.回填说明.json'),{run:{id:'run-A'},generatedAt:100,result:'legacy.xlsx',savedReplies:54,totalRows:55});
  const view=f.view();assert.equal(view.result.kind,'stage');assert.equal(view.result.file,result.file);assert.equal(view.result.available,true);
  saveJSON(join(f.directory,'结果生成状态.json'),{runId:'run-A',status:'succeeded',finishedAt:200,result:{...result,file:'C:\\previous-computer\\legacy.xlsx'}});
  assert.equal(f.view().result.file,result.file);
});
test('快捷入口只定位本轮测评结果中的xlsx，不打开输入文件或外部路径',t=>{
  const f=fixture(t),external=join(f.root,'source.xlsx');writeFileSync(external,'input bytes');
  saveJSON(join(f.directory,ARTIFACT_INDEX),{runId:'run-A',generatedAt:100,result:{file:external,processedRows:1,totalRows:6}});
  assert.equal(f.view().result.available,false);assert.notEqual(f.view().result.file,external);
});
test('会话备份按身份及自动/人工分类，未产生目录的身份不显示',t=>{
  const f=fixture(t),dataset={data:{steps:[{identityId:'A'},{identityId:'B'},{identityId:'C'}]}};
  for(const path of ['身份/A/会话备份','身份/B/人工会话备份'])mkdirSync(join(f.directory,path),{recursive:true});
  const view=readRunArtifacts({...f,dataset});assert.deepEqual(view.backups.map(x=>[x.identityId,x.kind]),[['A','automatic'],['B','manual']]);
  assert.equal(view.backups[0].path,join(f.directory,'身份/A/会话备份'));
});
test('产物索引写入失败保留已生成位置和提示，不改变发送进度',t=>{
  const f=fixture(t),result=f.result('saved'),before=readFileSync(join(f.directory,'state.json'));mkdirSync(join(f.directory,ARTIFACT_INDEX+'.tmp'));
  const recorded=recordRunResult({...f,result});assert.equal(recorded.file,result.file);assert.match(recorded.warning,/已生成.*索引保存失败/);assert.deepEqual(readFileSync(join(f.directory,'state.json')),before);
});
test('原Excel目录副本失败仍能直达本轮本地结果，查看不调用生成器',t=>{
  const f=fixture(t),result={...f.result('local'),copyStatus:'failed',copyError:'source folder not writable'};
  recordRunResult({...f,result,now:200});assert.equal(f.view().result.available,true);assert.equal(f.view().result.copyStatus,'failed');
});

function controllerFixture(t){const f=fixture(t),controller=new Controller(f.root);controller.directory=f.directory;controller.state=f.state;return {...f,controller};}
test('暂停和历史停止状态均允许预览新表，预览不更换当前冻结流程',async t=>{
  const f=controllerFixture(t),c=f.controller;const before=readFileSync(join(f.directory,'state.json'));
  for(const status of ['paused','stopped']){c.state.status=status;const data=await c.previewDataset({},async()=>({valid:true,file:{path:'B.xlsx'}}));assert.equal(data.file.path,'B.xlsx');assert.equal(c.state.runId,'run-A');assert.equal(c.state.datasetId,'smoke');}
  assert.deepEqual(readFileSync(join(f.directory,'state.json')),before);
  let executed=0;c.execute=()=>{executed++;};await c.resume({expectedRunId:'run-A'});assert.equal(executed,1);assert.equal(c.state.runId,'run-A');
});
test('暂停请求未完成时选表仍受保护，真正停止执行后开放',async t=>{
  const f=controllerFixture(t),c=f.controller;c.active=true;
  c.interrupt('paused',{expectedRunId:'run-A'});assert.equal(c.status().run.pauseRequested,true);
  await assert.rejects(c.previewDataset({},()=>{throw new Error('must not read');}),/先暂停/);
  c.active=false;c.requested=null;c.state.status='paused';assert.equal(c.status().run.pauseRequested,false);
  assert.equal((await c.previewDataset({},async()=>({valid:true}))).valid,true);
});
test('界面携带的运行编号过期时不能暂停、继续或覆盖其他任务',async t=>{
  const f=controllerFixture(t),c=f.controller;c.active=true;
  assert.throws(()=>c.interrupt('paused',{expectedRunId:'other'}),/不能暂停其他轮次/);assert.equal(c.requested,null);
  c.active=false;c.execute=()=>{throw new Error('must not execute');};
  await assert.rejects(c.resume({expectedRunId:'other'}),/不能恢复其他轮次/);
  await assert.rejects(c.start({datasetId:'excel',excelPath:'not-read.xlsx',abandon:true,expectedPreviousRunId:'other'}),/任务已变化/);
});
test('结果快捷状态读取不连接产品，不写入旧运行文件',t=>{
  const f=controllerFixture(t),c=f.controller;saveJSON(join(f.directory,'结果副本状态.json'),{runId:'run-A',updatedAt:100,result:f.result('saved')});
  const before=readFileSync(join(f.directory,'state.json'));c.generateResults=()=>{throw new Error('must not generate');};
  assert.equal(c.status().artifacts.result.available,true);assert.deepEqual(readFileSync(join(f.directory,'state.json')),before);
  // A normal manual boundary remains a manual boundary after reopening; do not
  // relabel it as a crash or rewrite a user's already saved manual wait state.
  Object.assign(f.state,{datasetId:'excel',phase:'manual',status:'awaiting_manual',features:{captureReplies:false}});
  saveJSON(join(f.directory,'state.json'),f.state);saveJSON(c.settingsPath,{lastRun:'run-A'});
  const manualBefore=readFileSync(join(f.directory,'state.json')),reopened=new Controller(f.root);
  assert.equal(reopened.state.status,'awaiting_manual');assert.deepEqual(readFileSync(join(f.directory,'state.json')),manualBefore);
});
