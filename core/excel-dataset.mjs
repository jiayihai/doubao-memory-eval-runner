import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { hash, saveJSON } from './store.mjs';

export function compileExcelDataset(report) {
  if (!report?.valid || report.scope !== 'validation_and_preview_only') throw new Error('测评集尚未校验通过，请重新选择并校验');
  const automatic = report.steps.filter(s=>s.mode==='AUTO'), identities = [...new Set(automatic.map(s=>s.identityId))];
  if (identities.length !== 1) throw new Error('当前自动执行需且仅需一个自动账号身份；其他账号的步骤请标为MANUAL');
  for (const s of report.steps) {
    if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(s.identityId) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s.identityId)) throw new Error('身份ID须为可保存的文字、数字、横线或下划线，最长40字符');
    if (s.mode==='AUTO' && s.anchorQuestionId) throw new Error('当前计时锚点支持人工节点；自动节点请使用“回复后等待秒数”');
  }
  const data = { schema_version:1, kind:'excel', experiment:report.file.name,
    source:{ path:report.file.path, name:report.file.name, sha256:report.file.sha256 },
    automatic_identity:identities[0], wait_profiles_seconds:{message_gap:[0,0]},
    steps:report.steps.map(s=>({ id:s.stepId, name:s.questionId||s.messageType,
      target:s.identityId+'::'+s.conversationId, identityId:s.identityId, conversationName:s.conversationId,
      execution:s.mode==='AUTO'?'automatic':'manual', navigation:s.navigation, kind:s.messageType,
      messages:[{send_text:s.content}], replyAfterSeconds:s.waitSeconds, sourceStep:structuredClone(s),
      transition_actions:[], t17_anchor:false })) };
  return wrap(data);
}
function wrap(data) {
  return {id:'excel',data,fingerprint:hash(JSON.stringify(data)),total:data.steps.length,
    automaticTotal:data.steps.filter(s=>s.execution==='automatic').length,
    manualTotal:data.steps.filter(s=>s.execution==='manual').length};
}
export function freezeExcelDataset(directory, report, dataset=compileExcelDataset(report)) {
  const bytes=readFileSync(report.file.path);
  if(hash(bytes)!==report.file.sha256)throw new Error('所选Excel在预览后发生变化，请重新校验');
  writeFileSync(join(directory,'输入测评集.xlsx'),bytes,{flag:'wx'});
  saveJSON(join(directory,'scenario.json'),dataset.data);
  saveJSON(join(directory,'测评集来源.json'),{schemaVersion:1,sourcePath:report.file.path,sourceHash:report.file.sha256,
    snapshot:'输入测评集.xlsx',datasetHash:dataset.fingerprint,summary:report.summary,createdAt:Date.now()});
  return dataset;
}
export function loadExcelDataset(directory, state=null) {
  const data=JSON.parse(readFileSync(join(directory,'scenario.json'),'utf8'));
  if(data.kind!=='excel'||!Array.isArray(data.steps)||!data.source?.sha256)throw new Error('本轮Excel流程快照格式无效');
  const dataset=wrap(data);
  if(state&&dataset.fingerprint!==state.datasetHash)throw new Error('本轮冻结流程已改变，不能继续断点');
  if(hash(readFileSync(join(directory,'输入测评集.xlsx')))!==data.source.sha256)throw new Error('本轮Excel输入快照校验失败');
  return dataset;
}
export function excelSourceDirectory(dataset) { return dirname(dataset.data.source.path); }
