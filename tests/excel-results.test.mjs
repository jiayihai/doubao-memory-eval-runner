import test from 'node:test';
const xlsxIntegration=process.env.DOUBAO_XLSX_TESTS==='1';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from '../datasets/index.mjs';
import { hash, saveJSON } from '../core/store.mjs';
import { FLOW_HEADERS, QUESTION_HEADERS, templatePath, collectResultInput, buildFillPlan, beijingStamp, runResultWorker } from '../core/excel-results.mjs';
import { Controller, serve } from '../server.mjs';

function fixture(t, count=54) {
  const base=mkdtempSync(join(tmpdir(),'doubao-excel-')), root=join(base,'项目开始','豆包测评执行器V1');
  t.after(()=>{ const target=resolve(base); assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('doubao-excel-')); rmSync(target,{recursive:true}); });
  const dataset=loadDataset(), id='doubao-b-test', directory=join(root,'运行数据',id);
  mkdirSync(join(directory,'回复记录'),{recursive:true});
  mkdirSync(resolve(templatePath(root),'..'),{recursive:true}); writeFileSync(templatePath(root),'test template bytes');
  saveJSON(join(directory,'scenario.json'),dataset.data);
  const flow=[FLOW_HEADERS], questions=[QUESTION_HEADERS], turns=[], completions=[], conversations={};
  let sequence=0;
  for(const step of dataset.data.steps) for(let mi=0;mi<step.messages.length;mi++) {
    const m=step.messages[mi], key=`${step.id}:${mi}`, stepId=`S${String(flow.length).padStart(4,'0')}`;
    const isQuestion=['检查','复测'].includes(step.kind), qid=isQuestion?'Q-'+step.target:'';
    const row=[stepId,'A',step.target,isQuestion?'QUESTION':'HISTORY',qid,m.send_text,30,step.execution==='automatic'?'AUTO':'MANUAL','','未执行','',`${step.id} / 消息${mi+1}`,'','','','','',''];
    flow.push(row);
    if(isQuestion)questions.push([qid,'U01','测试能力',stepId,'A',step.target,m.send_text,'预期','原评分标准','','联合评分','','未执行','','','']);
    if(step.execution!=='automatic'||sequence>=count) continue;
    const href=conversations[step.target]?.href||`/chat/${10000+Object.keys(conversations).length}`;
    conversations[step.target]={href}; sequence++;
    const text=`回答 ${sequence}\n完整正文，包括中文、换行和代码\n\`\`\`text\n内容\n\`\`\``;
    const c={key,stepId:step.id,messageIndex:mi,target:step.target,href,promptHash:hash(m.send_text),answerHash:hash(text),
      userMessageId:'u'+sequence,answerMessageId:'a'+sequence,sendAttemptedAt:1793367780000+sequence*45000,
      sendConfirmedAt:1793367780500+sequence*45000,answerCompletionObservedAt:1793367790000+sequence*45000,
      recovered:false,completionTimeUncertain:false,completionBasis:'explicit_flag_and_stability',
      replyArchive:{status:'saved',replyFile:`回复记录/${step.id}_${String(mi+1).padStart(3,'0')}.json`}};
    const turn={schemaVersion:1,scope:'this_run_script_turn',runId:id,datasetId:dataset.id,datasetHash:dataset.fingerprint,
      account:'test-account',sequence,key,stepId:step.id,messageIndex:mi,conversationId:step.target,href,
      prompt:m.send_text,answer:text,promptHash:c.promptHash,answerHash:c.answerHash,userMessageId:c.userMessageId,
      answerMessageId:c.answerMessageId,sendAttemptedAt:c.sendAttemptedAt,sendConfirmedAt:c.sendConfirmedAt,
      answerCompletionObservedAt:c.answerCompletionObservedAt,recovered:false,completionTimeUncertain:false,
      completionBasis:c.completionBasis,sourceKind:step.kind,questionId:null};
    turns.push(turn); completions.push(c); saveJSON(join(directory,c.replyArchive.replyFile),turn);
  }
  const state={runId:id,datasetId:dataset.id,datasetHash:dataset.fingerprint,features:{captureReplies:true},account:'test-account',
    createdAt:1793367785662,status:'awaiting_manual',phase:'finished',purpose:'technical_regression',completions,conversations,
    pending:null,deviations:[],stepIndex:30,messageIndex:0};
  saveJSON(join(directory,'state.json'),state);
  const collect=()=>collectResultInput({root,directory,state});
  return {base,root,directory,state,flow,questions,turns,collect};
}

