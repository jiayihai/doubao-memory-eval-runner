import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { mkdtemp,readFile,readdir,rm,mkdir,writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { hash } from '../core/store.mjs';
import { inspectDatasetFile } from '../tools/spreadsheets/preview-worker.mjs';
import { compileExcelDataset } from '../core/excel-dataset.mjs';
import { writeExcelResult } from '../tools/spreadsheets/excel-results-worker.mjs';
import { createFormulaEvaluator,cacheFormulaResult } from '../tools/spreadsheets/formula-cache.mjs';
import { loadBook,readBook,normalizeSpreadsheetXml,normalizeRelationships,writeOutput,plainValue,formulaOf,snapshotBook,assertPreserved } from '../tools/spreadsheets/excel-book.mjs';

const fixture=()=>{const book=new ExcelJS.Workbook();return {book,sheet:book.addWorksheet('执行表')};};
const excelRequire=createRequire(import.meta.resolve('exceljs'));
const archiveRequire=createRequire(excelRequire.resolve('archiver'));
async function dependencyScratch(t){
  const directory=await mkdtemp(join(tmpdir(),'doubao-dependency-'));
  t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true});});
  await mkdir(join(directory,'nested'));await mkdir(join(directory,'skip'));
  await writeFile(join(directory,'root.txt'),'根目录');await writeFile(join(directory,'nested','reply.txt'),'回复全文');
  await writeFile(join(directory,'nested','other.json'),'{}');await writeFile(join(directory,'skip','ignored.txt'),'忽略');
  return directory;
}
test('UUID修复版本保留ExcelJS的CommonJS v4接口，并拒绝v5越界缓冲区',()=>{
  const uuid=excelRequire('uuid'),id=uuid.v4();assert.ok(uuid.validate(id));assert.equal(uuid.version(id),4);
  const namespace='6ba7b810-9dad-11d1-80b4-00c04fd430c8';
  assert.throws(()=>uuid.v5('test',namespace,new Uint8Array(8),4),RangeError);
  const bytes=new Uint8Array(16);uuid.v5('test',namespace,bytes,0);assert.ok(uuid.validate(uuid.stringify(bytes)));
});
test('归档工具与新版glob及minimatch组合保留递归和忽略规则',async t=>{
  const directory=await dependencyScratch(t),utilsRequire=createRequire(archiveRequire.resolve('archiver-utils'));
  const glob=utilsRequire('glob'),options={cwd:directory,ignore:'skip/**',nodir:true};
  const normalize=paths=>paths.map(path=>path.replaceAll('\\','/')).sort();
  const asyncFiles=await glob.glob('**/*.txt',options);
  assert.deepEqual(normalize(asyncFiles),['nested/reply.txt','root.txt']);
  assert.deepEqual(normalize(glob.sync('**/*.txt',options)),['nested/reply.txt','root.txt']);
  assert.deepEqual(normalize(archiveRequire('archiver-utils').file.expand({cwd:directory,nodir:true},['**/*.txt','!skip/**'])),['nested/reply.txt','root.txt']);
});
test('archiver的glob路径筛选和ZIP归档在依赖升级后可完整读取',async t=>{
  const directory=await dependencyScratch(t),archive=excelRequire('archiver')('zip'),chunks=[];
  const done=new Promise((resolve,reject)=>{archive.on('data',chunk=>chunks.push(chunk));archive.once('error',reject);archive.once('warning',reject);archive.once('end',resolve);});
  archive.glob('**/*.txt',{cwd:directory,ignore:'skip/**'});await Promise.all([archive.finalize(),done]);
  const zip=await JSZip.loadAsync(Buffer.concat(chunks));
  assert.deepEqual(Object.keys(zip.files).filter(name=>!zip.files[name].dir).sort(),['nested/reply.txt','root.txt']);
  assert.equal(await zip.file('nested/reply.txt').async('string'),'回复全文');
});
test('ExcelJS流式写入兼容修复后的归档与UUID依赖，数据和格式可重读',async t=>{
  const directory=await dependencyScratch(t),file=join(directory,'stream.xlsx');
  const book=new ExcelJS.stream.xlsx.WorkbookWriter({filename:file,useSharedStrings:true,useStyles:true});
  const sheet=book.addWorksheet('兼容检查');sheet.getCell('A1').value='回复';sheet.getCell('A1').font={bold:true};sheet.getRow(1).commit();
  sheet.addRow(['=原样回答\n第二行']).commit();await book.commit();
  const loaded=await readBook(file);assert.equal(loaded.getWorksheet(1).getCell('A2').value,'=原样回答\n第二行');
  assert.equal(loaded.getWorksheet(1).getCell('A1').font.bold,true);assert.equal(formulaOf(loaded.getWorksheet(1).getCell('A2')),'');
  const rows=[];
  for await(const streamedSheet of new ExcelJS.stream.xlsx.WorkbookReader(file))for await(const row of streamedSheet)rows.push(row.getCell(1).text);
  assert.deepEqual(rows,['回复','=原样回答\n第二行']);
});
test('公开库关联公式按实际引用计算，保存后缓存、公式及共享公式均保留',async()=>{
  const {book,sheet}=fixture();sheet.addRows([['ID','回答','状态'],['Q1','=原文\n#N/A','已完成'],['Q2','第二条','已完成']]);
  const q=book.addWorksheet('问题表');q.addRows([['Q1'],['Q2']]);
  q.getCell('B1').value={formula:'IF(INDEX(执行表!$B$2:$B$3,MATCH(A1,执行表!$A$2:$A$3,0))="","",INDEX(执行表!$B$2:$B$3,MATCH(A1,执行表!$A$2:$A$3,0)))',shareType:'shared',ref:'B1:B2'};
  q.getCell('B2').value={sharedFormula:'B1'};
  const evaluate=createFormulaEvaluator(book);
  for(const address of ['B1','B2'])cacheFormulaResult(q.getCell(address),evaluate(q,q.getCell(address)));
  assert.equal(q.getCell('B1').result,'=原文\n#N/A');assert.equal(q.getCell('B2').result,'第二条');
  const saved=await loadBook(await book.xlsx.writeBuffer());
  assert.equal(plainValue(saved.getWorksheet('问题表').getCell('B1')),'=原文\n#N/A');
  assert.equal(formulaOf(saved.getWorksheet('问题表').getCell('B2')),formulaOf(q.getCell('B2')));
  assert.equal(saved.getWorksheet('问题表').getCell('B2').result,'第二条');
});
test('错误引用不会按问题ID虚构缓存，未知公式及循环明确拒绝',()=>{
  const {book,sheet}=fixture();sheet.addRows([['first'],['second']]);
  sheet.getCell('B1').value={formula:'A2'};assert.equal(createFormulaEvaluator(book)(sheet,sheet.getCell('B1')),'second');
  for(const formula of ['IFERROR(SUM(A1:A2),"伪成功")','INDEX(A:A,1)','B1','IF("text",1,2)','IF("2"<10,1,2)']){
    sheet.getCell('B1').value={formula};assert.throws(()=>createFormulaEvaluator(book)(sheet,sheet.getCell('B1')),/暂不支持|循环/);
  }
});
test('缺少精确匹配可IFNA兜底，空白与0不会错误写成相同回答',()=>{
  const {book,sheet}=fixture();sheet.getCell('A1').value='a';
  sheet.getCell('B1').value={formula:'IFNA(MATCH("missing",A1:A2,0),"未找到")'};
  assert.equal(createFormulaEvaluator(book)(sheet,sheet.getCell('B1')),'未找到');
  sheet.getCell('B1').value={formula:'IF(A2="","空白","其他")'};
  assert.equal(createFormulaEvaluator(book)(sheet,sheet.getCell('B1')),'空白');
  sheet.getCell('A2').value=0;assert.equal(createFormulaEvaluator(book)(sheet,sheet.getCell('B1')),'其他');
});
test('回复等号、错误样文本按原样保存，不创建公式，不串改共享格式',async()=>{
  const {book,sheet}=fixture(),style={font:{bold:true},alignment:{horizontal:'left'}};
  sheet.getCell('A1').style=style;sheet.getCell('A2').style=style;
  writeOutput(sheet.getCell('A1'),'=1+1\n#N/A');assert.equal(sheet.getCell('A2').alignment.wrapText,undefined);
  const reopened=await loadBook(await book.xlsx.writeBuffer());
  assert.equal(plainValue(reopened.getWorksheet(1).getCell('A1')),'=1+1\n#N/A');assert.equal(formulaOf(reopened.getWorksheet(1).getCell('A1')),'');
});
test('旧XLSX前缀只规范化XML标签，不改写CDATA、属性、注释和文字',()=>{
  const original='<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:t attr="x:a"><![CDATA[<x:a>]]><!--<x:b>-->x:内容</x:t></x:worksheet>';
  const normalized=normalizeSpreadsheetXml(original);
  assert.match(normalized,/<worksheet xmlns=/);assert.match(normalized,/<t attr="x:a">/);assert.ok(normalized.includes('<![CDATA[<x:a>]]><!--<x:b>-->x:内容'));
  assert.equal(normalizeRelationships('<Relationships><Relationship Target="/xl/workbook.xml"/></Relationships>','_rels/.rels'),'<Relationships><Relationship Target="xl/workbook.xml"/></Relationships>');
  assert.equal(normalizeRelationships('<Relationship Target="/xl/tables/table1.xml"/>','xl/worksheets/_rels/sheet1.xml.rels'),'<Relationship Target="../tables/table1.xml"/>');
  assert.equal(normalizeRelationships('<Relationship Target="/site" TargetMode="External"/>','_rels/.rels'),'<Relationship Target="/site" TargetMode="External"/>');
});
test('包含无法完整保留的图表或宏时拒绝生成，避免静默丢失',async()=>{
  for(const part of ['xl/charts/chart1.xml','xl/vbaProject.bin']){const zip=new JSZip();zip.file(part,'data');await assert.rejects(loadBook(await zip.generateAsync({type:'nodebuffer'})),/暂不支持保留/);}
});
test('非回填文本与评分格式发生意外改动时保存核对失败',()=>{
  const {book,sheet}=fixture();sheet.getCell('A1').value='评分标准';sheet.getCell('B1').value='未执行';
  const before=snapshotBook(book);writeOutput(sheet.getCell('B1'),'已完成');
  assertPreserved(before,snapshotBook(book),new Set(['执行表!B1']),new Set());
  sheet.getCell('A1').value='错误标准';assert.throws(()=>assertPreserved(before,snapshotBook(book),new Set(['执行表!B1']),new Set()),/非回填区域/);
});
test('实际结果生成拒绝错行或未知公式，保留原模板且不留下成功文件',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'doubao-public-excel-'));
  t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true});});
  for(const [i,formula]of ['\'全过程执行表\'!I2','SUM(\'全过程执行表\'!I2:I7)'].entries()){
    const book=await loadBook(await readFile(new URL('../examples/short-flow.xlsx',import.meta.url)));
    book.getWorksheet('独立问题表').getCell('G2').value={formula,result:''};
    const template=join(directory,'input'+i+'.xlsx');await book.xlsx.writeFile(template);
    const before=hash(await readFile(template)),report=await inspectDatasetFile(template);assert.ok(report.valid);
    const scenario=compileExcelDataset(report).data,step=scenario.steps.find(s=>s.id==='S0003'),answer='本步骤实际回复';
    const outputDirectory=join(directory,'result'+i);
    await assert.rejects(writeExcelResult({kind:'excel',template,templateHash:before,directory,sourcePath:template,scenario,
      run:{id:'offline-test',createdAt:Date.now(),purpose:'technical_regression'},
      records:[{stepId:step.id,prompt:step.messages[0].send_text,answer,answerHash:hash(answer),status:'已完成',source:'cdp'}]},
      {outputDirectory}),/关联公式未指向|关联公式无法核验/);
    assert.equal(hash(await readFile(template)),before);assert.deepEqual(await readdir(outputDirectory),[]);
  }
});
