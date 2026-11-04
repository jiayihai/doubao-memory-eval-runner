// Offline verification of a completed legacy B run. Never opens CDP or sends.
import fs from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { hash } from '../../core/store.mjs';
import { collectResultInput, buildFillPlan } from '../../core/excel-results.mjs';
import { generateResultWorkbook } from './backfill-worker.mjs';
import { readBook,sheetData,plainValue } from './excel-book.mjs';
import { FLOW_SHEET,QUESTION_SHEET } from '../../core/dataset-preview.mjs';

if(!process.argv[2]||!process.argv[3])throw new Error('用法：node tools/spreadsheets/verify-backfill.mjs <旧B运行目录> <独立输出目录>');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const directory=resolve(process.argv[2]),output=resolve(process.argv[3]);
assert.notEqual(directory,output,'输出必须使用独立目录');
const statePath=join(directory,'state.json'),eventsPath=join(directory,'events.jsonl');
const state=JSON.parse(await fs.readFile(statePath,'utf8'));
const input=collectResultInput({root,directory,state});
const before=await Promise.all([input.template,statePath,eventsPath].map(async file=>[file,hash(await fs.readFile(file))]));
const template=await readBook(input.template);
const plan=buildFillPlan(input,sheetData(template.getWorksheet(FLOW_SHEET)).values,sheetData(template.getWorksheet(QUESTION_SHEET)).values);
const result=await generateResultWorkbook(input,{outputDirectory:output});
const book=await readBook(result.file),flow=book.getWorksheet(FLOW_SHEET),questions=book.getWorksheet(QUESTION_SHEET);
for(const item of plan.fills){
  assert.equal(plainValue(flow.getCell(item.row,9)),item.answer);
  if(item.questionRow)assert.equal(plainValue(questions.getCell(item.questionRow,12)),item.answer);
}
assert.deepEqual(sheetData(questions).formulas,sheetData(template.getWorksheet(QUESTION_SHEET)).formulas);
for(const [file,digest]of before)assert.equal(hash(await fs.readFile(file)),digest,'原文件被修改：'+file);
await fs.writeFile(join(output,'离线验收.json'),JSON.stringify({result,answersExact:plan.fills.length,formulasPreserved:true,templateUnchanged:true,runUnchanged:true},null,2)+'\n');
console.log(JSON.stringify({ok:true,...result}));
