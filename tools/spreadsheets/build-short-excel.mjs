import { mkdir, writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import ExcelJS from 'exceljs';
import { sheetData } from './excel-book.mjs';
import { createFormulaEvaluator,cacheFormulaResult } from './formula-cache.mjs';
import { FLOW_REQUIRED,QUESTION_REQUIRED,validateDatasetSheets,FLOW_SHEET,QUESTION_SHEET } from '../../core/dataset-preview.mjs';

const output=resolve(process.argv[2]);await mkdir(output,{recursive:true});
const fh=[...FLOW_REQUIRED,'执行约束'],qh=[...QUESTION_REQUIRED,'步骤ID','身份ID','会话ID'];
const raw=[
 ['S0001','M0','HISTORY','',2,'AUTO','这是自动化连通性测试，不是个人信息，请不要记忆。请只回复OK1。'],
 ['S0002','M0','HISTORY','',3,'AUTO','这是同一会话的第二条测试消息，请不要记忆，只回复OK2。'],
 ['S0003','T01','QUESTION','Q-CONN-01',2,'AUTO','这是新会话连通性测试，请不要记忆，只回复OK3。'],
 ['S0004','M0','HISTORY','',0,'AUTO','这是返回原会话测试，请不要记忆，只回复OK4。'],
 ['S0005','H01','QUESTION','Q-MANUAL-01',2,'MANUAL','这是人工发送测试，请不要记忆，只回复MANUAL_OK。'],
 ['S0006','M0','QUESTION','Q-CONN-02',0,'AUTO','这是人工停点之后返回原会话的测试，请不要记忆，只回复OK6。']
];
const flow=raw.map(r=>[r[0],'A',r[1],r[2],r[3],r[6],r[4],r[5],'','未执行','',r[5]==='MANUAL'?'在自动测试账号A中手动新建一个独立会话H01，发送本行原文。待首次完整回复后，打开执行器“人工步骤”粘贴并保存；关闭后回主界面点击继续。不要向原M0或T01追加本行消息。':'仅技术连通验收，不能作为产品记忆能力评分。']);
const qr=raw.filter(r=>r[3]);
const questions=qr.map(r=>[r[3],'CONN','执行器连通性',r[6],r[0]==='S0003'?'OK3':r[0]==='S0005'?'MANUAL_OK':'OK6',
  '仅核对发送、取回、归属、停点和恢复；不计算产品能力分数。','','未执行',r[0],'A',r[1]]);
const wb=new ExcelJS.Workbook(),f=wb.addWorksheet(FLOW_SHEET),q=wb.addWorksheet(QUESTION_SHEET);
function sheet(s,headers,rows,widths,name){
  s.addTable({name,ref:'A1',headerRow:true,columns:headers.map(name=>({name})),rows,style:{theme:'TableStyleMedium2',showRowStripes:true}});
  s.eachRow((row,r)=>{row.height=r===1?25.5:r===6?126:82.5;row.eachCell(cell=>{
    cell.font={name:'Arial',size:11,color:{argb:r===1?'FFFFFFFF':'FF233047'},bold:r===1};
    cell.alignment={wrapText:true,vertical:r===1?'middle':'top',horizontal:r===1?'center':undefined};
    if(r===1)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF213D63'}};
  });});
  widths.forEach((w,i)=>{s.getColumn(i+1).width=(w-5)/7;});
  s.views=[{state:'frozen',xSplit:2,ySplit:1,showGridLines:false}];
}
sheet(f,fh,flow,[90,70,100,110,150,480,110,95,430,110,340,500],'ExecutionSteps');
sheet(q,qh,questions,[150,100,150,480,150,430,430,110,90,70,100],'AbilityQuestions');
for(let i=0;i<questions.length;i++){const row=i+2;const match=`MATCH($A${row},'${FLOW_SHEET}'!$E$2:$E$7,0)`;
  q.getCell(`G${row}`).value={formula:`IF(INDEX('${FLOW_SHEET}'!$I$2:$I$7,${match})="","",INDEX('${FLOW_SHEET}'!$I$2:$I$7,${match}))`};
  q.getCell(`H${row}`).value={formula:`INDEX('${FLOW_SHEET}'!$J$2:$J$7,${match})`};}
const evaluate=createFormulaEvaluator(wb);
for(let row=2;row<=questions.length+1;row++)for(const col of ['G','H']){const cell=q.getCell(`${col}${row}`);cacheFormulaResult(cell,evaluate(q,cell));}
wb.calcProperties.fullCalcOnLoad=true;
const validation=validateDatasetSheets({[FLOW_SHEET]:sheetData(f),[QUESTION_SHEET]:sheetData(q)});
if(!validation.valid)throw new Error(JSON.stringify(validation.issues));
const file=join(output,'通用Excel短流程_6条验收.xlsx');await wb.xlsx.writeFile(file);
await writeFile(join(output,'短流程说明.md'),'# 通用Excel短流程验收\n\n本表6条消息：5自动、1人工，仅技术连通验收，不计产品能力分数。\n\n选取校验后点“用于本轮执行”，主界面选择Excel技术回归、检查账号并开始。第5步停在人工H01；按表内说明在同一测试账号手动新开独立会话发送原文，粘贴首次回复保存，再关闭人工窗口点击主界面继续。第6步应返回M0。\n\n结束后应有6条处理记录、3条问题回答，以及原表目录与本轮运行记录内内容相同的结果副本。请核对原文、会话、按表2/3秒等待、人工停点与恢复、双份文件；不要拿本表评分产品记忆能力。\n');
console.log(JSON.stringify({file,summary:validation.summary}));
