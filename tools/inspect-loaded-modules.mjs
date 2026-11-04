// Inspect existing webpack module source without executing module factories.
import { listTargets, connect } from '../adapters/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const target = (await listTargets(9223)).find(x => /doubao-chat/.test(x.url));
const client = await connect(target);
const ids = process.argv[2] && process.argv[2] !== '-' ? process.argv[2].split(',') : [];
const needles = process.argv[3]?.split('|') || ['NavLink'];
try {
  const result = await client.evaluate(`(() => {
    const chunks=window['@flow-web/desktop:stable']||[];
    const modules=new Map();for(const chunk of chunks)for(const [id,factory] of Object.entries(chunk[1]||{}))modules.set(id,String(factory));
    const selected=[];
    const requested=${JSON.stringify(ids)};
    for(const [id,source] of modules){
      const patterns=${JSON.stringify(needles)};
      if(requested.length?requested.includes(id):patterns.some(x=>source.includes(x)))selected.push({id,length:source.length,source:requested.length||source.length<60000?source:''});
    }
    return {moduleCount:modules.size,selected};
  })()`);
  const directory = resolve('output/playwright/modules'); mkdirSync(directory, { recursive: true });
  for (const item of result.selected) if(item.source)writeFileSync(resolve(directory, `${item.id}.js`), item.source);
  process.stdout.write(JSON.stringify({ moduleCount: result.moduleCount, selected: result.selected.map(x => ({ id: x.id, length: x.length,
    snippets: ['onClickSendButton:', '(813541)', '(625678)', '(388244)'].flatMap(pattern => {
      const offset = x.source.indexOf(pattern); return offset < 0 ? [] : [{pattern, text:x.source.slice(Math.max(0,offset-1000),offset+1500)}];
    }) })) }, null, 2));
} finally { client.close(); }
