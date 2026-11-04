import { readFile, mkdir, copyFile, writeFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hash } from '../../core/store.mjs';
import { beijingStamp } from '../../core/excel-results.mjs';
import { validateDatasetSheets,FLOW_SHEET,QUESTION_SHEET } from '../../core/dataset-preview.mjs';
import { readBook,sheetData,snapshotBook,assertPreserved,writeOutput,expandRow,formulaOf,plainValue } from './excel-book.mjs';
import { createFormulaEvaluator,cacheFormulaResult } from './formula-cache.mjs';

const check=(ok,message)=>{if(!ok)throw new Error(message);};
export async function writeExcelResult(input,{outputDirectory}={}){
  check(input.kind==='excel'&&input.records.length,'没有可写入的本轮Excel记录');
  const output=outputDirectory?resolve(outputDirectory):join(input.directory,'测评结果');await mkdir(output,{recursive:true});
  const generatedAt=Date.now(),id=randomUUID().slice(0,8),name=`豆包_${input.run.purpose==='technical_regression'?'技术回归结果':'测评结果'}_${beijingStamp(input.run.createdAt)}_${input.run.id.slice(-6)}_${id}`;
  const stage=join(output,'.生成中_'+id+'.xlsx'),file=join(output,name+'.xlsx'),reportFile=join(output,name+'.回填说明.json');
  try{
    await copyFile(input.template,stage,constants.COPYFILE_EXCL);check(hash(await readFile(stage))===input.templateHash,'本轮Excel快照已改变');
    const book=await readBook(stage),flow=book.getWorksheet(FLOW_SHEET),questions=book.getWorksheet(QUESTION_SHEET);
    check(flow&&questions,'缺少双工作表');
    const fdata=sheetData(flow),qdata=sheetData(questions),fv=fdata.values,qv=qdata.values;
    const preview=validateDatasetSheets({[FLOW_SHEET]:fdata,[QUESTION_SHEET]:qdata});
    check(preview.valid,'本轮模板已不符合双表格式');
    const before=snapshotBook(book),frozen=input.scenario.steps,source=new Map(frozen.map(s=>[s.id,s]));
    check(preview.steps.length===frozen.length&&preview.steps.every(s=>{const old=source.get(s.stepId);return old&&old.identityId===s.identityId
      &&old.conversationName===s.conversationId&&old.messages[0].send_text===s.content&&old.sourceStep.questionId===s.questionId;}),'模板步骤、会话、问题或原文与冻结流程不一致');
    const flowCols=new Map(fv[0].map((h,c)=>[h?.trim(),c+1])),qCols=new Map(qv[0].map((h,c)=>[h?.trim(),c+1]));
    const flowRows=new Map(preview.steps.map(s=>[s.stepId,s.sourceRow])),qRows=new Map(qv.slice(1).map((r,i)=>[r[qCols.get('问题ID')-1],i+2]));
    const keys=new Set(),changed=new Set(),resized=new Set(),formulaTargets=[],mappings=[],displayLimitedRows=[];
    const put=(sheet,row,col,value)=>{const cell=sheet.getCell(row,col);changed.add(sheet.name+'!'+cell.address);writeOutput(cell,value);};
    for(const r of input.records){
      check(!keys.has(r.stepId),'回复步骤重复');keys.add(r.stepId);
      const step=source.get(r.stepId),row=flowRows.get(r.stepId);check(step&&row!==undefined&&step.messages[0].send_text===r.prompt,'回复无法匹配到冻结步骤');
      check(['已完成','跳过'].includes(r.status)&&typeof r.answer==='string'&&r.answer.length<=32767&&hash(r.answer)===r.answerHash,'回复状态或正文无效');
      check(r.status!=='已完成'||r.answer.trim(),'已完成步骤不能填写空回答');check(r.status!=='跳过'||r.answer==='','跳过步骤不能伪造回答');
      let note=r.note||'';
      if(r.answer&&expandRow(flow,row,flowCols.get('实际回答'),r.answer,resized)){note+=(note?' ':'')+'长回答超出Excel行高显示范围，全文保留在单元格及运行备份。';displayLimitedRows.push(r.stepId);}
      expandRow(flow,row,flowCols.get('异常说明'),note,resized);
      put(flow,row,flowCols.get('实际回答'),r.answer);put(flow,row,flowCols.get('执行状态'),r.status);put(flow,row,flowCols.get('异常说明'),note);
      const questionId=step.sourceStep.questionId;
      if(questionId){const qr=qRows.get(questionId);check(qr!==undefined,'独立问题表缺少问题ID');
        for(const [header,value]of [['实际回答',r.answer],['执行状态',r.status]]){
          const cell=questions.getCell(qr,qCols.get(header));changed.add(questions.name+'!'+cell.address);
          if(formulaOf(cell))formulaTargets.push({sheet:questions,cell,expected:value,questionId});else writeOutput(cell,value);
        }
        if(r.answer)expandRow(questions,qr,qCols.get('实际回答'),r.answer,resized);
      }
      mappings.push({stepId:r.stepId,questionId:questionId||null,excelRow:row,status:r.status,source:r.source,
        answerHash:r.answerHash,replyFile:r.replyFile,userMessageId:r.userMessageId||null,answerMessageId:r.answerMessageId||null});
    }
    const evaluate=createFormulaEvaluator(book);
    for(const target of formulaTargets){
      let value;try{value=evaluate(target.sheet,target.cell);}catch(error){throw new Error(`问题${target.questionId}的${target.cell.address}关联公式无法核验：${error.message}`);}
      check((value??'')===target.expected,`问题${target.questionId}的关联公式未指向本步骤回答或状态，已取消生成`);
      cacheFormulaResult(target.cell,value);
    }
    book.calcProperties={...book.calcProperties,fullCalcOnLoad:true};
    assertPreserved(before,snapshotBook(book),changed,resized);
    await book.xlsx.writeFile(stage);
    const reopened=await readBook(stage),rf=reopened.getWorksheet(FLOW_SHEET),rq=reopened.getWorksheet(QUESTION_SHEET);
    assertPreserved(before,snapshotBook(reopened),changed,resized);
    for(const r of input.records){const step=source.get(r.stepId),row=flowRows.get(r.stepId);
      check((plainValue(rf.getCell(row,flowCols.get('实际回答')))??'')===r.answer&&plainValue(rf.getCell(row,flowCols.get('执行状态')))===r.status,'保存后全过程回填值核对失败');
      if(step.sourceStep.questionId){const qr=qRows.get(step.sourceStep.questionId);
        check((plainValue(rq.getCell(qr,qCols.get('实际回答')))??'')===r.answer&&plainValue(rq.getCell(qr,qCols.get('执行状态')))===r.status,'保存后独立问题表回答或公式缓存不一致');}
    }
    check(hash(await readFile(input.template))===input.templateHash,'原模板在生成期间发生变化');
    const counts={savedReplies:input.records.filter(r=>r.status==='已完成').length,processedRows:input.records.length,totalRows:frozen.length,
      questionsFilled:input.records.filter(r=>r.status==='已完成'&&source.get(r.stepId).sourceStep.questionId).length,
      questionsTotal:preview.summary.questions,unexecutedRows:frozen.length-input.records.length,
      skippedRows:input.records.filter(r=>r.status==='跳过').length,manualReplies:input.records.filter(r=>r.source==='manual_entry'&&r.status==='已完成').length};
    const resultHash=hash(await readFile(stage));
    await writeFile(reportFile,JSON.stringify({schemaVersion:1,backend:'exceljs',generatedAt,run:input.run,sourcePath:input.sourcePath,templateHash:input.templateHash,
      result:basename(file),resultHash,signature:input.signature,...counts,displayLimitedRows,rows:mappings,
      note:'执行完成不等于评分通过；回答关联公式已核验并更新缓存；其他公式保留，打开Excel时重算。人工录入不伪造平台编号或时间。'},null,2)+'\n',{flag:'wx'});
    await rename(stage,file);
    return {directory:output,file,report:reportFile,resultHash,runId:input.run.id,...counts,longReplyCount:displayLimitedRows.length,warnings:input.warnings||[]};
  }finally{await unlink(stage).catch(()=>{});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{let raw='';process.stdin.setEncoding('utf8');for await(const chunk of process.stdin){raw+=chunk;check(raw.length<=16*1024*1024,'回填数据超过本版16MB范围');}
    process.stdout.write(JSON.stringify({ok:true,result:await writeExcelResult(JSON.parse(raw))})+'\n');}
  catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message})+'\n');process.exitCode=1;}
}
