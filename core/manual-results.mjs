import { join, resolve, dirname } from 'node:path';
import { existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { hash, saveJSON } from './store.mjs';

export function manualStepDetails(state,dataset,now=Date.now()){
  const step=dataset.data.steps[state.stepIndex];
  if(step?.execution!=='manual')return null;
  const source=step.sourceStep;let readyAt=state.wait?.deadline||0,latestAt=null,preconditionError='';
  if(source.anchorQuestionId){
    const anchor=dataset.data.steps.find(s=>s.sourceStep.questionId===source.anchorQuestionId);
    const auto=state.completions.find(c=>c.stepId===anchor?.id),manual=state.manualResults?.[anchor?.id];
    const time=auto?.answerCompletionObservedAt||(manual?.status==='已完成'?manual.confirmedAt:null);
    if(!time)preconditionError='计时锚点问题没有已完成的回答，不能确认本步有效执行';
    else{readyAt=Math.max(readyAt,time+source.minAfterAnchorSeconds*1000);latestAt=time+source.maxAfterAnchorSeconds*1000;}
  }
  if(latestAt&&now>latestAt)preconditionError='已超过本步计时窗口，请记录前提未满足或跳过原因';
  return {stepId:step.id,identityId:step.identityId,conversationId:step.conversationName,
    content:source.content,constraint:source.constraint,questionId:source.questionId,
    readyAt,latestAt,remainingSeconds:Math.max(0,Math.ceil((readyAt-now)/1000)),preconditionError,
    defaultAccount:state.identityAccounts?.[step.identityId]||'',automaticAccount:state.account,
    independentIdentity:step.identityId!==dataset.data.automatic_identity,
    remaining:dataset.data.steps.slice(state.stepIndex).filter(s=>s.execution==='manual').length};
}
function atomicText(path,text){mkdirSync(dirname(path),{recursive:true});writeFileSync(path+'.tmp',text,'utf8');renameSync(path+'.tmp',path);}
function fence(text){const f='`'.repeat(Math.max(3,...(text.match(/`+/g)||[]).map(s=>s.length+1)));return f+'text\n'+text+'\n'+f;}
export function commitManualResult({directory,state,dataset,options,now=Date.now()}){
  const details=manualStepDetails(state,dataset,now),step=dataset.data.steps[state.stepIndex];
  if(!details||options.stepId!==step.id)throw new Error('人工步骤已变化，请刷新后核对，不能重复提交');
  const skipped=options.skip===true;
  const carriedWait=state.wait&&state.wait.deadline>now?structuredClone(state.wait):null;
  if(!skipped){
    if(now<details.readyAt)throw new Error(`仍需等待${details.remainingSeconds}秒；请到时间后再人工发送本步`);
    if(details.preconditionError)throw new Error(details.preconditionError);
    if(options.confirmed!==true)throw new Error('请确认按本行原文和约束，在指定身份执行并保存首次完整回答');
    if(typeof options.answer!=='string'||!options.answer.trim())throw new Error('请粘贴首次完整回复，不能将空回答确认成已完成');
    if(options.answer.length>32767)throw new Error('人工回答超过Excel单元格上限，请保留原始证据后单独处理');
    if(typeof options.account!=='string'||!options.account.trim())throw new Error('请填写实际人工账号标识');
    if(details.independentIdentity&&options.account.trim()===state.account)throw new Error('此身份要求独立账号，不能与自动测试账号使用相同标识');
    if(state.identityAccounts?.[step.identityId]&&state.identityAccounts[step.identityId]!==options.account.trim())throw new Error('同一身份的人工账号标识与此前记录不同');
  }else if(typeof options.reason!=='string'||!options.reason.trim())throw new Error('跳过步骤须填写原因；前提不满足可记录PRECONDITION_UNMET');
  const base={schemaVersion:1,scope:'operator_entered_reply',runId:state.runId,datasetHash:state.datasetHash,
    stepId:step.id,key:step.id+':0',target:step.target,identityId:step.identityId,conversationId:step.conversationName,
    questionId:step.sourceStep.questionId||null,prompt:step.messages[0].send_text,promptHash:hash(step.messages[0].send_text),
    status:skipped?'跳过':'已完成',answer:skipped?'':options.answer,account:skipped?'':options.account.trim(),
    reason:skipped?options.reason.trim():'人工确认并粘贴；产品消息ID及真实回复结束时间未经CDP核验。'};
  base.answerHash=hash(base.answer);
  const file=join(directory,'人工记录',step.id+'.json');let record;
  if(existsSync(file)){
    record=JSON.parse(readFileSync(file,'utf8'));
    for(const k of Object.keys(base))if(record[k]!==base[k])throw new Error('此步骤已有不同人工记录，请核对；不会覆盖或重发');
  }else{record={...base,confirmedAt:now,completionTimeUncertain:!skipped};saveJSON(file,record);}
  // Derive a separately labelled manual backup. No fictitious product IDs or
  // platform timestamps are attached to operator-entered evidence.
  const all=readdirSync(join(directory,'人工记录')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(join(directory,'人工记录',n),'utf8')));
  for(const item of all){const origin=dataset.data.steps.find(s=>s.id===item.stepId);
    if(item.runId!==state.runId||item.datasetHash!==state.datasetHash||item.scope!=='operator_entered_reply'||origin?.execution!=='manual'
      ||origin.messages[0].send_text!==item.prompt||hash(item.prompt)!==item.promptHash||hash(item.answer)!==item.answerHash)
      throw new Error('人工记录混入其他来源或正文已改变，不能推进步骤');}
  const pairs=all.filter(r=>r.identityId===record.identityId&&r.conversationId===record.conversationId&&r.status==='已完成')
    .sort((a,b)=>dataset.data.steps.findIndex(s=>s.id===a.stepId)-dataset.data.steps.findIndex(s=>s.id===b.stepId));
  if(pairs.length){
    const backup=join(directory,'身份',record.identityId,'人工会话备份',record.conversationId);
    saveJSON(backup+'.json',{schemaVersion:1,runId:state.runId,scope:'operator_entered_replies',identityId:record.identityId,
      conversationId:record.conversationId,note:'人工确认及粘贴，未由CDP核验产品消息编号或平台时间。',turns:pairs});
    atomicText(backup+'.md',[`# ${record.conversationId}`,'','人工录入备份；不等同于已核验的产品会话导出。','',
      ...pairs.flatMap(r=>[`## ${r.stepId}`,'','### 人工发送原文','',fence(r.prompt),'','### 人工粘贴首次回复','',fence(r.answer),''])].join('\n'));
  }
  state.manualResults||={};state.identityAccounts||={};
  if(!skipped)state.identityAccounts[step.identityId]=record.account;
  state.manualResults[step.id]={stepId:step.id,key:record.key,target:step.target,status:record.status,confirmedAt:record.confirmedAt,
    file:'人工记录/'+step.id+'.json',answerHash:record.answerHash,identityId:step.identityId,account:record.account,reason:record.reason};
  const gapMs=step.replyAfterSeconds*1000;
  if(!skipped)state.lastManualResponse={key:record.key,confirmedAt:record.confirmedAt,gapMs,nextAllowedAt:record.confirmedAt+gapMs};
  state.stepIndex++;state.messageIndex=0;state.transitionIndex=0;state.pending=null;state.manualPending=null;
  if(state.stepIndex>=dataset.data.steps.length){state.phase='finished';state.status='completed';state.wait=null;state.finishedAt=now;state.activity='表内全部步骤已处理，人工结果保留录入来源说明';}
  else{state.phase=(!skipped&&gapMs>0)||carriedWait?'gap':'navigation';state.status='paused';
    state.wait=!skipped&&gapMs>0?{startedAt:record.confirmedAt,deadline:record.confirmedAt+gapMs,gapMs,label:`人工回复已确认，按表等待${step.replyAfterSeconds}秒`,nextPhase:'navigation'}:carriedWait;
    state.activity='人工结果已保存；可处理下一人工步骤，或点击继续恢复自动流程';}
  return record;
}
