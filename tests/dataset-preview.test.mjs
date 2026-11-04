import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { FLOW_SHEET, QUESTION_SHEET, FLOW_REQUIRED, QUESTION_REQUIRED, validateDatasetSheets, previewDatasetFile } from '../core/dataset-preview.mjs';
import { templatePath } from '../core/excel-results.mjs';
import { hash, saveJSON } from '../core/store.mjs';
import { Controller, serve } from '../server.mjs';
import { loadDataset } from '../datasets/index.mjs';

function fixture() {
  const fh=[...FLOW_REQUIRED,'执行约束','计时锚点问题ID','距锚点最早秒数','距锚点最晚秒数'];
  const qh=[...QUESTION_REQUIRED,'步骤ID','身份ID','会话ID','前置问题ID'];
  const row=(headers,fields)=>headers.map(h=>fields[h]??null);
  const base={'身份ID':'A','消息类型':'HISTORY','回复后等待秒数':30,'执行方式':'AUTO','执行状态':'未执行'};
  const flow=[fh,
    row(fh,{...base,'步骤ID':'S0001','会话ID':'M00','发送内容':'  原样历史\n结尾空格  '}),
    row(fh,{...base,'步骤ID':'S0002','会话ID':'T01','消息类型':'QUESTION','问题ID':'Q01','发送内容':'问题一？','回复后等待秒数':120}),
    row(fh,{...base,'步骤ID':'S0003','会话ID':'M00','发送内容':'继续补充历史'}),
    row(fh,{...base,'步骤ID':'S0004','会话ID':'T17','消息类型':'QUESTION','问题ID':'Q02','发送内容':'隔日问题？','执行方式':'MANUAL','回复后等待秒数':0,
      '计时锚点问题ID':'Q01','距锚点最早秒数':79200,'距锚点最晚秒数':93600})];
  const qbase={'用例ID':'U01','测评能力':'召回','预期回答要点':'预期事实','评分标准':'按原标准判分','执行状态':'未执行','身份ID':'A'};
  const questions=[qh,
    row(qh,{...qbase,'问题ID':'Q01','测试问题':'问题一？','步骤ID':'S0002','会话ID':'T01'}),
    row(qh,{...qbase,'问题ID':'Q02','测试问题':'隔日问题？','步骤ID':'S0004','会话ID':'T17','前置问题ID':'Q01'})];
  const sheets={[FLOW_SHEET]:{values:flow,formulas:[]},[QUESTION_SHEET]:{values:questions,formulas:[]}};
  const set=(sheet,r,header,value)=>{const table=sheets[sheet].values;table[r][table[0].indexOf(header)]=value;};
  return {sheets,set,flow,questions,validate:()=>validateDatasetSheets(sheets)};
}
function scratch(t) {
  const root=mkdtempSync(join(tmpdir(),'doubao-preview-'));
  t.after(()=>{const p=resolve(root);assert.ok(p.startsWith(resolve(tmpdir())+sep)&&basename(p).startsWith('doubao-preview-'));rmSync(p,{recursive:true});});
  return root;
}
test('双表按步骤ID计划新建和返回，原文与人工锚点保留，人工提示不算失败',()=>{
  const f=fixture(),original=structuredClone(f.sheets),r=f.validate();assert.equal(r.valid,true);
  assert.deepEqual(r.steps.map(s=>s.navigation),['new','new','return','new']);
  assert.equal(r.steps[0].content,'  原样历史\n结尾空格  ');assert.equal(r.steps[1].waitSeconds,120);
  assert.equal(r.steps[3].mode,'MANUAL');assert.equal(r.steps[3].anchorQuestionId,'Q01');assert.equal(r.steps[3].maxAfterAnchorSeconds,93600);
  assert.deepEqual(r.summary,{total:4,automatic:3,manual:1,history:2,questions:2,conversations:3,automaticConversations:2,identities:1,errors:0,warnings:1});
  assert.deepEqual(f.sheets,original);assert.equal(r.scope,'validation_and_preview_only');
});
test('列顺序和物理行顺序改变时仍按字段关联，预览排序而不改源表',()=>{
  const f=fixture();f.flow.splice(1,4,f.flow[3],f.flow[1],f.flow[4],f.flow[2]);
  for(const name of [FLOW_SHEET,QUESTION_SHEET])f.sheets[name].values=f.sheets[name].values.map(row=>[...row].reverse());
  const original=structuredClone(f.sheets),r=f.validate();assert.equal(r.valid,true);
  assert.deepEqual(r.steps.map(s=>s.stepId),['S0001','S0002','S0003','S0004']);assert.equal(r.steps[2].navigation,'return');
  assert.ok(r.issues.some(i=>i.message.includes('原表行顺序')));assert.deepEqual(f.sheets,original);
});
test('缺工作表、必需表头或重复表头会指出工作表和位置',()=>{
  const f=fixture();delete f.sheets[QUESTION_SHEET];assert.equal(f.validate().valid,false);assert.ok(f.validate().issues.some(x=>x.sheet===QUESTION_SHEET&&x.message.includes('缺少工作表')));
  const g=fixture();g.flow[0][5]='';const r=g.validate();assert.equal(r.valid,false);assert.ok(r.issues.some(x=>x.row===1&&x.column==='F'&&x.message.includes('缺少表头')));
  const h=fixture();h.flow[0][2]='步骤ID';assert.ok(h.validate().issues.some(x=>x.row===1&&x.column==='C'&&x.message.includes('重复')));
});
test('步骤编号的前导零不能掩盖重复，非法编号和空白内容拒绝',()=>{
  const f=fixture();f.set(FLOW_SHEET,3,'步骤ID','S01');assert.ok(f.validate().issues.some(x=>x.message.includes('数字序号重复')));
  const g=fixture();g.set(FLOW_SHEET,1,'步骤ID','第一条');g.set(FLOW_SHEET,1,'发送内容',' \n ');
  const r=g.validate();assert.equal(r.valid,false);assert.ok(r.issues.some(x=>x.column==='A'&&x.row===2));assert.ok(r.issues.some(x=>x.column==='F'&&x.row===2));
});
test('负数、文字、随机说明、小数等待均拒绝，不推测秒数',()=>{
  for(const value of [-1,'30','随机30—60',1.5,604801]){const f=fixture();f.set(FLOW_SHEET,1,'回复后等待秒数',value);const r=f.validate();assert.equal(r.valid,false);assert.ok(r.issues.some(x=>x.column==='G'&&x.row===2));}
});
test('消息类型、执行方式、历史行问题ID及危险会话名称拒绝',()=>{
  for(const [h,value]of [['消息类型','USER'],['执行方式','发送'],['问题ID','unexpected'],['会话ID','CON'],['会话ID','M 0']]){const f=fixture();f.set(FLOW_SHEET,1,h,value);assert.equal(f.validate().valid,false);}
});
test('问题ID、双表题干、步骤、身份、会话和评分标准分别核对',()=>{
  for(const [h,value]of [['问题ID','Q-UNKNOWN'],['测试问题','多一个字'],['步骤ID','S9999'],['身份ID','B'],['会话ID','T02'],['评分标准','']]){
    const f=fixture();f.set(QUESTION_SHEET,1,h,value);const r=f.validate();assert.equal(r.valid,false);assert.ok(r.issues.some(x=>x.sheet===QUESTION_SHEET&&x.row===2));
  }
});
test('同题干不同问题ID允许；仅大小写不同的ID与重复问题不能蒙混匹配',()=>{
  const f=fixture();f.set(FLOW_SHEET,4,'发送内容','问题一？');f.set(QUESTION_SHEET,2,'测试问题','问题一？');assert.equal(f.validate().valid,true);
  const g=fixture();g.set(FLOW_SHEET,4,'问题ID','q01');assert.equal(g.validate().valid,false);
  const h=fixture();h.set(QUESTION_SHEET,2,'问题ID','q01');assert.ok(h.validate().issues.some(x=>x.message.includes('问题ID重复')));
});
test('动态输入公式不当作固定消息，问题表结果关联公式可以保留',()=>{
  const f=fixture();f.sheets[FLOW_SHEET].formulas[1]=[];f.sheets[FLOW_SHEET].formulas[1][5]='="输入"';assert.equal(f.validate().valid,false);
  const g=fixture();g.sheets[QUESTION_SHEET].formulas[1]=[];g.sheets[QUESTION_SHEET].formulas[1][6]='=INDEX(...)';assert.equal(g.validate().valid,true);
  const h=fixture();h.flow.push(new Array(h.flow[0].length).fill(null));h.sheets[FLOW_SHEET].formulas[5]=[];h.sheets[FLOW_SHEET].formulas[5][5]='=""';assert.equal(h.validate().valid,false);
});
test('前置问题和人工计时锚点必须存在且更早，不允许自引用循环',()=>{
  for(const value of ['Q-MISSING','Q02']){const f=fixture();f.set(QUESTION_SHEET,2,'前置问题ID',value);assert.equal(f.validate().valid,false);}
  const g=fixture();g.set(QUESTION_SHEET,1,'前置问题ID','Q02');assert.equal(g.validate().valid,false);
  const h=fixture();h.set(FLOW_SHEET,4,'距锚点最晚秒数',1);assert.equal(h.validate().valid,false);
  const j=fixture();j.set(FLOW_SHEET,4,'计时锚点问题ID',null);assert.equal(j.validate().valid,false);
  const k=fixture();k.set(FLOW_SHEET,4,'距锚点最晚秒数',1e30);assert.equal(k.validate().valid,false);
});
test('选到已回填结果时明确报错，避免把旧回答当作新模板',()=>{
  const f=fixture();f.set(FLOW_SHEET,1,'实际回答','之前的回答');assert.equal(f.validate().valid,false);
  const g=fixture();g.set(QUESTION_SHEET,1,'执行状态','已完成');assert.equal(g.validate().valid,false);
});
test('同会话连续与跨身份会话分开预览，多身份只提示不虚构账号隔离',()=>{
  const f=fixture();f.set(FLOW_SHEET,3,'会话ID','T01');const r=f.validate();assert.equal(r.valid,true);assert.equal(r.steps[2].navigation,'continue');
  const g=fixture();g.set(FLOW_SHEET,3,'身份ID','B');const result=g.validate();assert.equal(result.valid,true);assert.equal(result.steps[2].navigation,'new');assert.ok(result.issues.some(x=>x.message.includes('真实账号隔离')));
});
test('相同格式支持1000条历史，不写死旧版55条或固定会话数',()=>{
  const f=fixture(),headers=f.flow[0];f.sheets[FLOW_SHEET].values=[headers];f.sheets[QUESTION_SHEET].values=[f.questions[0]];
  for(let i=1;i<=1000;i++){const row=new Array(headers.length).fill(null);const put=(h,v)=>{row[headers.indexOf(h)]=v;};put('步骤ID','S'+String(i).padStart(4,'0'));put('身份ID','A');put('会话ID','M00');put('消息类型','HISTORY');put('发送内容','历史 '+i);put('回复后等待秒数',30);put('执行方式','AUTO');put('执行状态','未执行');f.sheets[FLOW_SHEET].values.push(row);}
  const r=f.validate();assert.equal(r.valid,true);assert.equal(r.summary.total,1000);assert.equal(r.summary.questions,0);assert.equal(r.steps[999].navigation,'continue');
});
test('真实固定Excel只读预览得到55/54/1及21个问题，发送原文逐条一致',async t=>{
  const file=templatePath(fileURLToPath(new URL('..',import.meta.url)));if(!existsSync(file))return t.skip('需要指定的固定模板');
  const before=hash(readFileSync(file)),r=await previewDatasetFile(file),expected=loadDataset().data.steps.flatMap(s=>s.messages.map(m=>m.send_text));
  assert.equal(r.valid,true);assert.equal(r.summary.total,55);assert.equal(r.summary.automatic,54);assert.equal(r.summary.manual,1);
  assert.equal(r.summary.history,34);assert.equal(r.summary.questions,21);assert.equal(r.summary.conversations,24);assert.equal(r.summary.automaticConversations,23);
  assert.deepEqual(r.steps.map(s=>s.content),expected);assert.equal(r.steps.at(-1).anchorQuestionId,'Q-A01-01');assert.equal(hash(readFileSync(file)),before);
});
test('预览不连接产品、不更改断点、事件或设置，解析失败也可重试',async t=>{
  const root=scratch(t),controller=new Controller(root),dir=join(root,'运行数据','test');mkdirSync(dir,{recursive:true});
  controller.directory=dir;controller.state={runId:'test',datasetId:'smoke',phase:'messages',status:'paused',stepIndex:0,messageIndex:0,completions:[],deviations:[]};
  controller.save();saveJSON(controller.settingsPath,{lastRun:'test'});writeFileSync(join(dir,'events.jsonl'),'');
  const files=[join(dir,'state.json'),join(dir,'events.jsonl'),controller.settingsPath],before=files.map(f=>hash(readFileSync(f)));
  controller.adapter=new Proxy({},{get(){throw new Error('must not touch product');}});
  const result=await controller.previewDataset({filePath:'chosen.xlsx'},async path=>({valid:true,path}));assert.equal(result.path,'chosen.xlsx');
  await assert.rejects(controller.previewDataset({},async()=>{throw new Error('读取失败');}),/读取失败/);assert.equal(controller.previewTask,null);
  assert.deepEqual(files.map(f=>hash(readFileSync(f))),before);assert.equal(controller.state.datasetId,'smoke');
});
test('正在发送时不预览；读取时禁止重复与新建，文件错误明确返回',async t=>{
  const root=scratch(t),controller=new Controller(root);controller.active=true;
  await assert.rejects(controller.previewDataset({},()=>{throw new Error('must not read');}),/先暂停/);controller.active=false;
  let release;const request=controller.previewDataset({filePath:'chosen.xlsx'},()=>new Promise(r=>{release=r;}));await Promise.resolve();
  await assert.rejects(controller.previewDataset({}),/上一项文件操作/);await assert.rejects(controller.start({datasetId:'smoke'}),/正在校验/);
  release({valid:true});await request;
  assert.throws(()=>previewDatasetFile('relative.xlsx'),/完整路径/);const invalid=join(root,'bad.xlsx');writeFileSync(invalid,'not an xlsx');
  await assert.rejects(previewDatasetFile(invalid),/读取未完成/);
});
test('预览API沿用本机鉴权，格式未通过也返回可查看的错误列表',async t=>{
  const root=scratch(t),token='preview-local-api-test-token-only',service=await serve({root,token});
  try {
    const endpoint=`http://127.0.0.1:${service.port}`,data={method:'POST',body:JSON.stringify({filePath:'chosen.xlsx'})};
    assert.equal((await fetch(endpoint+'/preview-dataset',data)).status,403);
    service.controller.previewDataset=async input=>({valid:false,issues:[{sheet:FLOW_SHEET,row:2,column:'G',message:'等待无效'}],path:input.filePath});
    const response=await fetch(endpoint+'/preview-dataset',{...data,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}});
    assert.equal(response.status,200);const r=(await response.json()).result;assert.equal(r.valid,false);assert.equal(r.issues[0].column,'G');
  } finally {await new Promise(r=>service.server.close(r));}
});
