import { readFileSync, existsSync } from 'node:fs';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplyArchive } from './reply-archive.mjs';
import { loadExcelDataset } from './excel-dataset.mjs';
import { runResultWorker } from './excel-results.mjs';
import { hash, saveJSON } from './store.mjs';

export function excelArchive({directory,state,dataset}){
  const archives=new Map();
  return payload=>{
    const step=dataset.data.steps.find(s=>s.id===payload.completion.stepId);
    if(!step||step.execution!=='automatic')throw new Error('自动回复来源步骤不符');
    if(!archives.has(step.identityId))archives.set(step.identityId,new ReplyArchive({directory:join(directory,'身份',step.identityId),
      runId:state.runId,datasetId:'excel',datasetHash:state.datasetHash,account:state.account}));
    const result=archives.get(step.identityId).save({...payload,completion:{...payload.completion,target:step.conversationName}});
    const prefix='身份/'+step.identityId+'/';
    return {...result,replyFile:prefix+result.replyFile,conversationJson:prefix+result.conversationJson,
      conversationMarkdown:prefix+result.conversationMarkdown};
  };
}
function within(directory,relative){const file=resolve(directory,relative);if(!file.startsWith(resolve(directory)+sep))throw new Error('回复路径超出本轮目录');return file;}
export function collectExcelResultInput({directory,state}){
  const s=structuredClone(state),dataset=loadExcelDataset(directory,s),steps=new Map(dataset.data.steps.map(step=>[step.id,step])),records=[];
  const automatic=dataset.data.steps.filter(step=>step.execution==='automatic');
  const users=new Set(),answers=new Set();
  s.completions.forEach((c,i)=>{
    const step=steps.get(c.stepId),expected=automatic[i];
    if(!step||expected?.id!==step.id||c.target!==step.target||c.replyArchive?.status!=='saved')throw new Error('自动完成记录与冻结Excel顺序不一致');
    const r=JSON.parse(readFileSync(within(directory,c.replyArchive.replyFile),'utf8'));
    if(r.schemaVersion!==1||r.scope!=='this_run_script_turn'||r.sequence!==i+1||r.messageIndex!==0||r.runId!==s.runId||r.datasetId!=='excel'||r.datasetHash!==s.datasetHash||r.account!==s.account||r.key!==c.key
      ||r.stepId!==step.id||r.conversationId!==step.conversationName||r.prompt!==step.messages[0].send_text
      ||hash(r.prompt)!==r.promptHash||hash(r.answer)!==r.answerHash||r.answerHash!==c.answerHash
      ||r.userMessageId!==c.userMessageId||r.answerMessageId!==c.answerMessageId||r.href!==c.href
      ||r.answerCompletionObservedAt!==c.answerCompletionObservedAt||users.has(r.userMessageId)||answers.has(r.answerMessageId))throw new Error(`步骤${step.id}的回复来源、编号或正文校验失败`);
    users.add(r.userMessageId);answers.add(r.answerMessageId);
    records.push({stepId:step.id,prompt:r.prompt,answer:r.answer,answerHash:r.answerHash,status:'已完成',source:'cdp',
      note:r.completionTimeUncertain?'回复结束时间不确定，保留恢复后的观察记录。':'',replyFile:c.replyArchive.replyFile,
      userMessageId:r.userMessageId,answerMessageId:r.answerMessageId,completionTimeUncertain:r.completionTimeUncertain});
  });
  for(const meta of Object.values(s.manualResults||{})){
    const r=JSON.parse(readFileSync(within(directory,meta.file),'utf8')),step=steps.get(r.stepId);
    if(r.schemaVersion!==1||r.scope!=='operator_entered_reply'||step?.execution!=='manual'||meta.stepId!==r.stepId||meta.target!==r.target
      ||meta.confirmedAt!==r.confirmedAt||meta.account!==r.account||r.runId!==s.runId||r.datasetHash!==s.datasetHash||r.target!==step.target
      ||r.prompt!==step.messages[0].send_text||r.promptHash!==hash(r.prompt)||hash(r.answer)!==r.answerHash||r.answerHash!==meta.answerHash
      ||!['已完成','跳过'].includes(r.status)||r.status!==meta.status)throw new Error('人工记录与冻结步骤或正文不一致');
    records.push({stepId:r.stepId,prompt:r.prompt,answer:r.answer,answerHash:r.answerHash,status:r.status,source:'manual_entry',
      note:r.status==='跳过'?r.reason:`${r.reason} 人工账号标识：${r.account}`,replyFile:meta.file,completionTimeUncertain:r.completionTimeUncertain});
  }
  if(!records.length)throw new Error('本轮尚无已保存的回复或人工处理记录');
  records.sort((a,b)=>dataset.data.steps.findIndex(s=>s.id===a.stepId)-dataset.data.steps.findIndex(s=>s.id===b.stepId));
  const signature=hash(JSON.stringify([s.runId,s.datasetHash,records]));
  return {schemaVersion:1,kind:'excel',product:'豆包',directory:resolve(directory),template:join(directory,'输入测评集.xlsx'),
    templateHash:dataset.data.source.sha256,sourcePath:dataset.data.source.path,signature,scenario:dataset.data,records,
    run:{id:s.runId,datasetId:'excel',datasetHash:s.datasetHash,account:s.account,purpose:s.purpose,createdAt:s.createdAt,
      phase:s.phase,status:s.status,snapshotAt:Date.now(),totalAutomatic:dataset.automaticTotal,totalRows:dataset.total}};
}
export function runExcelResultWorker(input){return runResultWorker(input,{worker:fileURLToPath(new URL('../tools/spreadsheets/excel-results-worker.mjs',import.meta.url))});}

export async function publishResultCopy(result,input){
  const destination=join(dirname(input.sourcePath),basename(result.file));
  let copyStatus='saved',copyError='';
  try{
    const original=await readFile(result.file),digest=hash(original);
    if(result.resultHash&&result.resultHash!==digest)throw new Error('本轮结果文件已经改动，不能将它作为原结果补存');
    if(existsSync(destination)){
      if(hash(await readFile(destination))!==digest)throw new Error('原表目录已有同名但内容不同的结果，禁止覆盖');
    }else await copyFile(result.file,destination,constants.COPYFILE_EXCL);
    if(hash(await readFile(destination))!==digest)throw new Error('原表目录结果副本校验失败');
    if(result.report){const target=join(dirname(input.sourcePath),basename(result.report));
      if(!existsSync(target))await copyFile(result.report,target,constants.COPYFILE_EXCL);}
  }catch(error){copyStatus='failed';copyError=error.message;}
  const published={...result,sourceFile:destination,copyStatus,copyError,signature:input.signature};
  try{saveJSON(join(input.directory,'结果副本状态.json'),{schemaVersion:1,runId:input.run.id,signature:input.signature,result:published,updatedAt:Date.now()});}
  catch(error){published.warning='结果已生成，但副本状态保存失败：'+error.message;}
  return published;
}
export async function generateExcelResults(input,worker=runExcelResultWorker){
  const file=join(input.directory,'结果副本状态.json');
  if(existsSync(file)){
    const receipt=JSON.parse(readFileSync(file,'utf8'));
    if(receipt.runId===input.run.id&&receipt.signature===input.signature&&receipt.result.copyStatus==='failed'&&existsSync(receipt.result.file)
      &&hash(await readFile(receipt.result.file))===receipt.result.resultHash)
      return publishResultCopy(receipt.result,input);
  }
  return publishResultCopy(await worker(input),input);
}
