import { readFile, mkdir, copyFile, writeFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hash } from '../../core/store.mjs';
import { beijingStamp } from '../../core/excel-results.mjs';
import { validateDatasetSheets,FLOW_SHEET,QUESTION_SHEET } from '../../core/dataset-preview.mjs';

const check=(ok,message)=>{if(!ok)throw new Error(message);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sameText=(a,b)=>a===b||typeof b==='string'&&b.startsWith('=')&&a==="'"+b;
function fit(sheet,row,last,answer,col){
  const width=Number(sheet.getRangeByIndexes(0,col,1,1).format.columnWidthPx)||440;
  const lines=answer.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil([...line].reduce((sum,c)=>sum+(c.codePointAt(0)>255?15:8),0)/(width-20))),0);
  const needed=lines*21+18,range=sheet.getRangeByIndexes(row,0,1,last),current=Number(range.format.rowHeightPx)||0;
  if(needed>current)range.format.rowHeightPx=Math.min(546,needed);
  return needed>546;
}
export async function writeExcelResult(input){
  const {FileBlob,SpreadsheetFile}=await import('@oai/artifact-tool');
  check(input.kind==='excel'&&input.records.length,'没有可写入的本轮Excel记录');
  const output=join(input.directory,'测评结果');await mkdir(output,{recursive:true});
  const id=randomUUID().slice(0,8),name=`豆包_${input.run.purpose==='technical_regression'?'技术回归结果':'测评结果'}_${beijingStamp(input.run.createdAt)}_${input.run.id.slice(-6)}_${id}`;
  const stage=join(output,'.生成中_'+id+'.xlsx'),file=join(output,name+'.xlsx'),reportFile=join(output,name+'.回填说明.json');
  try{
    await copyFile(input.template,stage,constants.COPYFILE_EXCL);check(hash(await readFile(stage))===input.templateHash,'本轮Excel快照已改变');
    const wb=await SpreadsheetFile.importXlsx(await FileBlob.load(stage));
    const flow=wb.worksheets.getItem(FLOW_SHEET),questions=wb.worksheets.getItem(QUESTION_SHEET);
    const fv=flow.getUsedRange().values,qv=questions.getUsedRange().values,ff=flow.getUsedRange().formulas,qf=questions.getUsedRange().formulas;
    const preview=validateDatasetSheets({[FLOW_SHEET]:{values:fv,formulas:ff},[QUESTION_SHEET]:{values:qv,formulas:qf}});
    check(preview.valid,'本轮模板已不符合双表格式');
    const frozen=input.scenario.steps,source=new Map(frozen.map(s=>[s.id,s]));
    check(preview.steps.length===frozen.length&&preview.steps.every(s=>{const old=source.get(s.stepId);return old&&old.identityId===s.identityId
      &&old.conversationName===s.conversationId&&old.messages[0].send_text===s.content&&old.sourceStep.questionId===s.questionId;}),'模板步骤、会话、问题或原文与冻结流程不一致');
    const flowCols=new Map(fv[0].map((h,c)=>[h?.trim(),c])),qCols=new Map(qv[0].map((h,c)=>[h?.trim(),c]));
    const flowRows=new Map(preview.steps.map(s=>[s.stepId,s.sourceRow-1])),qRows=new Map(qv.slice(1).map((r,i)=>[r[qCols.get('问题ID')],i+1]));
    const records=new Map();for(const r of input.records){check(!records.has(r.stepId),'回复步骤重复');records.set(r.stepId,r);}
    const modifiedFlow=new Set(),modifiedQ=new Set(),mappings=[],displayLimitedRows=[];
    function write(sheet,row,col,value,modified){sheet.getCell(row,col).values=[[typeof value==='string'&&value.startsWith('=')?"'"+value:value]];modified.add(row+':'+col);}
    for(const r of input.records){
      const step=source.get(r.stepId),row=flowRows.get(r.stepId);check(step&&row!==undefined&&step.messages[0].send_text===r.prompt,'回复无法匹配到冻结步骤');
      check(['已完成','跳过'].includes(r.status)&&typeof r.answer==='string'&&r.answer.length<=32767&&hash(r.answer)===r.answerHash,'回复状态或正文无效');
      check(r.status!=='已完成'||r.answer.trim(),'已完成步骤不能填写空回答');
      let note=r.note||'';
      if(r.answer&&fit(flow,row,fv[0].length,r.answer,flowCols.get('实际回答'))){note+=(note?' ':'')+'长回答超出Excel行高显示范围，全文保留在单元格及运行备份。';displayLimitedRows.push(r.stepId);}
      write(flow,row,flowCols.get('实际回答'),r.answer,modifiedFlow);write(flow,row,flowCols.get('执行状态'),r.status,modifiedFlow);write(flow,row,flowCols.get('异常说明'),note,modifiedFlow);
      const questionId=step.sourceStep.questionId;
      if(questionId){const qr=qRows.get(questionId);check(qr!==undefined,'独立问题表缺少问题ID');
        for(const [h,value]of [['实际回答',r.answer],['执行状态',r.status]]){
          const col=qCols.get(h);modifiedQ.add(qr+':'+col);if(!qf[qr]?.[col])write(questions,qr,col,value,modifiedQ);
        }
        if(r.answer)fit(questions,qr,qv[0].length,r.answer,qCols.get('实际回答'));
      }
      mappings.push({stepId:r.stepId,questionId:questionId||null,excelRow:row+1,status:r.status,source:r.source,
        answerHash:r.answerHash,replyFile:r.replyFile,userMessageId:r.userMessageId||null,answerMessageId:r.answerMessageId||null});
    }
    wb.recalculate();const af=flow.getUsedRange().values,aq=questions.getUsedRange().values;
    for(const [before,after,modified]of [[fv,af,modifiedFlow],[qv,aq,modifiedQ]])for(let r=0;r<before.length;r++)for(let c=0;c<before[r].length;c++)
      if(!modified.has(r+':'+c))check(same(before[r][c],after[r][c]),`非回填区域意外改变：第${r+1}行第${c+1}列`);
    for(let r=0;r<ff.length;r++)for(let c=0;c<(ff[r]||[]).length;c++)if(ff[r][c])check(ff[r][c]===flow.getCell(r,c).formulas[0][0],'执行表公式被改变');
    for(let r=0;r<qf.length;r++)for(let c=0;c<(qf[r]||[]).length;c++)if(qf[r][c])check(qf[r][c]===questions.getCell(r,c).formulas[0][0],'问题表公式被改变');
    for(const r of input.records){const step=source.get(r.stepId),fr=flowRows.get(r.stepId);
      check(sameText(af[fr][flowCols.get('实际回答')],r.answer)&&af[fr][flowCols.get('执行状态')]===r.status,'全过程回填值核对失败');
      if(step.sourceStep.questionId){const qr=qRows.get(step.sourceStep.questionId);check(sameText(aq[qr][qCols.get('实际回答')],r.answer)&&aq[qr][qCols.get('执行状态')]===r.status,'独立问题表关联核对失败');}}
    await(await SpreadsheetFile.exportXlsx(wb)).save(stage);await rename(stage,file);
    const counts={savedReplies:input.records.filter(r=>r.status==='已完成').length,processedRows:input.records.length,totalRows:frozen.length,
      questionsFilled:input.records.filter(r=>r.status==='已完成'&&source.get(r.stepId).sourceStep.questionId).length,
      questionsTotal:preview.summary.questions,unexecutedRows:frozen.length-input.records.length,
      skippedRows:input.records.filter(r=>r.status==='跳过').length,manualReplies:input.records.filter(r=>r.source==='manual_entry'&&r.status==='已完成').length};
    const resultHash=hash(await readFile(file));
    await writeFile(reportFile,JSON.stringify({schemaVersion:1,run:input.run,sourcePath:input.sourcePath,templateHash:input.templateHash,
      result:basename(file),resultHash,signature:input.signature,...counts,displayLimitedRows,rows:mappings,
      note:'执行完成不等于评分通过；人工录入没有伪造产品消息编号或平台时间。'},null,2)+'\n',{flag:'wx'});
    return {directory:output,file,report:reportFile,resultHash,...counts,longReplyCount:displayLimitedRows.length};
  }finally{await unlink(stage).catch(()=>{});await unlink(stage+'.inspect.ndjson').catch(()=>{});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{let raw='';for await(const chunk of process.stdin){raw+=chunk;check(raw.length<=16*1024*1024,'回填数据超过本版16MB范围');}
    process.stdout.write(JSON.stringify({ok:true,result:await writeExcelResult(JSON.parse(raw))})+'\n');}
  catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message})+'\n');process.exitCode=1;}
}
