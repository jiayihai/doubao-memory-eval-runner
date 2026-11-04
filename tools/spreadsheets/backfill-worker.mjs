import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../../core/store.mjs';
import { buildFillPlan } from '../../core/excel-results.mjs';
import { validateDatasetSheets,FLOW_SHEET,QUESTION_SHEET } from '../../core/dataset-preview.mjs';
import { readBook,sheetData } from './excel-book.mjs';
import { writeExcelResult } from './excel-results-worker.mjs';

export async function generateResultWorkbook(input,{outputDirectory}={}){
  if(input.product!=='豆包'||input.run?.datasetId!=='doubao-b')throw new Error('当前只支持豆包旧B结果表');
  const book=await readBook(input.template),flow=sheetData(book.getWorksheet(FLOW_SHEET)),questions=sheetData(book.getWorksheet(QUESTION_SHEET));
  if(!flow||!questions)throw new Error('缺少双工作表');
  const plan=buildFillPlan(input,flow.values,questions.values),preview=validateDatasetSheets({[FLOW_SHEET]:flow,[QUESTION_SHEET]:questions});
  if(!preview.valid)throw new Error('旧B模板不符合双表格式');
  const records=plan.fills.map(item=>{
    const row=flow.values[item.row-1],turn=input.turns.find(turn=>turn.key===item.key);
    return {stepId:row[0],prompt:row[5],answer:item.answer,answerHash:hash(item.answer),status:item.status,source:'cdp',note:item.note,
      replyFile:turn?.replyFile,userMessageId:turn?.userMessageId,answerMessageId:turn?.answerMessageId};
  });
  const steps=preview.steps.map(s=>({id:s.stepId,identityId:s.identityId,conversationName:s.conversationId,messages:[{send_text:s.content}],sourceStep:s}));
  return writeExcelResult({...input,kind:'excel',sourcePath:input.template,scenario:{kind:'excel',steps},records,warnings:plan.warnings},{outputDirectory});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{let raw='';process.stdin.setEncoding('utf8');for await(const chunk of process.stdin){raw+=chunk;if(raw.length>16*1024*1024)throw new Error('回填输入过大');}
    process.stdout.write(JSON.stringify({ok:true,result:await generateResultWorkbook(JSON.parse(raw))})+'\n');}
  catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message})+'\n');process.exitCode=1;}
}
