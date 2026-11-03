import { readFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDataset } from '../datasets/index.mjs';
import { hash } from './store.mjs';

export const DEFAULT_TEMPLATE = '旧豆包B测评集_全过程与独立问题表.xlsx';
export function templatePath(root) {
  return resolve(root, 'examples', 'legacy', DEFAULT_TEMPLATE);
}
function requireThat(condition, message) { if (!condition) throw new Error(message); }
export function beijingStamp(time) {
  requireThat(Number.isFinite(time), '运行时间无效');
  return new Date(time + 8 * 3600000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
}

// Read an immutable prefix of completed turns. This never reads pending drafts,
// writes run state, or connects to the product. The sender can continue separately.
export function collectResultInput({ root, directory, state, template = templatePath(root) }) {
  const s = structuredClone(state);
  requireThat(s?.datasetId === 'doubao-b', '本次按钮只支持旧豆包B测评集，不支持4条连通性测试');
  requireThat(s.features?.captureReplies, '这一轮没有开启回复保存，请使用已保存回复的新版运行记录');
  requireThat(/^[\w-]+$/.test(s.runId || '') && basename(directory) === s.runId, '运行编号与记录目录不一致');
  const dataset = loadDataset('doubao-b');
  requireThat(dataset.fingerprint === s.datasetHash, '本轮冻结流程与当前旧B流程不一致，不能回填');
  const scenario = JSON.parse(readFileSync(join(directory, 'scenario.json'), 'utf8'));
  requireThat(hash(JSON.stringify(scenario)) === s.datasetHash, '本轮流程快照校验失败');
  requireThat(Array.isArray(s.completions) && s.completions.length > 0, '当前还没有已完成并保存的回复');
  const expected = scenario.steps.filter(step => step.execution === 'automatic').flatMap(step =>
    step.messages.map((message, i) => ({ key: `${step.id}:${i}`, step, message })));
  requireThat(s.completions.length <= expected.length, '完成记录数量异常');
  const userIds = new Set(), answerIds = new Set();
  const turns = s.completions.map((c, i) => {
    const x = expected[i];
    requireThat(c.key === x.key, `完成记录顺序不一致：${c.key}`);
    const filename = `${c.stepId}_${String(c.messageIndex + 1).padStart(3, '0')}.json`;
    requireThat(c.replyArchive?.status === 'saved' && c.replyArchive.replyFile === `回复记录/${filename}`,
      `${c.key}没有已核验的回复文件，不会把缺失回答填成成功`);
    const r = JSON.parse(readFileSync(join(directory, '回复记录', filename), 'utf8'));
    requireThat(r.schemaVersion === 1 && r.scope === 'this_run_script_turn' && r.runId === s.runId
      && r.datasetId === s.datasetId && r.datasetHash === s.datasetHash && r.account === s.account,
    `${c.key}回复来源不属于本轮运行`);
    requireThat(r.sequence === i + 1 && r.key === c.key && r.stepId === x.step.id && r.messageIndex === c.messageIndex
      && r.conversationId === x.step.target && c.target === r.conversationId && r.prompt === x.message.send_text,
    `${c.key}回复与发送流程不一致`);
    requireThat(typeof r.answer === 'string' && r.answer.trim().length > 0
      && hash(r.answer) === r.answerHash && hash(r.prompt) === r.promptHash, `${c.key}正文哈希或回答内容无效`);
    for (const key of ['promptHash', 'answerHash', 'href', 'userMessageId', 'answerMessageId', 'sendAttemptedAt',
      'sendConfirmedAt', 'answerCompletionObservedAt', 'completionTimeUncertain', 'completionBasis', 'recovered']) {
      requireThat(r[key] === c[key], `${c.key}回复与完成记录不一致：${key}`);
    }
    requireThat(typeof r.userMessageId === 'string' && r.userMessageId && typeof r.answerMessageId === 'string' && r.answerMessageId
      && !userIds.has(r.userMessageId) && !answerIds.has(r.answerMessageId), `${c.key}消息编号缺失或重复`);
    requireThat(/^\/chat\/\d+$/.test(r.href) && s.conversations?.[r.conversationId]?.href === r.href,
      `${c.key}实际会话地址不一致`);
    requireThat(r.answer.length <= 32767, `${c.key}回答超过Excel单元格32767字符上限；原回复已保存，本版不截断回填`);
    userIds.add(r.userMessageId); answerIds.add(r.answerMessageId);
    return r;
  });
  const templateBytes = readFileSync(template);
  return { schemaVersion: 1, template: resolve(template), templateHash: hash(templateBytes),
    directory: resolve(directory), product: '豆包',
    run: { id: s.runId, datasetId: s.datasetId, datasetHash: s.datasetHash, account: s.account,
      purpose: s.purpose, createdAt: s.createdAt, status: s.status, phase: s.phase,
      totalAutomatic: expected.length, snapshotAt: Date.now() }, scenario, turns };
}

export const FLOW_HEADERS = ['步骤ID','身份ID','会话ID','消息类型','问题ID','发送内容','回复后等待秒数','执行方式',
  '实际回答','执行状态','异常说明','原流程定位','原等待规则（参考）','计时锚点问题ID','距锚点最早秒数','距锚点最晚秒数','执行约束','来源'];
export const QUESTION_HEADERS = ['问题ID','用例ID','测评能力','步骤ID','身份ID','会话ID','测试问题','预期回答要点',
  '评分标准','前置问题ID','计分口径','实际回答','执行状态','评分说明','前置条件','来源'];

// Pure matching: never infer a row by similar wording or an AI judgement.
export function buildFillPlan(input, flowValues, questionValues) {
  requireThat(input.schemaVersion === 1 && input.run?.datasetId === 'doubao-b', '回填输入版本无效');
  for (const [values, headers, name] of [[flowValues, FLOW_HEADERS, '全过程执行表'], [questionValues, QUESTION_HEADERS, '独立问题表']]) {
    requireThat(Array.isArray(values) && headers.every((h, i) => values[0]?.[i] === h), `${name}表头与本次固定模板不一致`);
  }
  const source = new Map(input.scenario.steps.flatMap(step => step.messages.map((m, i) =>
    [`${step.id}:${i}`, { step, text: m.send_text }])));
  requireThat(flowValues.length === source.size + 1 && source.size === 55, '全过程执行表须保留旧B的55条消息（54自动＋1人工）');
  const locations = new Map(), stepIds = new Set(), qids = new Set();
  const questionRows = new Map();
  for (let i = 1; i < flowValues.length; i++) {
    const row = flowValues[i], match = /^(S\d{2})\s*\/\s*消息([1-9]\d*)$/.exec(row[11] || '');
    requireThat(match, `执行表第${i + 1}行缺少有效的原流程定位`);
    const key = `${match[1]}:${Number(match[2]) - 1}`, expected = source.get(key);
    requireThat(expected && !locations.has(key), `执行表原流程定位缺失、重复或未知：${row[11]}`);
    requireThat(typeof row[0] === 'string' && row[0] && !stepIds.has(row[0]), `执行表步骤ID缺失或重复：第${i + 1}行`);
    requireThat(row[1] === 'A' && row[2] === expected.step.target && row[5] === expected.text
      && row[7] === (expected.step.execution === 'automatic' ? 'AUTO' : 'MANUAL'), `${key}会话、身份、执行方式或发送原文与旧流程不一致`);
    const isQuestion = ['检查', '复测'].includes(expected.step.kind);
    requireThat(row[3] === (isQuestion ? 'QUESTION' : 'HISTORY'), `${key}消息类型不一致`);
    requireThat(!row[8] && row[9] === '未执行' && !row[10], '请选择空白测评集模板；不能将已填写结果的文件作为本次模板');
    if (isQuestion) {
      requireThat(typeof row[4] === 'string' && row[4] && !qids.has(row[4]), `${key}问题ID缺失或重复`);
      qids.add(row[4]); questionRows.set(row[4], { row, key, excelRow: i + 1 });
    } else requireThat(!row[4], `${key}历史输入不应填写问题ID`);
    locations.set(key, { row, excelRow: i + 1 }); stepIds.add(row[0]);
  }
  requireThat(questionValues.length === questionRows.size + 1 && questionRows.size === 21, '独立问题表须保留21个问题节点');
  const questionSeen = new Set();
  for (let i = 1; i < questionValues.length; i++) {
    const row = questionValues[i], linked = questionRows.get(row[0]);
    requireThat(linked && !questionSeen.has(row[0]), `独立问题表问题ID重复或找不到执行步骤：第${i + 1}行`);
    requireThat(row[3] === linked.row[0] && row[4] === linked.row[1] && row[5] === linked.row[2]
      && row[6] === linked.row[5] && typeof row[8] === 'string' && row[8].trim(), `问题${row[0]}的步骤、会话、原文或评分标准不一致`);
    questionSeen.add(row[0]); linked.questionExcelRow = i + 1;
  }
  const seen = new Set();
  const fills = input.turns.map(turn => {
    const located = locations.get(turn.key), expected = source.get(turn.key);
    requireThat(located && expected.step.execution === 'automatic' && !seen.has(turn.key), `回复步骤无法唯一匹配：${turn.key}`);
    requireThat(turn.prompt === located.row[5] && turn.conversationId === located.row[2], `回复原文或会话不一致：${turn.key}`);
    requireThat(typeof turn.answer === 'string' && turn.answer.trim() && turn.answer.length <= 32767,
      `${turn.key}回答为空或超过Excel单元格上限`);
    seen.add(turn.key);
    const question = questionRows.get(located.row[4]);
    const notes = [];
    if (turn.completionTimeUncertain) notes.push('回答结束时间不确定；按恢复后观察时间记录，不能视为精确平台时间。');
    if (turn.recovered) notes.push('本条在恢复后核对完成。');
    return { key: turn.key, stepId: located.row[0], row: located.excelRow, questionId: located.row[4] || null,
      questionRow: question?.questionExcelRow || null, answer: turn.answer, status: '已完成', note: notes.join(' '),
      replyFile: `回复记录/${turn.stepId}_${String(turn.messageIndex + 1).padStart(3, '0')}.json`,
      answerHash: turn.answerHash, userMessageId: turn.userMessageId, answerMessageId: turn.answerMessageId };
  });
  requireThat(fills.length > 0, '没有可回填的已完成回复');
  return { fills, counts: { savedReplies: fills.length, totalRows: source.size, automaticRows: 54, manualRows: 1,
    questionsFilled: fills.filter(x => x.questionId).length, questionsTotal: questionRows.size,
    unexecutedRows: source.size - fills.length, uncertainReplies: input.turns.filter(x => x.completionTimeUncertain).length },
  warnings: [
    ...(input.run.purpose === 'technical_regression' ? ['本轮为技术回归，沿用当前账号状态，不用于产品记忆能力评分。'] : []),
    '已完成仅表示发送、取回和保存成功，不代表能力测试通过；本功能不自动评分。',
    '人工T17未由本轮自动执行或采集，保持空白和未执行。',
    ...(fills.length < 54 ? ['本文件是生成时已完成消息的快照，后续新增回复需再次点击生成。'] : [])
  ] };
}

export function runResultWorker(input, { worker = fileURLToPath(new URL('../tools/spreadsheets/backfill-worker.mjs', import.meta.url)), timeoutMs = 120000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [worker], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('生成结果表超时，原模板和回复记录未改动，可稍后重试')); }, timeoutMs);
    function finish(error, result) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolveResult(result); }
    child.on('error', error => finish(error));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1000000) { child.kill(); finish(new Error('表格进程返回异常')); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('close', code => {
      if (settled) return;
      try {
        const message = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
        if (code !== 0 || !message.ok) throw new Error(message.error || stderr || '结果表生成失败');
        finish(null, message.result);
      } catch (error) { finish(new Error(`结果表未生成：${error.message}${!stdout.trim() && stderr ? '；' + stderr : ''}`)); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
