// Read already loaded JavaScript resources through CDP. No page interaction.
import { listTargets, connect } from '../adapters/cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
const target = (await listTargets(9223)).find(x => /doubao-chat/.test(x.url));
const client = await connect(target);
try {
  await client.send('Page.enable');
  const tree = await client.send('Page.getResourceTree');
  const resources = [];
  const walk = node => { resources.push(...node.resources.map(x => ({ ...x, frameId: node.frame.id }))); for (const child of node.childFrames || []) walk(child); };
  walk(tree.frameTree);
  const scripts = await client.evaluate(`[...document.scripts].map(e=>e.src).filter(x=>x.startsWith('chrome://doubao-chat/static/js/'))`);
  for (const url of scripts) if (!resources.some(x => x.url === url)) resources.push({ url, frameId: tree.frameTree.frame.id });
  for (const url of process.argv.slice(2)) {
    if (!/^chrome:\/\/doubao-chat\/static\/js\/(?:async\/)?[\w.-]+\.js$/.test(url)) throw new Error('Only static app JavaScript can be inspected');
    if (!resources.some(x => x.url === url)) resources.push({ url, frameId: tree.frameTree.frame.id });
  }
  const directory = resolve('output/playwright/resources'); mkdirSync(directory, { recursive: true });
  const matches = [];
  const inventory = [];
  for (const resource of resources.filter(x => /^chrome:\/\/doubao-chat\/static\/js\//.test(x.url) && /\.js$/.test(x.url))) {
    let result;
    try { result = await client.send('Page.getResourceContent', { frameId: resource.frameId, url: resource.url }); }
    catch { result = null; }
    if (!result?.content) result = { content: await client.evaluate(`fetch(${JSON.stringify(resource.url)}).then(r=>{if(!r.ok)throw new Error('Static resource unavailable');return r.text()})`), base64Encoded: false };
    const source = result.base64Encoded ? Buffer.from(result.content, 'base64').toString('utf8') : result.content;
    writeFileSync(resolve(directory, basename(resource.url)), source);
    inventory.push({ file: basename(resource.url), length: source.length, prefix: source.slice(0, 80) });
    if (!source.includes('chat_input_send_button') && !source.includes('visibilitychange')) continue;
    const snippets = [];
    for (const pattern of ['chat_input_send_button', 'visibilitychange', 'document.hidden', 'document.hasFocus']) {
      let offset = -1;
      for (let i = 0; i < 4 && (offset = source.indexOf(pattern, offset + 1)) >= 0; i++) {
        const span = pattern === 'chat_input_send_button' ? 2200 : 600;
        snippets.push({ pattern, offset, text: source.slice(Math.max(0, offset - span), offset + span) });
      }
    }
    matches.push({ file: basename(resource.url), length: source.length, snippets });
  }
  writeFileSync(resolve(directory, '../source-matches.json'), JSON.stringify(matches, null, 2));
  process.stdout.write(JSON.stringify({ inventory, matches }, null, 2));
} finally { client.close(); }