test('54条回复唯一匹配55行，20个自动问题回填，人工T17保留未执行', t=>{
  const f=fixture(t), input=f.collect(), plan=buildFillPlan(input,f.flow,f.questions);
  assert.equal(plan.fills.length,54); assert.equal(plan.counts.questionsFilled,20); assert.equal(plan.counts.unexecutedRows,1);
  assert.equal(plan.counts.questionsTotal,21); assert.ok(!plan.fills.some(x=>x.questionId==='Q-T17'));
  assert.deepEqual(plan.fills.map(x=>x.answer),f.turns.map(x=>x.answer));
  assert.equal(new Set(plan.fills.map(x=>x.row)).size,54);
  // Identical question text across different probes still maps by source key.
  const repeated=f.turns.filter(x=>x.prompt===f.turns.find(t=>t.conversationId==='T01').prompt);
  assert.equal(repeated.length,2); assert.notEqual(plan.fills.find(x=>x.key===repeated[0].key).questionId,plan.fills.find(x=>x.key===repeated[1].key).questionId);
});
test('执行表和问题表重排行后，仍按定位与问题ID匹配', t=>{
  const f=fixture(t), flow=[f.flow[0],...f.flow.slice(1).reverse()], questions=[f.questions[0],...f.questions.slice(1).reverse()];
  const plan=buildFillPlan(f.collect(),flow,questions);
  for(const item of plan.fills) { assert.equal(flow[item.row-1][5],f.turns.find(x=>x.key===item.key).prompt); if(item.questionRow)assert.equal(questions[item.questionRow-1][0],item.questionId); }
});
test('中途生成只包含已完成前缀，不读取待发送正文或其他未提交记录', t=>{
  const f=fixture(t,14); f.state.pending={text:'pending not for export',replyToSave:{answer:'not committed'}};
  saveJSON(join(f.directory,'回复记录','unused.json'),{answer:'not committed'});
  const plan=buildFillPlan(f.collect(),f.flow,f.questions);
  assert.equal(plan.counts.savedReplies,14); assert.equal(plan.counts.questionsFilled,2); assert.equal(plan.counts.unexecutedRows,41);
  assert.ok(plan.warnings.some(x=>x.includes('快照')));
});
test('时间不确定与恢复说明保留；已完成不等于能力通过', t=>{
  const f=fixture(t), input=f.collect(); input.turns[0].completionTimeUncertain=true; input.turns[0].recovered=true;
  const plan=buildFillPlan(input,f.flow,f.questions);
  assert.match(plan.fills[0].note,/时间不确定/); assert.match(plan.fills[0].note,/恢复后/); assert.equal(plan.fills[0].status,'已完成');
  assert.equal(plan.counts.uncertainReplies,1); assert.ok(plan.warnings.some(x=>x.includes('不自动评分')));
});
test('模板缺行、重复定位、原文变化、身份变化、问题错配均拒绝', t=>{
  const f=fixture(t), input=f.collect();
  const changed=fn=>{const flow=structuredClone(f.flow),questions=structuredClone(f.questions);fn(flow,questions);return()=>buildFillPlan(input,flow,questions);};
  assert.throws(changed(flow=>flow.pop()),/55条/);
  assert.throws(changed(flow=>flow[2][11]=flow[1][11]),/重复/);
  assert.throws(changed(flow=>flow[1][5]+=' changed'),/原文/);
  assert.throws(changed(flow=>flow[1][1]='B'),/身份/);
  assert.throws(changed((flow,q)=>q[1][3]='other'),/不一致/);
  assert.throws(changed((flow,q)=>q[2][0]=q[1][0]),/重复/);
  assert.throws(changed(flow=>flow[1][8]='existing answer'),/空白/);
});
test('正文被修改、记录缺失或混入另一轮，不会被填成成功', t=>{
  const f=fixture(t,2), file=join(f.directory,f.state.completions[0].replyArchive.replyFile), original=JSON.parse(readFileSync(file,'utf8'));
  saveJSON(file,{...original,answer:'tampered'}); assert.throws(f.collect,/哈希/);
  saveJSON(file,{...original,runId:'another'}); assert.throws(f.collect,/来源/);
  saveJSON(file,original); f.state.completions[0].replyArchive.status='failed'; assert.throws(f.collect,/没有已核验/);
});
test('路径穿越回执、重复消息编号、旧轮或连通性记录均拒绝', t=>{
  const f=fixture(t,2); f.state.completions[0].replyArchive.replyFile='../state.json'; assert.throws(f.collect,/回复文件/);
  f.state.completions[0].replyArchive.replyFile='回复记录/S01_001.json';
  const c=f.state.completions[1],file=join(f.directory,c.replyArchive.replyFile),r=JSON.parse(readFileSync(file,'utf8'));
  c.userMessageId=f.state.completions[0].userMessageId; r.userMessageId=c.userMessageId;saveJSON(file,r);assert.throws(f.collect,/重复/);
  f.state.features.captureReplies=false;assert.throws(f.collect,/没有开启/);
  f.state.datasetId='smoke';assert.throws(f.collect,/连通性/);
});
test('超长回答不截断，明确拒绝Excel单元格上限', t=>{
  const f=fixture(t,1),input=f.collect();input.turns[0].answer='a'.repeat(32768);
  assert.throws(()=>buildFillPlan(input,f.flow,f.questions),/上限/);
});
test('生成时复制快照，模板和运行文件保持原样，完全不访问豆包', async t=>{
  const f=fixture(t,2),controller=new Controller(f.root);controller.directory=f.directory;controller.state=f.state;controller.active=true;
  const stateBefore=readFileSync(join(f.directory,'state.json')),templateBefore=readFileSync(templatePath(f.root));
  controller.adapter=new Proxy({}, {get(){throw new Error('must not access adapter');}});
  const result=await controller.generateResults(async input=>{input.run.id='worker-local';input.turns[0].answer='worker-local';return {savedReplies:input.turns.length};});
  assert.equal(result.savedReplies,2);assert.equal(f.state.runId,'doubao-b-test');assert.equal(controller.active,true);
  assert.deepEqual(readFileSync(join(f.directory,'state.json')),stateBefore);assert.deepEqual(readFileSync(templatePath(f.root)),templateBefore);
  assert.equal(controller.resultTask,null);assert.equal(controller.status().resultGeneration.available,true);
});
test('重复点击被串行保护；写入失败可重试且不改变执行状态', async t=>{
  const f=fixture(t,1),controller=new Controller(f.root);controller.directory=f.directory;controller.state=f.state;
  let release;const first=controller.generateResults(()=>new Promise(resolve=>{release=resolve;}));
  await Promise.resolve();await assert.rejects(controller.generateResults(),/正在生成/);release({ok:true});await first;
  await assert.rejects(controller.generateResults(async()=>{throw new Error('disk unavailable');}),/disk unavailable/);
  assert.equal(controller.resultTask,null);assert.equal(f.state.status,'awaiting_manual');
  assert.deepEqual(await controller.generateResults(async()=>({ok:true})),{ok:true});
});
test('输出文件日期使用北京时间；模板使用仓库内相对路径', ()=>{
  assert.equal(beijingStamp(Date.parse('2026-10-30T13:43:05Z')),'20261030_214305');
  const root=resolve(tmpdir(),'evaluation-repository');
  assert.equal(templatePath(root),resolve(root,'examples','legacy','旧豆包B测评集_全过程与独立问题表.xlsx'));
});
test('子进程错误清楚返回；不包含发送器调用', async t=>{
  const f=fixture(t,1), worker=join(f.base,'failure-worker.mjs');
  writeFileSync(worker,"process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({ok:false,error:'测试写入错误'}));process.exitCode=1;});");
  await assert.rejects(runResultWorker(f.collect(),{worker}),/测试写入错误/);
});
test('真实表格子进程复制固定模板并回填，源模板和执行记录不变',{skip:!xlsxIntegration},async t=>{
  const approvedTemplate=templatePath(fileURLToPath(new URL('..',import.meta.url)));
  if(!existsSync(approvedTemplate))return t.skip('此离线整合需要本阶段指定的固定模板');
  const f=fixture(t,54);copyFileSync(approvedTemplate,templatePath(f.root));
  const sourceBefore=hash(readFileSync(templatePath(f.root))),stateBefore=hash(readFileSync(join(f.directory,'state.json')));
  const result=await runResultWorker(f.collect());
  assert.equal(result.savedReplies,54);assert.equal(result.questionsFilled,20);assert.equal(result.unexecutedRows,1);
  assert.ok(result.file.startsWith(join(f.directory,'测评结果')));assert.match(basename(result.file),/^豆包_技术回归结果_/);
  assert.equal(readFileSync(result.file).subarray(0,2).toString(),'PK');assert.ok(existsSync(result.report));
  assert.equal(hash(readFileSync(templatePath(f.root))),sourceBefore);assert.equal(hash(readFileSync(join(f.directory,'state.json'))),stateBefore);
});
test('按钮接口独立可用，运行中仍能接收暂停指令', async t=>{
  const f=fixture(t,1),token='offline-excel-endpoint-test-token-only';
  const service=await serve({root:f.root,token});
  try {
    service.controller.state=f.state;service.controller.directory=f.directory;service.controller.active=true;
    let release;service.controller.generateResults=()=>new Promise(resolve=>{release=resolve;});
    const endpoint=`http://127.0.0.1:${service.port}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
    const pending=fetch(endpoint+'/generate-results',{method:'POST',headers,body:'{}'});
    for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));
    assert.ok(release);assert.equal(service.controller.busy,true);
    const pause=await fetch(endpoint+'/pause',{method:'POST',headers,body:'{}'});assert.equal(pause.status,200);
    assert.equal(service.controller.requested,'paused');
    release({savedReplies:1});const response=await pending;assert.equal(response.status,200);assert.equal((await response.json()).result.savedReplies,1);
  } finally {await new Promise(resolve=>service.server.close(resolve));}
});

function automaticController(f) {
  f.state.features.autoGenerateResults=true;
  const controller=new Controller(f.root);controller.state=f.state;controller.directory=f.directory;
  controller.configureAutomaticResults();return controller;
}
test('自动结束复用同一回填入口且只调用一次，完成状态与消息进度不变',async t=>{
  const f=fixture(t),controller=automaticController(f);let calls=0;
  const worker=async input=>{calls++;assert.equal(input.turns.length,54);return {file:'auto-result.xlsx',savedReplies:54};};
  await Promise.all([controller.finishAutomaticResults(worker),controller.finishAutomaticResults(worker)]);
  await controller.finishAutomaticResults(worker);assert.equal(calls,1);assert.equal(controller.state.status,'awaiting_manual');
  assert.equal(controller.state.completions.length,54);assert.equal(controller.state.lastError,undefined);
  assert.match(controller.status().run.activity,/自动部分已完成.*结果表已自动生成.*T17仍待人工执行/);
});
test('暂停、停止、执行错误及未开启自动生成的旧轮均不触发',async t=>{
  const f=fixture(t),controller=automaticController(f),never=()=>{throw new Error('must not generate');};
  for(const status of ['paused','stopped','needs_review','error']) {f.state.status=status;await controller.finishAutomaticResults(never);}
  f.state.status='awaiting_manual';f.state.phase='messages';await controller.finishAutomaticResults(never);
  f.state.phase='finished';delete f.state.features.autoGenerateResults;await controller.finishAutomaticResults(never);
  assert.equal(controller.automaticResults.record,null);
});
test('回复尚未全部保存时仅报告结果生成问题，不伪造54条成功',async t=>{
  const f=fixture(t,53),controller=automaticController(f);let calls=0;
  await controller.finishAutomaticResults(()=>{calls++;});assert.equal(calls,0);
  assert.equal(controller.automaticResults.record.status,'failed');assert.equal(f.state.status,'awaiting_manual');assert.equal(f.state.completions.length,53);
});
test('自动回填失败不重发，手动按钮成功后更新结果提示',async t=>{
  const f=fixture(t),controller=automaticController(f);const stateBefore=readFileSync(join(f.directory,'state.json'));
  await controller.finishAutomaticResults(async()=>{throw new Error('模板不存在');});
  assert.equal(f.state.status,'awaiting_manual');assert.equal(f.state.lastError,undefined);assert.match(controller.status().run.activity,/按钮重试/);
  assert.equal(controller.status().resultGeneration.available,true);
  await controller.generateResults(async()=>({file:'manual-recovery.xlsx',savedReplies:54}));
  assert.match(controller.status().run.activity,/已手动生成/);assert.equal(controller.automaticResults.record.source,'manual');
  assert.deepEqual(readFileSync(join(f.directory,'state.json')),stateBefore);
});
test('结束时等待手动快照写完再生成最终结果，期间禁止重复生成和新建',async t=>{
  const f=fixture(t),controller=automaticController(f);let release;const order=[];
  const manual=controller.generateResults(()=>new Promise(r=>{release=r;order.push('manual');}));await Promise.resolve();
  const automatic=controller.finishAutomaticResults(async input=>{order.push('automatic');return {file:'final.xlsx',savedReplies:input.turns.length};});
  await Promise.resolve();assert.equal(controller.status().busy,true);
  await assert.rejects(controller.generateResults(),/正在自动生成/);
  await assert.rejects(controller.start({datasetId:'doubao-b'}),/结果表正在生成/);
  release({file:'snapshot.xlsx',savedReplies:54});await manual;await automatic;
  assert.deepEqual(order,['manual','automatic']);assert.equal(controller.automaticResults.record.result.file,'final.xlsx');
});
test('关闭窗口会等待本地自动生成收尾，不重启发送',async t=>{
  const f=fixture(t),controller=automaticController(f);let release,closed=false;
  const job=controller.finishAutomaticResults(()=>new Promise(r=>{release=r;}));
  for(let i=0;i<4&&!release;i++)await Promise.resolve();assert.ok(release);
  const close=controller.shutdown().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);
  release({file:'end.xlsx',savedReplies:54});await job;await close;assert.equal(closed,true);assert.equal(f.state.status,'awaiting_manual');
});
test('真实发送引擎经过末段到T17后自动生成Excel，无需新的豆包操作',{skip:!xlsxIntegration},async t=>{
  const approvedTemplate=templatePath(fileURLToPath(new URL('..',import.meta.url)));
  if(!existsSync(approvedTemplate))return t.skip('需要本阶段指定的固定模板');
  const f=fixture(t);copyFileSync(approvedTemplate,templatePath(f.root));
  const controller=automaticController(f);
  // All 54 turns already exist in this disposable fixture. Only the last empty
  // transition and manual-boundary tick run; no navigation, input or send occurs.
  f.state.phase='transitions';f.state.status='running';f.state.stepIndex=29;f.state.messageIndex=1;f.state.transitionIndex=0;f.state.port=9223;
  controller.execute();await controller.task;
  assert.equal(controller.active,false);assert.equal(f.state.phase,'finished');assert.equal(f.state.status,'awaiting_manual');
  assert.equal(controller.automaticResults.record.status,'succeeded');assert.ok(existsSync(controller.automaticResults.record.result.file));
  assert.equal(controller.automaticResults.record.result.savedReplies,54);assert.equal(controller.automaticResults.record.result.questionsFilled,20);
  assert.equal(controller.logs.filter(x=>x.type==='finished').length,1);
  assert.equal(controller.logs.filter(x=>x.type==='results_automatic_succeeded').length,1);
  assert.equal(controller.logs.filter(x=>['send_intent','send_action','sent'].includes(x.type)).length,0);
});
