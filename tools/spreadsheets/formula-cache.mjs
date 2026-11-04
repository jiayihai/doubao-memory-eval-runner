// Deliberately bounded evaluator for answer/status links. This is not a general
// Excel calculation engine. Unsupported expressions fail instead of inventing
// cached answers; untouched workbook formulas keep their existing caches.
class ExcelError extends Error {constructor(code){super(code);this.code=code;}}
const unsupported=message=>{throw new Error('暂不支持的回答关联公式：'+message);};
const column=s=>[...s.replaceAll('$','').toUpperCase()].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
function address(text){const m=/^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(text);if(!m)unsupported(text);return {row:Number(m[2]),col:column(m[1])};}
function parse(formula){
  const source=formula.replace(/^=/,'');let p=0;
  const space=()=>{while(/\s/.test(source[p]||'')&&p<source.length)p++;};
  const take=s=>{space();if(source.slice(p,p+s.length)===s){p+=s.length;return true;}return false;};
  function expr(){let node=term();space();const op=/^(<>|<=|>=|=|<|>)/.exec(source.slice(p));if(op){p+=op[0].length;node={type:'compare',op:op[0],left:node,right:term()};}return node;}
  function term(){
    space();
    if(take('(')){const node=expr();if(!take(')'))unsupported('缺少右括号');return node;}
    if(source[p]==='"'){p++;let value='';while(p<source.length){if(source[p]==='"'){p++;if(source[p]==='"'){value+='"';p++;continue;}return {type:'literal',value};}value+=source[p++];}unsupported('字符串未结束');}
    const number=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(p));if(number){p+=number[0].length;return {type:'literal',value:Number(number[0])};}
    let sheet=null;
    const prefix=/^(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_. ]*))!/u.exec(source.slice(p));
    if(prefix){sheet=(prefix[1]||prefix[2]).replaceAll("''", "'");p+=prefix[0].length;}
    const cell=/^\$?[A-Z]{1,3}\$?[1-9]\d*(?![\p{L}\p{N}_])/iu.exec(source.slice(p));
    if(cell){p+=cell[0].length;let last=cell[0];if(take(':')){const next=/^\$?[A-Z]{1,3}\$?[1-9]\d*/i.exec(source.slice(p));if(!next)unsupported('范围末端无效');last=next[0];p+=next[0].length;}return {type:'ref',sheet,first:address(cell[0]),last:address(last)};}
    if(sheet)unsupported('仅支持有界A1范围');
    const name=/^[A-Z_][A-Z0-9_.]*/i.exec(source.slice(p));
    if(!name)unsupported(source.slice(p,p+40));p+=name[0].length;
    if(!take('(')){if(/^(TRUE|FALSE)$/i.test(name[0]))return {type:'literal',value:name[0].toUpperCase()==='TRUE'};unsupported(name[0]);}
    const args=[];if(!take(')')){do{args.push(expr());}while(take(','));if(!take(')'))unsupported('函数缺少右括号');}
    return {type:'call',name:name[0].toUpperCase(),args};
  }
  const node=expr();space();if(p!==source.length)unsupported(source.slice(p,p+40));return node;
}
const scalar=v=>{if(Array.isArray(v)){if(v.length!==1||v[0].length!==1)unsupported('目标结果不是单一单元格');return v[0][0];}return v;};
const equal=(a,b)=>{a=scalar(a);b=scalar(b);if(a===null)a=typeof b==='number'?0:'';if(b===null)b=typeof a==='number'?0:'';return typeof a==='string'&&typeof b==='string'?a.toUpperCase()===b.toUpperCase():a===b;};
export function createFormulaEvaluator(book){
  const active=new Set(),values=new Map(),ranges=new Map(),syntax=new Map();
  function cellValue(sheet,cell,depth){
    if(depth>64)unsupported('引用层级过深');const key=sheet.name+'!'+cell.address;
    if(values.has(key))return values.get(key);if(active.has(key))unsupported('存在循环引用');
    active.add(key);
    try{
      let result;
      if(cell.type===6){const formula=cell.formula;if(!syntax.has(formula))syntax.set(formula,parse(formula));result=scalar(evaluate(syntax.get(formula),sheet,depth+1));}
      else {const v=cell.value;if(v?.error)throw new ExcelError(v.error);result=v??null;if(v?.richText)result=v.richText.map(x=>x.text).join('');if(v?.hyperlink)result=v.text;}
      values.set(key,result);return result;
    }finally{active.delete(key);}
  }
  function evaluate(node,current,depth){
    if(node.type==='literal')return node.value;
    if(node.type==='ref'){
      const sheet=node.sheet?book.getWorksheet(node.sheet):current;if(!sheet)throw new ExcelError('#REF!');
      const {first,last}=node;
      if(first.row>last.row||first.col>last.col||last.row>10001||last.col>128)unsupported('范围超出10000行/128列');
      const key=[sheet.name,first.row,first.col,last.row,last.col].join(':');if(ranges.has(key))return ranges.get(key);
      const result=[];for(let r=first.row;r<=last.row;r++){const row=[];for(let c=first.col;c<=last.col;c++)row.push(cellValue(sheet,sheet.getCell(r,c),depth+1));result.push(row);}ranges.set(key,result);return result;
    }
    if(node.type==='compare'){
      const a=scalar(evaluate(node.left,current,depth)),b=scalar(evaluate(node.right,current,depth));
      if(node.op==='=')return equal(a,b);if(node.op==='<>')return !equal(a,b);
      if(typeof a!=='number'||typeof b!=='number')unsupported('大小比较仅支持数值');
      if(node.op==='<')return a<b;if(node.op==='>')return a>b;if(node.op==='<=')return a<=b;return a>=b;
    }
    const arg=i=>evaluate(node.args[i],current,depth+1),n=node.args.length;
    switch(node.name){
      case 'IF':{if(n<2||n>3)unsupported('IF参数数量');const condition=scalar(arg(0));
        if(condition!==null&&typeof condition!=='boolean'&&typeof condition!=='number')unsupported('IF条件须为逻辑值或数值');
        return condition?arg(1):n===3?arg(2):false;}
      case 'IFERROR':case 'IFNA':if(n!==2)unsupported(node.name+'参数数量');try{return arg(0);}catch(error){if(error instanceof ExcelError&&(node.name==='IFERROR'||error.code==='#N/A'))return arg(1);throw error;}
      case 'MATCH':{
        if(n!==3||scalar(arg(2))!==0)unsupported('MATCH只支持精确匹配0');const value=scalar(arg(0)),range=arg(1);
        if(!Array.isArray(range)||range.length>1&&range[0].length>1)unsupported('MATCH需要单行或单列');
        const list=range.flat(),i=list.findIndex(x=>equal(x,value));if(i<0)throw new ExcelError('#N/A');return i+1;
      }
      case 'INDEX':{
        if(n<2||n>3)unsupported('INDEX参数数量');const range=arg(0),row=scalar(arg(1)),col=n===3?scalar(arg(2)):1;
        if(!Array.isArray(range)||!Number.isInteger(row)||!Number.isInteger(col)||row<1||col<1||!range[row-1]||col>range[row-1].length)throw new ExcelError('#REF!');return range[row-1][col-1];
      }
      default:unsupported(node.name);
    }
  }
  return (sheet,cell)=>cellValue(sheet,cell,0);
}
export function cacheFormulaResult(cell,value){
  if(cell.type!==6)throw new Error('目标没有公式');
  // Preserve both ordinary and shared formula definitions, only refresh the
  // verified cached result. Formula-looking answers stay cached text.
  cell.value={...cell.value,result:value??''};
}
