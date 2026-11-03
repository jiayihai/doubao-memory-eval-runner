import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../../core/store.mjs';
import { validateDatasetSheets, FLOW_SHEET, QUESTION_SHEET } from '../../core/dataset-preview.mjs';

export async function inspectDatasetFile(filePath) {
  let runtime;
  try { runtime=await import('@oai/artifact-tool'); }
  catch { throw new Error('找不到表格处理运行库，请检查tools/spreadsheets/node_modules'); }
  const bytes=await readFile(filePath),sourceHash=hash(bytes);
  const workbook=await runtime.SpreadsheetFile.importXlsx(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const sheets={};
  for(const name of [FLOW_SHEET,QUESTION_SHEET]) {
    let sheet;
    try { sheet=workbook.worksheets.getItem(name); } catch { continue; }
    if(!sheet)continue;
    const range=sheet.getUsedRange(true);
    if(!range){sheets[name]={values:[],formulas:[]};continue;}
    const values=range.values;
    if(values.length>10001||values.some(r=>r.length>128))throw new Error(`工作表“${name}”超过本版10000数据行或128列的预览范围`);
    if(!sheet.getRange('A1').values[0][0])sheets[name]={values:[],formulas:[]};
    else sheets[name]={values,formulas:range.formulas};
  }
  const result=validateDatasetSheets(sheets);
  if(hash(await readFile(filePath))!==sourceHash)throw new Error('读取过程中Excel文件发生变化，请保存后重新校验');
  // Import + getters only: no export, recalculate, file copy, run-state write,
  // selected-dataset binding, or product connection occurs in this worker.
  return {...result,file:{path:resolve(filePath),name:basename(filePath),sha256:sourceHash,size:bytes.length,inspectedAt:Date.now()}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {process.stdout.write(JSON.stringify({ok:true,result:await inspectDatasetFile(process.argv[2])})+'\n');}
  catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message})+'\n');process.exitCode=1;}
}
