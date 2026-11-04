import { listTargets, connect } from '../adapters/cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const target = (await listTargets(9223)).find(x => /doubao-chat/.test(x.url));
const client = await connect(target);
try {
  const result = await client.evaluate(`(() => {
    const link=[...document.querySelectorAll('a[href]')].find(e=>e.getAttribute('href')==='/chat/38449995164458498');
    const key=link&&Object.keys(link).find(k=>k.startsWith('__reactProps'));
    const props=key?link[key]:null;
    return {url:location.href,readyState:document.readyState,timeOrigin:performance.timeOrigin,
      link:link?{tag:link.tagName,id:link.id,href:link.getAttribute('href'),html:link.outerHTML.slice(0,2200),
        onClick:typeof props?.onClick==='function'?String(props.onClick):null,
        onMouseDown:typeof props?.onMouseDown==='function'?String(props.onMouseDown):null,propsKeys:Object.keys(props||{})}:null};
  })()`);
  mkdirSync('output/playwright', { recursive: true });
  writeFileSync(resolve('output/playwright/history-link-inspection.json'), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2));
} finally { client.close(); }
