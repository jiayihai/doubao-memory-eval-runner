import { resolve } from 'node:path';
import { loadJSON, saveJSON } from './store.mjs';

export const AUTO_RESULT_FILE = '结果生成状态.json';
export function automaticResultsEnabled(state) {
  return ['doubao-b','excel'].includes(state?.datasetId) && state.features?.captureReplies === true
    && state.features?.autoGenerateResults === true;
}

// A separate receipt owns result generation, never sender progress. A previous
// attempt is not replayed on startup: the manual button is the recovery path.
export class AutomaticResults {
  constructor({ directory, runId, onUpdate = () => {}, clock = Date.now, filename=AUTO_RESULT_FILE }) {
    this.file = resolve(directory, filename);
    this.runId = runId; this.onUpdate = onUpdate; this.clock = clock; this.task = null;
    try {
      this.record = loadJSON(this.file);
      if (this.record && (this.record.schemaVersion !== 1 || this.record.runId !== runId
        || !['running', 'succeeded', 'failed'].includes(this.record.status))) throw new Error('结果生成记录格式或运行编号不符');
      if (this.record?.status === 'running') this.record = { ...this.record, status:'interrupted',
        error:'上次结果生成中断，请点击“生成结果 Excel”重新生成；无需重发消息。' };
    } catch (error) {
      this.record = { schemaVersion:1, runId, status:'failed', error:`无法读取结果生成状态：${error.message}` };
    }
  }
  get running() { return !!this.task; }
  update(record) {
    this.record = record;
    saveJSON(this.file, record);
    // Log failure must not turn successful sending into an execution error.
    try { this.onUpdate(record); } catch { /* The independent receipt is retained. */ }
  }
  runOnce(generate) {
    if (this.task) return this.task;
    if (this.record) return Promise.resolve(this.record);
    this.task = Promise.resolve().then(async () => {
      const startedAt = this.clock();
      let producedResult = null;
      try {
        this.update({ schemaVersion:1, runId:this.runId, status:'running', source:'automatic', startedAt });
        const result = await generate(); producedResult = result;
        this.update({ schemaVersion:1, runId:this.runId, status:'succeeded', source:'automatic',
          startedAt, finishedAt:this.clock(), result });
      } catch (error) {
        if (producedResult) {
          this.record = { schemaVersion:1, runId:this.runId, status:'succeeded', source:'automatic',
            startedAt, finishedAt:this.clock(), result:producedResult,
            warning:`结果已生成，但生成状态保存失败：${error.message}` };
          try { this.onUpdate(this.record); } catch { /* Retain successful file information. */ }
          return this.record;
        }
        const failure = { schemaVersion:1, runId:this.runId, status:'failed', source:'automatic',
          startedAt, finishedAt:this.clock(), error:error.message };
        try { this.update(failure); }
        catch (saveError) {
          this.record = { ...failure, error:`${failure.error}；生成状态未能保存：${saveError.message}` };
          try { this.onUpdate(this.record); } catch { /* Display remains available from memory. */ }
        }
      }
      return this.record;
    }).finally(() => { this.task = null; });
    return this.task;
  }
  recoveredManually(result) {
    if (!['failed', 'interrupted'].includes(this.record?.status)) return;
    const record = { schemaVersion:1, runId:this.runId, status:'succeeded', source:'manual',
      startedAt:this.record.startedAt ?? this.clock(), finishedAt:this.clock(), previousError:this.record.error, result };
    try { this.update(record); }
    catch (error) {
      // The workbook already exists. Keep its successful receipt visible rather
      // than reporting the exported file as absent or touching sender state.
      this.record = { ...record, warning:`结果已生成，但状态保存失败：${error.message}` };
    }
  }
}

export function resultActivity(state, record) {
  if(state?.datasetId==='excel'&&automaticResultsEnabled(state)){
    if(!['finished','manual'].includes(state.phase))return state.activity;
    const label=state.phase==='manual'?'自动部分已完成，等待人工步骤':'表内全部步骤已处理';
    if(record?.status==='running')return label+'，正在生成结果表';
    if(record?.status==='succeeded')return label+(record.result.copyStatus==='failed'?'；原Excel目录副本未保存，可用结果按钮补存':'；结果表已保存');
    if(['failed','interrupted'].includes(record?.status))return label+'；结果导出未完成，可用结果按钮重试';
    return state.activity;
  }
  if (!automaticResultsEnabled(state) || state.phase !== 'finished'
    || !['completed', 'awaiting_manual'].includes(state.status)) return state?.activity;
  const suffix = state.status === 'awaiting_manual' ? '；T17仍待人工执行' : '';
  if (record?.status === 'running') return `自动部分已完成，正在生成结果表${suffix}`;
  if (record?.status === 'succeeded') return `自动部分已完成，结果表已${record.source === 'manual' ? '手动' : '自动'}生成${suffix}`;
  if (['failed', 'interrupted'].includes(record?.status)) return `自动部分已完成，结果导出未完成，请用按钮重试${suffix}`;
  return `自动部分已完成，可用按钮生成结果表${suffix}`;
}
