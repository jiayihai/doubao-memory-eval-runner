// Read-only diagnostic: no navigation, activation, input, clicks or chat requests.
import { listTargets, connect } from '../adapters/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SNAPSHOT } from '../adapters/doubao.mjs';
import { summarize } from '../core/observation.mjs';
const targets = await listTargets(9223);
const target = targets.find(x => /doubao-chat/.test(x.url));
if (!target) throw new Error('No existing Doubao chat target');
const client = await connect(target);
try {
  const report = await client.evaluate(`(() => {
    const button=document.querySelector('[data-testid="chat_input_send_button"]');
    const editor=document.querySelector('[data-testid="chat_input_input"] [contenteditable="true"]');
    const describe=e=>e?{tag:e.tagName,testId:e.getAttribute('data-testid'),role:e.getAttribute('role'),
      disabled:e.disabled,ariaDisabled:e.getAttribute('aria-disabled')}:null;
    const handlers=[];
    for(let e=button,level=0;e&&level<4;e=e.parentElement,level++){
      const key=Object.keys(e).find(k=>k.startsWith('__reactProps'));
      const props=key?e[key]:null;
      handlers.push({level,...describe(e),callbacks:props?Object.fromEntries(Object.entries(props)
        .filter(([k,v])=>/^on/.test(k)&&typeof v==='function').map(([k,v])=>[k,String(v).slice(0,1800)])):null});
    }
    return {at:Date.now(),url:location.href,visibility:document.visibilityState,focused:document.hasFocus(),
      activeElement:describe(document.activeElement),button:describe(button),buttonHtml:button?.outerHTML.slice(0,7000),handlers,
      editor:describe(editor),draftLength:(editor?.innerText||'').length,
      messages:[...document.querySelectorAll('[data-testid="send_message"]')].map(e=>e.querySelector('[data-message-id]')?.getAttribute('data-message-id')),
      links:[...document.querySelectorAll('a[href]')].map(e=>({href:e.getAttribute('href'),testId:e.getAttribute('data-testid'),role:e.getAttribute('role')})).filter(x=>x.href?.includes('/chat/')).slice(0,50),
      scripts:[...document.scripts].map(e=>e.src).filter(Boolean)};
  })()`);
  report.snapshot = summarize(await client.evaluate(SNAPSHOT));
  const directory = resolve('output/playwright'); mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'doubao-readonly-inspection.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(process.argv.includes('--snapshot-only') ? report.snapshot : report, null, 2) + '\n');
} finally { client.close(); }
