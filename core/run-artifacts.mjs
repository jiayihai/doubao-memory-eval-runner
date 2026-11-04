import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { saveJSON } from './store.mjs';

export const ARTIFACT_INDEX = '产物索引.json';
const read = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const modified = file => { try { return statSync(file).mtimeMs; } catch { return 0; } };
const regular = file => { try { return statSync(file).isFile(); } catch { return false; } };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const leaf = file => typeof file === 'string' ? basename(file.replaceAll('\\', '/')) : '';

function describe(result, directory, currentCompleted, fallbackTotal = null) {
  const name = leaf(result?.file);
  if (!name || extname(name).toLowerCase() !== '.xlsx') return null;
  // Paths are always rebased to this run's output directory. Historical receipts
  // keep their original absolute paths, but never open a different run's file.
  const file = resolve(directory, '测评结果', name);
  const processedRows = count(result.processedRows) ?? count(result.savedReplies);
  const totalRows = count(result.totalRows) ?? fallbackTotal;
  const kind = processedRows !== null && totalRows > 0 ? (processedRows >= totalRows ? 'final' : 'stage') : 'unknown';
  const label = kind === 'final' ? '全流程结果' : kind === 'stage' ? '阶段结果' : '已生成结果';
  return { file, available: regular(file), kind, label, processedRows, totalRows,
    stale: processedRows !== null && currentCompleted > processedRows,
    skippedRows: count(result.skippedRows) ?? 0,
    copyStatus: result.copyStatus || null, sourceFile: result.sourceFile || null };
}

// A view operation only reads receipts and directories. It never changes sender
// state, generates workbooks, navigates the product, or repairs old records.
export function readRunArtifacts({ directory, state, dataset = null, automaticRecord = null }) {
  if (!directory || !state?.runId) return { result: null, backups: [] };
  const currentCompleted = (state.completions?.length || 0) + Object.keys(state.manualResults || {}).length;
  const candidates = [];
  const add = (result, at, origin) => {
    const view = describe(result, directory, currentCompleted);
    if (view) candidates.push({ ...view, generatedAt: Number(at) || 0, origin });
  };
  for (const name of [ARTIFACT_INDEX, '结果副本状态.json', '结果生成状态.json', '结果生成状态_全部步骤.json']) {
    const path = join(directory, name), receipt = read(path);
    if (receipt?.runId === state.runId && receipt.result && (!receipt.status || receipt.status === 'succeeded'))
      add(receipt.result, receipt.generatedAt || receipt.finishedAt || receipt.updatedAt || modified(path), name);
  }
  if (automaticRecord?.runId === state.runId && automaticRecord.status === 'succeeded')
    add(automaticRecord.result, automaticRecord.finishedAt, 'memory_receipt');
  const output = join(directory, '测评结果');
  if (existsSync(output)) {
    let names = []; try { names = readdirSync(output); } catch { /* Display other receipts. */ }
    for (const name of names.filter(name => name.endsWith('.回填说明.json'))) {
      const path = join(output, name), report = read(path);
      if (report?.run?.id === state.runId && typeof report.result === 'string')
        add({ ...report, file: report.result }, report.generatedAt || report.run.snapshotAt || modified(path), name);
    }
  }
  // Missing latest output stays missing; do not silently present an older file
  // as the latest result, nor regenerate it when the user asks to view it.
  candidates.sort((a, b) => b.generatedAt - a.generatedAt || a.origin.localeCompare(b.origin));
  const result = candidates[0] || null;
  const backups = [];
  const addBackup = (path, identityId, kind) => {
    if (!existsSync(path)) return;
    try { if (!statSync(path).isDirectory()) return; } catch { return; }
    backups.push({ path: resolve(path), identityId, kind,
      label: identityId ? `身份${identityId} · ${kind === 'manual' ? '人工录入备份' : '自动会话备份'}` : '本轮会话备份' });
  };
  addBackup(join(directory, '会话备份'), null, 'automatic');
  const identities = [...new Set((dataset?.data.steps || []).map(step => step.identityId).filter(Boolean))].sort();
  for (const identityId of identities) {
    if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(identityId)) continue;
    addBackup(join(directory, '身份', identityId, '会话备份'), identityId, 'automatic');
    addBackup(join(directory, '身份', identityId, '人工会话备份'), identityId, 'manual');
  }
  return { result, backups };
}

export function recordRunResult({ directory, state, result, now = Date.now() }) {
  const view = describe(result, directory, 0);
  if (!view?.available) return result;
  const indexed = { ...result, artifactKind: view.kind };
  try {
    saveJSON(join(directory, ARTIFACT_INDEX), { schemaVersion: 1, runId: state.runId,
      generatedAt: now, result: indexed });
    return indexed;
  } catch (error) {
    return { ...indexed, warning: [result.warning, '结果已生成，但快捷入口索引保存失败：' + error.message].filter(Boolean).join('；') };
  }
}
