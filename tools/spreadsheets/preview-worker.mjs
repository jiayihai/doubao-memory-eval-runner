import { readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../../core/store.mjs';
import { validateDatasetSheets, FLOW_SHEET, QUESTION_SHEET } from '../../core/dataset-preview.mjs';
import { loadBook,sheetData } from './excel-book.mjs';

export async function inspectDatasetFile(filePath) {
  const bytes=await readFile(filePath),sourceHash=hash(bytes);
  const workbook=await loadBook(bytes);
  const sheets={};
  for(const name of [FLOW_SHEET,QUESTION_SHEET]) {
    const sheet=workbook.getWorksheet(name);
    if(!sheet)continue;
    sheets[name]=sheetData(sheet);
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
