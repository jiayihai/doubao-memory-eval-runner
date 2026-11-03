import { readFile, mkdir, copyFile, rename, writeFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hash } from '../../core/store.mjs';
import { beijingStamp, buildFillPlan } from '../../core/excel-results.mjs';

function check(condition, message) { if (!condition) throw new Error(message); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const blank = value => value === '' || value === null || value === undefined;
const literal = text => text.startsWith('=') ? "'" + text : text;
function textHeight(text, width) {
  const lines = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(
    [...line].reduce((n, ch) => n + (ch.codePointAt(0) > 255 ? 15 : 8), 0) / (width - 20))), 0);
  return lines * 21 + 18;
}
function expandRow(sheet, row, lastColumn, requiredHeight) {
  const range = sheet.getRange(`A${row}:${lastColumn}${row}`), current = Number(range.format.rowHeightPx) || 0;
  // Excel has a native 409.5pt row-height limit (546px at 96dpi).
  const height = Math.min(546, Math.max(current, requiredHeight));
  if (height > current) range.format.rowHeightPx = height;
}

export async function generateResultWorkbook(input, { outputDirectory, qaDirectory } = {}) {
  let runtime;
  try { runtime = await import('@oai/artifact-tool'); }
  catch { throw new Error('找不到表格处理运行库，请检查 tools/spreadsheets/node_modules；发送功能和已保存回复不受影响'); }
  const { FileBlob, SpreadsheetFile } = runtime;
  check(input.product === '豆包' && input.run?.datasetId === 'doubao-b', '当前只支持豆包旧B结果表');
  check(/^[\w-]+$/.test(input.run.id || '') && basename(input.directory) === input.run.id, '结果运行编号无效');
  const output = outputDirectory ? resolve(outputDirectory) : join(input.directory, '测评结果');
  await mkdir(output, { recursive: true });
  const generationId = randomUUID().slice(0, 8), generatedAt = Date.now();
  const usage = input.run.purpose === 'technical_regression' ? '技术回归结果' : '测评结果';
  const name = `豆包_${usage}_${beijingStamp(input.run.createdAt)}_${input.run.id.slice(-6)}_生成${beijingStamp(generatedAt)}_${generationId}`;
  const stage = join(output, `.生成中_${generationId}.xlsx`), stageReport = join(output, `.生成中_${generationId}.json`);
  const resultFile = join(output, name + '.xlsx'), reportFile = join(output, name + '.回填说明.json');
  let publishedWorkbook = false;
  try {
    // Start from a real template copy. Original bytes are never opened for write.
    await copyFile(input.template, stage, constants.COPYFILE_EXCL);
    check(hash(await readFile(stage)) === input.templateHash, '模板在生成过程中发生变化，请重新点击生成');
    const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(stage));
    const flow = workbook.worksheets.getItem('全过程执行表'), questions = workbook.worksheets.getItem('独立问题表');
    const beforeFlow = flow.getUsedRange().values, beforeQuestions = questions.getUsedRange().values;
    const flowFormulas = flow.getUsedRange().formulas, questionFormulas = questions.getUsedRange().formulas;
    const plan = buildFillPlan(input, beforeFlow, beforeQuestions);
    const displayLimitedRows = [];
    check(beforeFlow.length === 56 && beforeQuestions.length === 22, '模板有效范围不一致');
    for (let row = 2; row <= 22; row++) {
      check(questions.getRange(`L${row}`).formulas[0][0] && questions.getRange(`M${row}`).formulas[0][0],
        `问题表第${row}行缺少回答或状态关联公式`);
    }
    if (qaDirectory) {
      await mkdir(qaDirectory, { recursive: true });
      for (const [sheetName, range, filename] of [['全过程执行表','H13:L15','模板_执行表.png'],['独立问题表','K1:M3','模板_问题表.png']]) {
        const preview = await workbook.render({ sheetName, range, scale: 1, format: 'png' });
        await writeFile(join(qaDirectory, filename), new Uint8Array(await preview.arrayBuffer()));
      }
    }
    for (const item of plan.fills) {
      const answerHeight = textHeight(item.answer, 440);
      if (answerHeight > 546) {
        item.note += (item.note ? ' ' : '') + '回答较长，Excel行高显示有上限；完整正文请查看单元格编辑栏或会话备份。';
        displayLimitedRows.push({ key:item.key, row:item.row, questionRow:item.questionRow });
      }
      flow.getRange(`I${item.row}:K${item.row}`).values = [[literal(item.answer), item.status, item.note]];
      expandRow(flow, item.row, 'R', Math.max(answerHeight, textHeight(item.note, 230)));
      if (item.questionRow) expandRow(questions, item.questionRow, 'P', answerHeight);
    }
    workbook.recalculate();
    const afterFlow = flow.getUsedRange().values, afterQuestions = questions.getUsedRange().values;
    check(same(flowFormulas, flow.getUsedRange().formulas) && same(questionFormulas, questions.getUsedRange().formulas),
      '回填改变了原有公式，已取消生成');
    for (let r = 0; r < beforeFlow.length; r++) for (let c = 0; c < beforeFlow[r].length; c++) {
      if (r > 0 && c >= 8 && c <= 10) continue;
      check(same(beforeFlow[r][c], afterFlow[r][c]), `回填意外改变了执行表第${r + 1}行第${c + 1}列`);
    }
    for (let r = 0; r < beforeQuestions.length; r++) for (let c = 0; c < beforeQuestions[r].length; c++) {
      if (r > 0 && (c === 11 || c === 12)) continue;
      check(same(beforeQuestions[r][c], afterQuestions[r][c]), `回填意外改变了问题表第${r + 1}行第${c + 1}列`);
    }
    const filledRows = new Set(plan.fills.map(x => x.row));
    for (const item of plan.fills) {
      const actual = afterFlow[item.row - 1];
      check(actual[8] === item.answer || actual[8] === literal(item.answer), `回答写入核验失败：${item.key}`);
      check(actual[9] === item.status && actual[10] === item.note, `状态或异常说明写入失败：${item.key}`);
      if (item.questionRow) {
        const q = afterQuestions[item.questionRow - 1];
        check((q[11] === item.answer || q[11] === literal(item.answer)) && q[12] === item.status,
          `问题表关联公式未正确回填：${item.questionId}`);
      }
    }
    for (let row = 2; row <= 56; row++) if (!filledRows.has(row)) {
      check(blank(afterFlow[row - 1][8]) && afterFlow[row - 1][9] === '未执行', `未执行行被错误填写：${row}`);
    }
    const questionFilled = new Set(plan.fills.filter(x => x.questionRow).map(x => x.questionRow));
    for (let row = 2; row <= 22; row++) if (!questionFilled.has(row)) {
      check(blank(afterQuestions[row - 1][11]) && afterQuestions[row - 1][12] === '未执行', `未执行问题被错误填写：${row}`);
    }
    // Check calculated cells, not raw reply text which may itself quote '#N/A'.
    for (let row = 2; row <= 22; row++) for (const col of [11, 12]) {
      check(!/^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)$/.test(String(afterQuestions[row - 1][col])),
        `问题表公式错误：第${row}行`);
    }
    if (qaDirectory) {
      for (const [sheetName, range, filename] of [['全过程执行表','H13:L15','结果_执行表.png'],['独立问题表','K1:M3','结果_问题表.png'],['全过程执行表','H55:L56','结果_人工节点.png']]) {
        const preview = await workbook.render({ sheetName, range, scale: 1, format: 'png' });
        await writeFile(join(qaDirectory, filename), new Uint8Array(await preview.arrayBuffer()));
      }
    }
    await (await SpreadsheetFile.exportXlsx(workbook)).save(stage);
    check(hash(await readFile(input.template)) === input.templateHash, '原模板已变化，取消本次生成，请重新操作');
    const report = { schemaVersion: 1, product: input.product, run: input.run, generatedAt,
      scope: 'completed_saved_script_turns_at_snapshot', timezone: 'Asia/Shanghai',
      template: input.template, templateHash: input.templateHash, result: basename(resultFile),
      resultHash: hash(await readFile(stage)), ...plan.counts, warnings: plan.warnings,
      displayLimitedRows,
      matching: '原流程定位＋消息序号＋原文精确校验；问题表按问题ID公式关联',
      rows: plan.fills.map(({ answer, ...item }) => item) };
    await writeFile(stageReport, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await rename(stage, resultFile); publishedWorkbook = true;
    await rename(stageReport, reportFile);
    return { directory: output, file: resultFile, report: reportFile, runId: input.run.id,
      ...plan.counts, longReplyCount:displayLimitedRows.length, warnings: plan.warnings };
  } catch (error) {
    if (publishedWorkbook) error.message += `；结果Excel已写入 ${resultFile}，但回填说明未完成，可重新生成`;
    throw error;
  } finally {
    for (const file of [stage, stageReport, stage + '.inspect.ndjson']) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let raw = ''; for await (const chunk of process.stdin) { raw += chunk; check(raw.length <= 5000000, '回填输入过大'); }
    const result = await generateResultWorkbook(JSON.parse(raw));
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1;
  }
}
