import { Engine } from './engine.mjs';
import { Interrupted, ReviewRequired } from './store.mjs';

export class ManualStepRequired extends Interrupted {
  constructor(step){super('awaiting_manual');this.name='ManualStepRequired';this.message=`已到人工步骤 ${step.id}（身份${step.identityId}、${step.conversationName}），请打开“人工步骤”处理。`;}
}
export class ExcelEngine extends Engine {
  complete(...args){super.complete(...args);this.state.activity=`自动回复已保存${this.state.completions.length}条，人工已处理${Object.keys(this.state.manualResults||{}).length}条`;this.persist();}
  initializeTiming(){
    this.state.intervals||=[];
    const policy={id:'excel_reply_gap_v1',overridesSourceWaits:false};
    if(this.state.timingPolicy&&this.state.timingPolicy.id!==policy.id)throw new Error('Excel断点计时规则不一致');
    if(!this.state.timingPolicy){this.state.timingPolicy=policy;this.persist();this.event('timing_policy','按Excel每行的回复后等待秒数执行，恢复不重置截止时间',policy);}
  }
  hasLaterAutomaticMessage(){return this.state.stepIndex+1<this.dataset.data.steps.length;}
  replyWait(startedAt,nextPhase){
    const seconds=this.dataset.data.steps[this.state.stepIndex].replyAfterSeconds,gapMs=seconds*1000;
    if(!Number.isSafeInteger(gapMs)||gapMs<0)throw new Error('Excel等待秒数无效');
    return {startedAt,deadline:startedAt+gapMs,gapMs,label:`回答已完成，按表等待${seconds}秒`,nextPhase};
  }
  async tick(){
    const step=this.dataset.data.steps[this.state.stepIndex];
    if(step?.execution==='manual'&&this.state.phase==='gap'){
      await this.waitForDeadline(this.state.wait);this.state.phase=this.state.wait.nextPhase||'navigation';
      this.state.wait=null;this.persist();return;
    }
    // Finish the preceding reply gap before exposing the next manual action.
    if(step?.execution==='manual'&&this.state.phase!=='gap'){
      if(await this.processRename())return;
      this.state.phase='manual';this.state.status='awaiting_manual';this.state.activity=`等待人工处理 ${step.id}`;
      this.state.observation=null;this.persist();throw new ManualStepRequired(step);
    }
    return super.tick();
  }
  async navigate(index){
    const step=this.dataset.data.steps[index];
    if(step.execution!=='automatic')throw new Error('人工消息不能交给自动发送器');
    if(step.identityId!==this.dataset.data.automatic_identity)throw new Error('自动账号身份不一致');
    const unverified=Object.values(this.state.manualResults||{}).some(r=>r.status==='已完成'&&r.target===step.target);
    if(unverified)throw new ReviewRequired('此会话含人工录入且未核验消息编号，不能自动追加；请另用独立会话或核对执行方案。','manual_conversation_unverified');
    return super.navigate(index);
  }
  recordInterval(pending,now){
    const previous=this.state.lastManualResponse,last=this.state.completions.at(-1);
    if(!previous||last&&last.answerCompletionObservedAt>previous.confirmedAt)return super.recordInterval(pending,now);
    if(pending.intervalRecorded)return;
    if(now<previous.nextAllowedAt)throw new Error('人工步骤后的测评间隔尚未结束');
    const record={previousKey:previous.key,nextKey:`${pending.stepId}:${pending.messageIndex}`,
      answerCompletionObservedAt:previous.confirmedAt,plannedGapMs:previous.gapMs,earliestSendAt:previous.nextAllowedAt,
      sendAttemptedAt:now,actualGapMs:now-previous.confirmedAt,additionalMs:now-previous.nextAllowedAt,
      completionTimeUncertain:true,source:'manual_confirmation'};
    this.state.intervals.push(record);pending.intervalRecorded=true;this.event('message_interval','按人工确认时间记录后续间隔，非平台精确回复时间',record);
  }
}
