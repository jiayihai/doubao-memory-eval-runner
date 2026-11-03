import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { AutomaticResults, AUTO_RESULT_FILE, automaticResultsEnabled, resultActivity } from '../core/automatic-results.mjs';
import { saveJSON } from '../core/store.mjs';

function fixture(t, onUpdate=()=>{}) {
  const directory=mkdtempSync(join(tmpdir(),'doubao-auto-results-')),runId='test-run';
  t.after(()=>{const p=resolve(directory);assert.ok(p.startsWith(resolve(tmpdir())+sep)&&basename(p).startsWith('doubao-auto-results-'));rmSync(p,{recursive:true});});
  const make=()=>new AutomaticResults({directory,runId,onUpdate});
  return {directory,runId,make};
}
test('同一次结束触发并发或重复调用，只自动生成一次并保存回执',async t=>{
  const updates=[],f=fixture(t,r=>updates.push(r.status)),job=f.make();let release,calls=0;
  const generate=()=>{calls++;return new Promise(r=>{release=r;});};
  const a=job.runOnce(generate),b=job.runOnce(generate);await Promise.resolve();assert.equal(a,b);assert.equal(job.running,true);
  release({file:'result.xlsx',savedReplies:54});await a;await job.runOnce(generate);
  assert.equal(calls,1);assert.equal(job.running,false);assert.equal(job.record.status,'succeeded');assert.deepEqual(updates,['running','succeeded']);
  const receipt=JSON.parse(readFileSync(join(f.directory,AUTO_RESULT_FILE),'utf8'));assert.equal(receipt.runId,f.runId);assert.equal(receipt.result.savedReplies,54);
  const restored=f.make();await restored.runOnce(generate);assert.equal(calls,1);
});
test('生成失败独立记录，不抛出发送错误、不自动循环重试，可手动恢复',async t=>{
  const f=fixture(t),job=f.make();let calls=0;
  await job.runOnce(async()=>{calls++;throw new Error('模板被移动');});
  assert.equal(job.record.status,'failed');assert.match(job.record.error,/模板被移动/);
  await job.runOnce(async()=>{calls++;});assert.equal(calls,1);
  job.recoveredManually({file:'manual.xlsx',savedReplies:54});assert.equal(job.record.status,'succeeded');assert.equal(job.record.source,'manual');
  assert.match(job.record.previousError,/模板被移动/);assert.equal(f.make().record.source,'manual');
});
test('启动时只读取回执；上次生成中断不自动再生成或覆盖',async t=>{
  const f=fixture(t),file=join(f.directory,AUTO_RESULT_FILE);saveJSON(file,{schemaVersion:1,runId:f.runId,status:'running',startedAt:1});
  const before=readFileSync(file),job=f.make();assert.equal(job.record.status,'interrupted');
  await job.runOnce(()=>{throw new Error('must not replay');});assert.deepEqual(readFileSync(file),before);
  job.recoveredManually({file:'recovered.xlsx'});assert.equal(job.record.status,'succeeded');
});
test('生成状态损坏或来源不符时不猜测重跑，保留按钮恢复入口',async t=>{
  const f=fixture(t);saveJSON(join(f.directory,AUTO_RESULT_FILE),{schemaVersion:1,runId:'other',status:'succeeded'});
  const job=f.make();assert.equal(job.record.status,'failed');await job.runOnce(()=>{throw new Error('must not replay');});
  job.recoveredManually({file:'new.xlsx'});assert.equal(f.make().record.runId,f.runId);
});
test('日志输出失败不影响已生成结果，避免误报发送失败',async t=>{
  const f=fixture(t,()=>{throw new Error('log write failed');}),job=f.make();
  await job.runOnce(async()=>({file:'ok.xlsx'}));assert.equal(job.record.status,'succeeded');
});
test('回执保存失败时保留已生成文件位置，不把结果说成没有生成',async t=>{
  const f=fixture(t),job=f.make();
  await job.runOnce(async()=>{mkdirSync(join(f.directory,AUTO_RESULT_FILE+'.tmp'));return {file:'already-created.xlsx'};});
  assert.equal(job.record.status,'succeeded');assert.equal(job.record.result.file,'already-created.xlsx');assert.match(job.record.warning,/状态保存失败/);
});
test('只对显式开启的新建旧B运行启用，完成文案保留T17未执行',()=>{
  const s={datasetId:'doubao-b',features:{captureReplies:true,autoGenerateResults:true},phase:'finished',status:'awaiting_manual',activity:'original'};
  assert.equal(automaticResultsEnabled(s),true);assert.match(resultActivity(s,{status:'succeeded',source:'automatic'}),/自动部分已完成.*自动生成.*T17仍待人工执行/);
  assert.match(resultActivity(s,{status:'failed'}),/按钮重试/);
  assert.equal(automaticResultsEnabled({...s,datasetId:'smoke'}),false);
  assert.equal(automaticResultsEnabled({...s,features:{captureReplies:true}}),false);
  assert.equal(resultActivity({...s,features:{captureReplies:true}},null),'original');
  assert.equal(resultActivity({...s,status:'error',activity:'保存断点失败'},null),'保存断点失败');
});
