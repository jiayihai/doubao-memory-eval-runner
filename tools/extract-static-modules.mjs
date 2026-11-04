// Extract factory text from a locally saved webpack chunk. Factories are not run.
import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
const root = resolve('output/playwright');
const sourcePath = resolve(process.argv[2]);
if (!sourcePath.startsWith(root + sep)) throw new Error('Expected a local diagnostic resource');
const context = {}; context.window = context; context.self = context;
vm.runInNewContext(readFileSync(sourcePath, 'utf8'), context, { timeout: 1000 });
const directory = resolve(root, 'modules'); mkdirSync(directory, { recursive: true });
const wanted = process.argv[3]?.split(',') || [];
for (const chunks of Object.values(context).filter(Array.isArray)) for (const chunk of chunks) {
  for (const [id, factory] of Object.entries(chunk[1] || {})) if (!wanted.length || wanted.includes(id)) {
    const source = String(factory); writeFileSync(resolve(directory, `${id}.js`), source);
    console.log(JSON.stringify({ id, length: source.length }));
  }
}
