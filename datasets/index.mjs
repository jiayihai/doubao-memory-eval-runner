import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { hash } from '../core/store.mjs';
import { loadExcelDataset } from '../core/excel-dataset.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export function validate(data) {
  if (data.schema_version !== 1 || !Array.isArray(data.steps) || !data.steps.length) throw new Error('流程版本或步骤格式无效');
  const seenIds = new Set(), seenTargets = new Set();
  let encounteredManual = false;
  for (const [name, range] of Object.entries(data.wait_profiles_seconds || {})) {
    if (!Array.isArray(range) || range.length !== 2 || range.some(x => !Number.isInteger(x) || x < 0) || range[1] < range[0]) throw new Error(`等待设置无效：${name}`);
  }
  if (!data.wait_profiles_seconds?.message_gap) throw new Error('缺少消息间隔');
  for (const [i, step] of data.steps.entries()) {
    if (!step.id || seenIds.has(step.id)) throw new Error('步骤编号缺失或重复');
    seenIds.add(step.id);
    if (!['automatic', 'manual'].includes(step.execution)) throw new Error(`${step.id}执行类型无效`);
    if (step.execution === 'manual') encounteredManual = true;
    else if (encounteredManual) throw new Error('人工步骤后不允许隐藏自动步骤');
    if (!Array.isArray(step.messages) || !step.messages.length || step.messages.some(x => typeof x.send_text !== 'string' || !x.send_text.trim())) throw new Error(`${step.id}消息内容无效`);
    if (!['new', 'return', 'continue'].includes(step.navigation)) throw new Error(`${step.id}会话操作无效`);
    if (step.navigation === 'new') {
      if (seenTargets.has(step.target)) throw new Error(`新会话标识重复：${step.target}`);
      seenTargets.add(step.target);
    } else if (!seenTargets.has(step.target)) throw new Error(`${step.id}引用了尚未建立的会话`);
    if (!Array.isArray(step.transition_actions)) throw new Error(`${step.id}缺少切换动作`);
    for (const action of step.transition_actions) {
      if (!['wait', 'navigate_next_target'].includes(action.action)) throw new Error('未知流程动作');
      if (action.action === 'wait' && !data.wait_profiles_seconds[action.profile]) throw new Error('未知等待档位');
      if (action.action === 'navigate_next_target' && !data.steps[i + 1]) throw new Error('预先导航缺少下一步骤');
    }
  }
  return data;
}
export function loadDataset(id = 'doubao-b', directory = null) {
  if(id==='excel') { if(!directory)throw new Error('Excel流程必须从本轮输入快照读取');return loadExcelDataset(directory); }
  let data;
  if (id === 'doubao-b') {
    data = JSON.parse(readFileSync(resolve(ROOT, 'doubao-b.json'), 'utf8'));
    const source = readFileSync(resolve(ROOT, '原执行稿.md'), 'utf8').replace(/\r\n/g, '\n');
    if (hash(source) !== data.source_sha256) throw new Error('旧流程与冻结执行稿校验不一致，已禁止运行');
    if (data.steps.length !== 31 || data.steps.filter(x => x.execution === 'automatic').length !== 30) throw new Error('旧流程步骤数量异常');
  } else if (id === 'smoke') {
    const marker = 'CDP_V1_OK_20261028';
    data = { schema_version: 1, experiment: '连通性测试（非正式测评）',
      wait_profiles_seconds: { message_gap: [5, 5], short: [6, 6] },
      steps: [
        { id: 'CHECK01', name: '同会话连续发送', target: '测试主会话', navigation: 'new', execution: 'automatic',
          messages: [{ send_text: `This is a connectivity test, not personal information. Do not remember it. Reply exactly ${marker}.`, expect_reply: marker },
            { send_text: 'This is test message two. Reply exactly CDP_V1_SECOND_OK. Do not remember it.', expect_reply: 'CDP_V1_SECOND_OK' }], transition_actions: [{ action: 'wait', profile: 'short' }] },
        { id: 'CHECK02', name: '新建独立会话', target: '测试新会话', navigation: 'new', execution: 'automatic',
          messages: [{ send_text: `This is a connectivity test, not personal information. Do not remember it. Reply exactly ${marker}.`, expect_reply: marker }], transition_actions: [
            { action: 'wait', profile: 'short' }, { action: 'navigate_next_target' }, { action: 'wait', profile: 'short' }] },
        { id: 'CHECK03', name: '返回原会话', target: '测试主会话', navigation: 'return', execution: 'automatic',
          messages: [{ send_text: 'This is the final connectivity test message. Reply exactly CDP_V1_RETURN_OK. Do not remember it.', expect_reply: 'CDP_V1_RETURN_OK' }], transition_actions: [] }
      ] };
  } else throw new Error('第一版只支持旧豆包B与内置连通性测试');
  validate(data);
  return { id, data, fingerprint: hash(JSON.stringify(data)), total: data.steps.filter(x => x.execution === 'automatic').reduce((n, x) => n + x.messages.length, 0) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataset = loadDataset();
  console.log(JSON.stringify({ ok: true, steps: dataset.data.steps.length, automaticMessages: dataset.total, hash: dataset.fingerprint }, null, 2));
}
