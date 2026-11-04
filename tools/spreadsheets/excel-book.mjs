import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { posix } from 'node:path';

const MAIN_NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export function normalizeSpreadsheetXml(xml){
  let text=xml.replace(/^\ufeff/,'');
  const root=/<(?![!?/])[^>]+>/.exec(text)?.[0];if(!root)return text;
  const prefixes=[...root.matchAll(/xmlns:([A-Za-z_][\w.-]*)=["']([^"']+)["']/g)].filter(m=>m[2]===MAIN_NS).map(m=>m[1]);
  if(!prefixes.length)return text;
  for(const prefix of prefixes){
    for(const declaration of text.matchAll(new RegExp('xmlns:'+prefix+'=["\']([^"\']+)["\']','g')))
      if(declaration[1]!==MAIN_NS)throw new Error('不支持同一XML前缀在模板内绑定不同命名空间');
  }
  const names=new Set(prefixes);
  // Only element tags change. Text, attributes, formulas, CDATA and comments
  // are preserved, so a reply containing '<x:...>' is never rewritten.
  text=text.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]*>/g,tag=>{
    if(tag.startsWith('<!'))return tag;
    return tag.replace(/^<(\/?)([A-Za-z_][\w.-]*):/,(_all,slash,prefix)=>names.has(prefix)?'<'+slash:'<'+slash+prefix+':');
  });
  if(!/\sxmlns=["']/.test(root))text=text.replace(/<(?![!?/])([\w.-]+)/,`<$1 xmlns="${MAIN_NS}"`);
  return text;
}
export function normalizeRelationships(xml,name){
  const base=name==='_rels/.rels'?'':posix.dirname(name.replace('/_rels/','/').replace(/\.rels$/,''));
  return xml.replace(/<Relationship\b[^>]*>/g,tag=>{
    if(/\bTargetMode=["']External["']/i.test(tag))return tag;
    return tag.replace(/\bTarget=(["'])(\/[^"']+)\1/,(_all,quote,target)=>'Target='+quote+posix.relative(base==='.'?'':base,target.slice(1))+quote);
  });
}

export async function loadBook(bytes) {
  let ExcelJS, JSZip;
  try { ExcelJS=(await import('exceljs')).default; JSZip=(await import('jszip')).default; }
  catch { throw new Error('Excel依赖未安装，请在程序目录运行“安装依赖.ps1”或 npm ci。'); }
  const zip=await JSZip.loadAsync(bytes);
  const unsupported=Object.keys(zip.files).find(name=>/^xl\/(?:charts|drawings|pivotTables|pivotCache|slicers|slicerCaches|externalLinks)\//i.test(name)||/vbaProject\.bin$/i.test(name));
  if(unsupported)throw new Error('当前测评模板暂不支持保留图像、图表、透视表、宏或外部工作簿链接，请使用普通双表模板。');
  let normalized=false;
  for(const name of Object.keys(zip.files).filter(name=>name.endsWith('.xml')||name.endsWith('.rels'))){
    const original=await zip.file(name).async('string');let updated=normalizeSpreadsheetXml(original);
    if(name.endsWith('.rels'))updated=normalizeRelationships(updated,name);
    if(updated!==original){zip.file(name,updated);normalized=true;}
  }
  const input=normalized?await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}):bytes;
  const book=new ExcelJS.Workbook();await book.xlsx.load(input);return book;
}
export async function readBook(file){return loadBook(await readFile(file));}
export function formulaOf(cell){return cell.type===6 ? '='+cell.formula : '';}
export function plainValue(cell){
  const v=cell.type===6?cell.result:cell.value;
  if(v===null||v===undefined)return null;
  if(typeof v!=='object')return v;
  if(Array.isArray(v.richText))return v.richText.map(x=>x.text).join('');
  if(v.hyperlink!==undefined)return v.text;
  if(v.error)return v.error;
  if(v instanceof Date)return v.toISOString();
  throw new Error(`不支持单元格${cell.address}的数据类型，请使用普通文本、数字或兼容关联公式。`);
}
export function sheetData(sheet){
  if(!sheet)return null;
  let lastRow=0,lastColumn=0;
  sheet.eachRow({includeEmpty:false},row=>row.eachCell({includeEmpty:false},cell=>{
    if(cell.value===null||cell.value===undefined)return;
    lastRow=Math.max(lastRow,row.number);lastColumn=Math.max(lastColumn,cell.col);
  }));
  if(lastRow>10001||lastColumn>128)throw new Error(`工作表“${sheet.name}”超过本版10000数据行或128列范围`);
  const values=[],formulas=[];
  for(let r=1;r<=lastRow;r++){
    values.push([]);formulas.push([]);
    for(let c=1;c<=lastColumn;c++){const cell=sheet.getCell(r,c);values[r-1].push(plainValue(cell));formulas[r-1].push(formulaOf(cell)||null);}
  }
  return {values,formulas};
}
const normalized=v=>JSON.parse(JSON.stringify(v===undefined?null:v));
const blank=v=>v===null||v===undefined||v==='';
export function snapshotBook(book){
  return book.worksheets.map(sheet=>{
    if(sheet.rowCount>10001||sheet.columnCount>128)throw new Error(`工作表“${sheet.name}”包含过多格式行列，请精简模板后重试`);
    const cells={};
    sheet.eachRow({includeEmpty:true},row=>row.eachCell({includeEmpty:true},cell=>{
      if(blank(cell.value)&&!Object.keys(cell.style||{}).length&&!cell.note&&!cell.dataValidation)return;
      cells[cell.address]={value:blank(plainValue(cell))?null:plainValue(cell),formula:formulaOf(cell),style:normalized(cell.style||{}),note:normalized(cell.note),validation:normalized(cell.dataValidation||{})};
    }));
    const columns=sheet.columns.map(col=>({width:col.width??null,hidden:!!col.hidden,outline:col.outlineLevel||0,style:normalized(col.style||{})}));
    const rows=[];sheet.eachRow({includeEmpty:true},row=>rows.push({height:row.height??null,hidden:!!row.hidden,outline:row.outlineLevel||0,style:normalized(row.style||{})}));
    return {name:sheet.name,state:sheet.state,cells,columns,rows,views:normalized(sheet.views),pageSetup:normalized(sheet.pageSetup)};
  });
}
export function assertPreserved(before,after,changed,resized){
  if(before.length!==after.length)throw new Error('输出工作表数量改变');
  for(let i=0;i<before.length;i++){
    const a=before[i],b=after[i];
    for(const key of ['name','state','columns','views','pageSetup'])if(!isDeepStrictEqual(a[key],b[key]))throw new Error(`工作表“${a.name}”的${key}意外改变`);
    if(a.rows.length!==b.rows.length)throw new Error('输出行数改变');
    for(let r=0;r<a.rows.length;r++){
      const left={...a.rows[r]},right={...b.rows[r]};
      if(resized.has(a.name+':'+(r+1))){delete left.height;delete right.height;}
      if(!isDeepStrictEqual(left,right))throw new Error(`工作表“${a.name}”第${r+1}行格式改变`);
    }
    for(const address of new Set([...Object.keys(a.cells),...Object.keys(b.cells)])){
      const empty={value:null,formula:'',style:{},note:null,validation:{}},left=a.cells[address]||empty,right=b.cells[address]||empty;
      if(left.formula!==right.formula)throw new Error(`工作表“${a.name}”${address}的公式改变`);
      if(!changed.has(a.name+'!'+address)&&!isDeepStrictEqual(left,right))throw new Error(`非回填区域改变：“${a.name}”${address}`);
      if(changed.has(a.name+'!'+address))for(const key of ['font','numFmt','fill','border','protection']){
        if(!isDeepStrictEqual(left.style[key]??null,right.style[key]??null))throw new Error(`回填区域原格式改变：“${a.name}”${address}`);
      }
    }
  }
}
export function writeOutput(cell,value){
  if(formulaOf(cell))throw new Error(`回填区${cell.address}含公式，不能作为普通文本覆盖`);
  cell.value=value; // ExcelJS strings remain literal, including '=...' answers.
  cell.style={...structuredClone(cell.style||{}),alignment:{...cell.alignment,wrapText:true,vertical:cell.alignment?.vertical||'top'}};
}
export function expandRow(sheet,row,column,answer,resized){
  const width=(sheet.getColumn(column).width||60)*7+5;
  const lines=answer.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil([...line].reduce((sum,c)=>sum+(c.codePointAt(0)>255?15:8),0)/Math.max(30,width-20))),0);
  const px=lines*21+18,record=sheet.getRow(row),points=Math.min(409.5,px*.75);
  if(points>(record.height||15)){record.height=points;resized.add(sheet.name+':'+row);}
  return px>546;
}
