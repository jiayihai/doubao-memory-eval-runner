import {readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url));
const xlsx=process.argv.includes('--xlsx');
if(process.argv.slice(2).some(arg=>arg!=='--xlsx'))throw new Error('只支持 --xlsx 参数');
const files=readdirSync(join(root,'tests')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>resolve(root,'tests',name));
// Default tests must not inherit an opt-in from the caller's environment.
const result=spawnSync(process.execPath,['--test',...files],{cwd:root,stdio:'inherit',windowsHide:true,
  env:{...process.env,DOUBAO_XLSX_TESTS:xlsx?'1':'0'}});
if(result.error)throw result.error;
process.exitCode=result.status??1;
