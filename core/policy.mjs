import { resolve } from 'node:path';
import { loadJSON } from './store.mjs';

export function loadExecutionPolicy(root) {
  const options = loadJSON(resolve(root, '执行设置.json'), {});
  const result = {};
  for (const [name, fallback] of Object.entries({ confirmSeconds: 90, recoverySeconds: 90, responseSeconds: 600 })) {
    const seconds = options[name] ?? fallback;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error(`执行设置 ${name} 必须为1至86400之间的整数秒`);
    result[name.replace('Seconds', 'Ms')] = seconds * 1000;
  }
  return result;
}
