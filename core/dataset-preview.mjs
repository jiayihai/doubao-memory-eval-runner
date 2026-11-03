import { statSync } from 'node:fs';
import { isAbsolute, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const FLOW_SHEET = '全过程执行表', QUESTION_SHEET = '独立问题表';
export const FLOW_REQUIRED = ['步骤ID','身份ID','会话ID','消息类型','问题ID','发送内容','回复后等待秒数',
  '执行方式','实际回答','执行状态','异常说明'];
export const QUESTION_REQUIRED = ['问题ID','用例ID','测评能力','测试问题','预期回答要点','评分标准','实际回答','执行状态'];
const empty = x => x === null || x === undefined || x === '';
const text = x => typeof x === 'string' && x.trim().length > 0;
const columnName = n => { let s=''; for(n++; n; n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s; return s; };

// Pure format validation. This produces a plan to inspect, never an executable
// dataset, a sender state, a product operation, or a workbook modification.
export function validateDatasetSheets(sheets) {
  const issues=[],steps=[],questions=[];
  const issue=(severity,sheet,row,column,message)=>issues.push({severity,sheet,row,column,message});
  function table(name, required) {
    const sheet=sheets[name];
    if(!sheet) {issue('error',name,null,null,`缺少工作表“${name}”`);return null;}
    const values=sheet.values||[], formulas=sheet.formulas||[];
    if(!values.length||!text(values[0]?.[0]))issue('error',name,1,'A','表头须从第1行A列开始');
    const headers=new Map();
    (values[0]||[]).forEach((h,c)=>{
      if(empty(h)) {
        if(values.slice(1).some(row=>!empty(row?.[c])))issue('error',name,1,columnName(c),'此列有数据但缺少表头');
        return;
      }
      if(!text(h))return issue('error',name,1,columnName(c),'表头必须是文字');
      const key=h.trim();
      if(headers.has(key))issue('error',name,1,columnName(c),`表头“${key}”重复`);
      else headers.set(key,c);
      if(key!==h)issue('warning',name,1,columnName(c),`表头“${key}”的首尾空格已在预览中忽略，建议修正原文件`);
      if(formulas[0]?.[c])issue('error',name,1,columnName(c),'表头不支持公式');
    });
    for(const h of required)if(!headers.has(h))issue('error',name,1,null,`缺少必需字段“${h}”`);
    const cell=(row,h)=>values[row]?.[headers.get(h)];
    const report=(severity,row,h,message)=>issue(severity,name,row+1,headers.has(h)?columnName(headers.get(h)):null,message);
    return {values,formulas,headers,cell,report};
  }
  const flow=table(FLOW_SHEET,FLOW_REQUIRED),qtable=table(QUESTION_SHEET,QUESTION_REQUIRED);
  const allStepNumbers=new Set(),allStepIds=new Set(),allFlowQuestions=new Map(),allQuestions=new Map();
  function identifier(value,t,row,h,{conversation=false}={}) {
    if(!text(value)) {t.report('error',row,h,`${h}不能为空，且必须是文字`);return false;}
    if(value!==value.trim()||/\s/u.test(value)){t.report('error',row,h,`${h}不能包含空白字符`);return false;}
    if(conversation&&(!/^[\p{L}\p{N}_.-]{1,80}$/u.test(value)||value==='.'||value==='..'||/\.$/.test(value)
      ||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value))) {
      t.report('error',row,h,'会话ID须为1—80个文字、数字、下划线、点或横线，不能使用系统保留文件名');return false;
    }
    return true;
  }
  if(flow)for(let r=1;r<flow.values.length;r++) {
    if((flow.values[r]||[]).every(empty)&&(flow.formulas[r]||[]).every(empty))continue;
    const get=h=>flow.cell(r,h),id=get('步骤ID'),identity=get('身份ID'),conversation=get('会话ID'),type=get('消息类型'),
      qid=get('问题ID'),content=get('发送内容'),wait=get('回复后等待秒数'),mode=get('执行方式');
    const match=typeof id==='string'?/^S([0-9]{1,8})$/.exec(id):null,number=match?Number(match[1]):null;
    if(!match||number<1)flow.report('error',r,'步骤ID','步骤ID须为S加正整数，例如S0001');
    else {
      if(allStepNumbers.has(number)||allStepIds.has(id))flow.report('error',r,'步骤ID','步骤ID或其数字序号重复（S01与S0001也视为同序号）');
      allStepNumbers.add(number);allStepIds.add(id);
    }
    identifier(identity,flow,r,'身份ID');identifier(conversation,flow,r,'会话ID',{conversation:true});
    if(!['HISTORY','QUESTION'].includes(type))flow.report('error',r,'消息类型','消息类型仅支持HISTORY或QUESTION');
    if(!['AUTO','MANUAL'].includes(mode))flow.report('error',r,'执行方式','执行方式仅支持AUTO或MANUAL');
    if(!text(content))flow.report('error',r,'发送内容','发送内容不能为空，且必须是原文文字');
    else if(content.length>32767)flow.report('error',r,'发送内容','发送内容超过Excel单元格32767字符上限');
    if(!Number.isInteger(wait)||wait<0||wait>604800)flow.report('error',r,'回复后等待秒数','本版等待时间须为0—604800的整数秒，不支持文字时间或随机规则');
    for(const h of [...FLOW_REQUIRED.slice(0,8),'计时锚点问题ID','距锚点最早秒数','距锚点最晚秒数'])
      if(flow.formulas[r]?.[flow.headers.get(h)])flow.report('error',r,h,'执行输入须填写固定值，不支持公式');
    if(!empty(get('实际回答'))||!empty(get('异常说明'))||(!empty(get('执行状态'))&&get('执行状态')!=='未执行'))
      flow.report('error',r,'实际回答','此行已有回答、异常说明或执行结果；请选空白测评集模板');
    const step={sourceRow:r+1,stepId:typeof id==='string'?id:'',stepNumber:number,
      identityId:typeof identity==='string'?identity:'',conversationId:typeof conversation==='string'?conversation:'',
      messageType:typeof type==='string'?type:'',questionId:typeof qid==='string'?qid:'',
      content:typeof content==='string'?content:'',waitSeconds:Number.isInteger(wait)?wait:null,
      mode:typeof mode==='string'?mode:'',constraint:typeof get('执行约束')==='string'?get('执行约束'):'',
      anchorQuestionId:get('计时锚点问题ID')||'',minAfterAnchorSeconds:get('距锚点最早秒数')??null,
      maxAfterAnchorSeconds:get('距锚点最晚秒数')??null};
    steps.push(step);
    if(type==='QUESTION') {
      if(identifier(qid,flow,r,'问题ID')) {
        const key=qid.toUpperCase();
        if(allFlowQuestions.has(key))flow.report('error',r,'问题ID','问题ID重复（Excel匹配不区分英文大小写）');
        else allFlowQuestions.set(key,step);
      }
    } else if(!empty(qid))flow.report('error',r,'问题ID','HISTORY行的问题ID必须留空');
    if(mode==='MANUAL')flow.report('warning',r,'执行方式','人工节点仅作预览，不能自动发送；需保留其时点和操作约束');
  }
  if(!steps.length)issue('error',FLOW_SHEET,2,null,'执行表中没有消息');
  if(steps.length>10000)issue('error',FLOW_SHEET,null,null,'本版预览最多支持10000条消息');
  steps.sort((a,b)=>(a.stepNumber??Infinity)-(b.stepNumber??Infinity)||a.sourceRow-b.sourceRow);
  if(steps.some((s,i)=>i&&s.sourceRow<steps[i-1].sourceRow))issue('warning',FLOW_SHEET,null,flow?.headers.has('步骤ID')?columnName(flow.headers.get('步骤ID')):null,'原表行顺序与步骤ID不同，预览已按步骤ID的数字部分升序排列；原文件未修改');
  const conversations=new Map(),identities=new Set(),autoConversations=new Set();let previous=null;
  steps.forEach((step,i)=>{
    step.order=i+1;
    const key=step.identityId+'\u0000'+step.conversationId,fold=key.toUpperCase();
    if(conversations.has(fold)&&conversations.get(fold)!==key)flow.report('error',step.sourceRow-1,'会话ID','同身份下会话ID仅大小写不同，会导致备份或定位冲突');
    step.navigation=previous===key?'continue':conversations.has(fold)?'return':'new';
    step.navigationLabel={new:'新建并命名',continue:'继续当前会话',return:'返回已有会话'}[step.navigation];
    conversations.set(fold,key);identities.add(step.identityId);if(step.mode==='AUTO')autoConversations.add(fold);previous=key;
  });
  if(identities.size>1)issue('warning',FLOW_SHEET,null,null,'包含多个身份；身份ID不等于真实账号隔离，后续执行需另行处理账号切换');
  if(qtable)for(let r=1;r<qtable.values.length;r++) {
    if((qtable.values[r]||[]).every(empty)&&(qtable.formulas[r]||[]).every(empty))continue;
    const get=h=>qtable.cell(r,h),qid=get('问题ID');
    if(!identifier(qid,qtable,r,'问题ID'))continue;
    if(allQuestions.has(qid.toUpperCase()))qtable.report('error',r,'问题ID','独立问题表的问题ID重复（不区分英文大小写）');
    else allQuestions.set(qid.toUpperCase(),{row:r+1,id:qid});
    for(const h of ['用例ID','测评能力','测试问题','预期回答要点','评分标准'])if(!text(get(h)))qtable.report('error',r,h,`${h}不能为空，且必须是文字`);
    for(const h of [...QUESTION_REQUIRED.filter(h=>!['实际回答','执行状态'].includes(h)),'前置问题ID','步骤ID','身份ID','会话ID'])
      if(qtable.formulas[r]?.[qtable.headers.get(h)])qtable.report('error',r,h,'题目、预期及评分字段须填写固定值，不支持公式');
    const linked=allFlowQuestions.get(qid.toUpperCase());
    if(!linked)qtable.report('error',r,'问题ID','此问题ID在执行表没有对应的QUESTION行');
    else {
      if(qid!==linked.questionId)qtable.report('error',r,'问题ID','双表问题ID大小写不一致，须逐字相同');
      if(get('测试问题')!==linked.content)qtable.report('error',r,'测试问题','测试问题与执行表对应发送内容不完全一致');
      for(const [h,k]of [['步骤ID','stepId'],['身份ID','identityId'],['会话ID','conversationId']])
        if(qtable.headers.has(h)&&get(h)!==linked[k])qtable.report('error',r,h,`${h}与执行表对应问题不一致`);
    }
    if(!empty(get('实际回答'))||(!empty(get('执行状态'))&&get('执行状态')!=='未执行'))qtable.report('error',r,'实际回答','问题表已有实际回答或执行结果；请选空白模板');
    const raw=get('前置问题ID');
    if(!empty(raw)&&typeof raw!=='string')qtable.report('error',r,'前置问题ID','前置问题ID须为文字，多个ID用英文分号分隔');
    questions.push({id:qid,sourceRow:r+1,step:linked,prerequisites:typeof raw==='string'?raw.split(';').map(x=>x.trim()).filter(Boolean):[]});
  }
  for(const step of steps.filter(s=>s.messageType==='QUESTION'))if(!allQuestions.has(step.questionId.toUpperCase()))
    issue('error',FLOW_SHEET,step.sourceRow,flow?.headers.has('问题ID')?columnName(flow.headers.get('问题ID')):null,'此问题ID在独立问题表没有对应题目');
  for(const q of questions)for(const id of q.prerequisites) {
    const prerequisite=allFlowQuestions.get(id.toUpperCase());
    if(!prerequisite||!allQuestions.has(id.toUpperCase()))qtable.report('error',q.sourceRow-1,'前置问题ID',`找不到前置问题“${id}”`);
    else if(prerequisite.questionId!==id||prerequisite.order>=(q.step?.order??0))qtable.report('error',q.sourceRow-1,'前置问题ID',`前置问题“${id}”须大小写一致，且出现在当前问题之前，不能自引用或循环依赖`);
  }
  for(const step of steps) {
    if(!empty(step.anchorQuestionId)) {
      const anchor=typeof step.anchorQuestionId==='string'?allFlowQuestions.get(step.anchorQuestionId.toUpperCase()):null;
      if(!anchor||anchor.questionId!==step.anchorQuestionId||anchor.order>=step.order)flow.report('error',step.sourceRow-1,'计时锚点问题ID','计时锚点须精确引用此前的QUESTION问题ID');
      if(!Number.isSafeInteger(step.minAfterAnchorSeconds)||step.minAfterAnchorSeconds<0||!Number.isSafeInteger(step.maxAfterAnchorSeconds)
        ||step.maxAfterAnchorSeconds<step.minAfterAnchorSeconds)flow.report('error',step.sourceRow-1,'距锚点最早秒数','计时锚点需同时提供有效的最早/最晚整数秒数，最晚不得早于最早');
    } else if(!empty(step.minAfterAnchorSeconds)||!empty(step.maxAfterAnchorSeconds))flow.report('error',step.sourceRow-1,'计时锚点问题ID','填写了距锚点时间，但缺少计时锚点问题ID');
  }
  const errors=issues.filter(x=>x.severity==='error'),warnings=issues.filter(x=>x.severity==='warning');
  return {schemaVersion:1,scope:'validation_and_preview_only',valid:errors.length===0,
    summary:{total:steps.length,automatic:steps.filter(s=>s.mode==='AUTO').length,manual:steps.filter(s=>s.mode==='MANUAL').length,
      history:steps.filter(s=>s.messageType==='HISTORY').length,questions:steps.filter(s=>s.messageType==='QUESTION').length,
      conversations:conversations.size,automaticConversations:autoConversations.size,identities:identities.size,
      errors:errors.length,warnings:warnings.length},steps,issues:[...errors,...warnings]};
}

export function previewDatasetFile(filePath,{worker=fileURLToPath(new URL('../tools/spreadsheets/preview-worker.mjs',import.meta.url)),timeoutMs=120000}={}) {
  if(typeof filePath!=='string'||!isAbsolute(filePath)||extname(filePath).toLowerCase()!=='.xlsx')throw new Error('请选择本地.xlsx测评集文件的完整路径');
  const file=resolve(filePath),stat=statSync(file);
  if(!stat.isFile()||stat.size===0||stat.size>20*1024*1024)throw new Error('请选择非空、大小不超过20MB的.xlsx文件');
  return new Promise((resolveResult,reject)=>{
    const child=spawn(process.execPath,[worker,file],{stdio:['ignore','pipe','pipe'],windowsHide:true});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');let stdout='',stderr='',settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolveResult(result);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('测评集读取超时，原文件未改动，请稍后重试'));},timeoutMs);
    child.on('error',error=>finish(error));
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>16*1024*1024){child.kill();finish(new Error('预览内容超过本版16MB上限，请拆分测评集后重试'));}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
    child.on('close',code=>{if(settled)return;try{const result=JSON.parse(stdout.trim().split(/\r?\n/).at(-1));if(code!==0||!result.ok)throw new Error(result.error||stderr||'表格读取失败');finish(null,result.result);}catch(error){finish(new Error(`测评集读取未完成：${error.message}`));}});
  });
}
