import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadDataset } from './datasets/index.mjs';
import { DoubaoAdapter } from './adapters/doubao.mjs';
import { sleep } from './adapters/cdp.mjs';
import { Engine } from './core/engine.mjs';
import { loadExecutionPolicy } from './core/policy.mjs';
import { exportCurrentLoaded } from './core/conversation-export.mjs';
import { ReplyArchive } from './core/reply-archive.mjs';
import { collectResultInput, runResultWorker, templatePath } from './core/excel-results.mjs';
import { AutomaticResults, automaticResultsEnabled, resultActivity } from './core/automatic-results.mjs';
import { previewDatasetFile } from './core/dataset-preview.mjs';
import { compileExcelDataset,freezeExcelDataset } from './core/excel-dataset.mjs';
import { ExcelEngine } from './core/excel-engine.mjs';
import { excelArchive,collectExcelResultInput,generateExcelResults,runExcelResultWorker } from './core/excel-output.mjs';
import { manualStepDetails,commitManualResult } from './core/manual-results.mjs';
import { readRunArtifacts, recordRunResult } from './core/run-artifacts.mjs';
import { saveJSON, loadJSON, lockDirectory, findSent, ReviewRequired, Interrupted } from './core/store.mjs';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export class Controller {
  constructor(root = ROOT) {
    this.root = root; this.dataDir = resolve(root, '运行数据');
    this.settingsPath = resolve(this.dataDir, 'settings.json');
    this.settings = loadJSON(this.settingsPath, { port: 9223, executable: process.env.DOUBAO_EXECUTABLE || '', lastRun: null });
    this.state = null; this.directory = null; this.active = false; this.requested = null;
    this.logs = []; this.adapter = null; this.task = null; this.busy = false;
    this.resultTask = null; this.automaticResults = null; this.previewTask = null;
    this.connection = { ok: false, message: '请先检查连接' };
    if (this.settings.lastRun && /^[\w-]+$/.test(this.settings.lastRun)) {
      this.directory = resolve(this.dataDir, this.settings.lastRun);
      this.state = loadJSON(resolve(this.directory, 'state.json'));
      const awaitingHuman = this.state?.datasetId === 'excel' && this.state.phase === 'manual' && this.state.status === 'awaiting_manual';
      if (this.state && this.state.phase !== 'finished' && !awaitingHuman && !['paused', 'stopped', 'needs_review', 'error'].includes(this.state.status)) {
        this.state.status = 'paused'; this.state.activity = '上次运行中断，点击继续可核对并恢复';
        if (this.state.pending) { this.state.pending.candidate = null; this.state.pending.recovered = true; }
        this.save();
      }
      if (this.state) {
        const file = resolve(this.directory, 'events.jsonl');
        if (existsSync(file)) this.logs = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-30).flatMap(line => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
      }
    }
    this.configureAutomaticResults();
  }
  save() { if (this.state) saveJSON(resolve(this.directory, 'state.json'), this.state); }
  event(type, message, details = {}) {
    if (['sent', 'message_completed'].includes(type) && this.state) {
      this.connection = { ok: true, account: this.state.account, port: this.state.port, message: '本轮连接已核验' };
    } else if (type === 'reconnecting') this.connection = { ok: false, message: '正在重连' };
    else if (type === 'recovered' && this.state) this.connection = { ok: true, account: this.state.account, port: this.state.port, message: '连接已恢复' };
    const item = { at: Date.now(), type, message, details };
    this.logs.push(item); this.logs = this.logs.slice(-40);
    if (this.directory) appendFileSync(resolve(this.directory, 'events.jsonl'), JSON.stringify(item) + '\n', 'utf8');
  }
  status() {
    const s = this.state;
    const data = s ? loadDataset(s.datasetId,this.directory) : null;
    const step = data?.data.steps[s?.stepIndex];
    const renameJobs = Object.values(s?.renameJobs || {});
    const archived = s?.completions.filter(x=>x.replyArchive?.status==='saved') || [];
    const manual=Object.values(s?.manualResults||{});
    return { version: '1.8.0', active: this.active, busy: this.busy || !!this.automaticResults?.running || !!this.previewTask || !!this.resultTask, connection: this.connection, settings: this.settings,
      logs: this.logs, directory: this.directory || this.dataDir,
      artifacts: readRunArtifacts({ directory:this.directory, state:s, dataset:data, automaticRecord:this.automaticResults?.record }),
      resultGeneration: { active: !!this.resultTask || !!this.automaticResults?.running, template: templatePath(this.root),
        automaticEnabled: automaticResultsEnabled(s), automatic: this.automaticResults?.record || null,
        available: ['doubao-b','excel'].includes(s?.datasetId) && !!s.features?.captureReplies && archived.length+manual.length > 0 },
      run: s && { id: s.runId, datasetId: s.datasetId, purpose: s.purpose || (s.datasetId === 'smoke' ? 'connectivity_test' : 'formal_evaluation'), account: s.account, status: s.status, activity: resultActivity(s, this.automaticResults?.record),
        step: step?.id || '完成', stepName: step?.name || '', target: step?.target || '',
        completed: s.completions.length+manual.length, automaticCompleted:s.completions.length,manualCompleted:manual.length,
        automaticTotal:data.automaticTotal ?? data.total, manualTotal:data.manualTotal ?? data.data.steps.filter(x=>x.execution==='manual').reduce((n,x)=>n+x.messages.length,0),
        phase:s.phase, pauseRequested:!!this.requested,
        inputName:data.data.kind==='excel'?data.data.source.name:null,
        inputPath:data.data.kind==='excel'?data.data.source.path:null,inputHash:data.data.kind==='excel'?data.data.source.sha256:null,
        manualSkipped:manual.filter(r=>r.status==='跳过').length,
        manualAvailable:s.datasetId==='excel'&&step?.execution==='manual'&&!this.active,
        total: data.total, messageNumber: s.messageIndex + 1,
        waitSeconds: s.wait ? Math.max(0, Math.ceil((s.wait.deadline - Date.now()) / 1000)) : null,
        observation: s.observation || null, recovery: s.recovery || null,
        stageElapsedSeconds: this.active && s.observation ? Math.max(0, Math.floor((Date.now() - s.observation.since) / 1000)) : null,
        stageRemainingSeconds: this.active && s.observation?.deadline ? Math.max(0, Math.ceil((s.observation.deadline - Date.now()) / 1000)) : null,
        confirmedSent: !!s.pending?.userId, completionTimeUncertainCount: s.completions.filter(x => x.completionTimeUncertain).length,
        namingEnabled: !!s.features?.renameConversations,
        namingDone: renameJobs.filter(x => x.status === 'done').length,
        namingPending: renameJobs.filter(x => ['pending','in_progress'].includes(x.status)).length,
        namingFailed: renameJobs.filter(x => x.status === 'failed').length,
        replyCaptureEnabled: !!s.features?.captureReplies, capturedReplies: archived.length,
        backupConversations: new Set(archived.map(x=>x.target)).size, replyAwaitingSave: !!s.pending?.replyToSave,
        pending: !!s.pending, canReviewRetry: s.status === 'needs_review' && s.pending && !s.pending.userId && !s.pending.deliveryFailure,
        resumable: s.phase !== 'finished', lastError: s.lastError || '', deviations: s.deviations.length,
        t17: s.t17 || null } };
  }
  async check(options = {}) {
    if (this.active) throw new Error('正在执行时请先暂停，再检查连接');
    const port = Number(options.port || this.settings.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口需为1024至65535之间的整数');
    const adapter = new DoubaoAdapter(port);
    try {
      const info = await adapter.choose();
      if (!info.account) throw new Error('豆包尚未登录，请先在豆包中登录');
      if (!info.dialogue) throw new Error('请在豆包中选中普通“对话”模式');
      if (!info.inputExists) throw new Error('请打开豆包聊天输入框');
      this.settings.port = port;
      if (options.executable) this.settings.executable = options.executable;
      saveJSON(this.settingsPath, this.settings);
      this.connection = { ok: true, account: info.account, port, draft: !!info.inputText.trim(), message: '已连接豆包普通对话模式' };
      return this.connection;
    } catch (error) { this.connection = { ok: false, message: error.message }; throw error; }
    finally { adapter.close(); }
  }
  async launch(options = {}) {
    if (this.active) throw new Error('请先暂停正在执行的任务');
    try { return await this.check(options); } catch { /* May not be running with a debug port. */ }
    const executable = options.executable || this.settings.executable;
    if (!executable || !existsSync(executable) || !/\.exe$/i.test(executable)) throw new Error('找不到豆包程序，请选择实际的 Doubao.exe');
    const port = Number(options.port || this.settings.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('调试端口无效');
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      try { return await this.check({ ...options, executable, port }); } catch { /* Wait for startup. */ }
    }
    throw new Error('豆包尚未建立调试连接。若豆包已在运行，请自行完全退出后，再点“启动豆包”；工具不会强制关闭它。');
  }
  async start(options) {
    if (this.active) throw new Error('已经在执行，不能重复开始');
    if (this.resultTask || this.automaticResults?.running) throw new Error('结果表正在生成，请完成后再开始新一轮');
    if (this.previewTask) throw new Error('测评集正在校验，请完成后再开始新一轮');
    if (options.expectedPreviousRunId && options.expectedPreviousRunId !== this.state?.runId) throw new Error('当前任务已变化，请刷新后再新建');
    if (this.state && this.state.phase !== 'finished' && !options.abandon) throw new Error('有未完成任务，请继续原任务，或确认放弃旧进度后新建');
    if (!['smoke', 'doubao-b','excel'].includes(options.datasetId)) throw new Error('请选择支持的流程或Excel测评集');
    const preview=options.datasetId==='excel'?await previewDatasetFile(options.excelPath):null;
    if(preview&&(!options.excelHash||preview.file.sha256!==options.excelHash))throw new Error('Excel在选择后发生变化，请重新校验并选择用于执行');
    const dataset = preview?compileExcelDataset(preview):loadDataset(options.datasetId);
    const executionPolicy = loadExecutionPolicy(this.root);
    const purpose = dataset.id === 'smoke' ? 'connectivity_test' : (options.purpose || 'formal_evaluation');
    if (dataset.id !== 'smoke' && !['formal_evaluation', 'technical_regression'].includes(purpose)) throw new Error('运行用途无效');
    if (purpose === 'formal_evaluation' && options.cleanDeclared !== true) throw new Error('正式流程开始前，请核验测试账号初始状态并勾选确认');
    if (purpose === 'technical_regression' && options.acknowledgeExistingMemory !== true) throw new Error('技术回归需确认沿用当前账号状态，不用于记忆能力评分');
    const connection = await this.check(options);
    if (connection.draft) throw new Error('豆包有未发送草稿，请先处理后开始');
    if (options.account && options.account.trim() !== connection.account) throw new Error('填写的账号与实际连接账号不一致，请重新检查连接');
    const runId = `${dataset.id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
    this.directory = resolve(this.dataDir, runId); mkdirSync(this.directory, { recursive: true });
    if(preview)freezeExcelDataset(this.directory,preview,dataset);else saveJSON(resolve(this.directory, 'scenario.json'), dataset.data);
    this.state = { schemaVersion: 1, runId, datasetId: dataset.id, purpose, datasetHash: dataset.fingerprint, executionPolicy,
      features: { renameConversations: true, captureReplies: true, autoGenerateResults: dataset.id !== 'smoke' }, renameJobs: {},
      account: connection.account, port: this.settings.port, createdAt: Date.now(),
      cleanStateDeclaredAt: purpose === 'formal_evaluation' && options.cleanDeclared ? Date.now() : null,
      status: 'paused', activity: '本轮已建立，准备开始', phase: 'navigation',
      stepIndex: 0, messageIndex: 0, transitionIndex: 0, preparedStepIndex: null,
      navigation: null, pending: null, wait: null, conversations: {}, completions: [], deviations: [] };
    if(preview){this.state.manualResults={};this.state.identityAccounts={[dataset.data.automatic_identity]:connection.account};}
    this.logs = []; this.save(); this.settings.lastRun = runId; saveJSON(this.settingsPath, this.settings);
    this.configureAutomaticResults();
    this.event('started', preview?`按所选Excel开始：${preview.file.name}，${dataset.automaticTotal}条自动、${dataset.manualTotal}条人工；用途：${purpose}`:dataset.id === 'smoke' ? '开始连通性测试：4条非测评消息' : purpose === 'technical_regression' ? '开始旧豆包B长流程技术回归：54条，沿用当前账号状态，不用于产品能力评分' : '开始旧豆包B固定流程：54条自动消息');
    this.execute();
  }
  execute() {
    const dataset = loadDataset(this.state.datasetId,this.directory);
    if (dataset.fingerprint !== this.state.datasetHash) throw new Error('本轮流程文件已改变，不能继续旧断点');
    this.state.executionPolicy ||= loadExecutionPolicy(this.root);
    this.active = true; this.requested = null; this.state.lastError = '';
    this.state.status = 'running';
    if (this.state.pending && !this.state.pending.replyToSave) { this.state.pending.candidate = null; this.state.pending.recovered = true; }
    this.adapter = new DoubaoAdapter(this.state.port); this.save();
    const archive = this.state.features?.captureReplies ? new ReplyArchive({directory:this.directory,runId:this.state.runId,
      datasetId:this.state.datasetId,datasetHash:this.state.datasetHash,account:this.state.account}) : null;
    const EngineClass=dataset.id==='excel'?ExcelEngine:Engine;
    const engine = new EngineClass({ dataset, adapter: this.adapter, state: this.state, ...this.state.executionPolicy,
      save: () => this.save(), event: (...args) => this.event(...args), request: () => this.requested,
      archiveReply: dataset.id==='excel'?excelArchive({directory:this.directory,state:this.state,dataset}):archive ? payload=>archive.save(payload) : null });
    this.task = (async () => {
      try { await engine.run(); }
      catch (error) {
        this.state.status = error instanceof Interrupted ? error.mode : error instanceof ReviewRequired ? 'needs_review' : 'error';
        this.state.activity = error.message; this.state.lastError = error instanceof Interrupted ? '' : error.message;
        this.event(error.name==='ManualStepRequired'?'manual_required':'interrupted', error.message, { type: error.name, code: error.code || null,
          observation: this.state.observation, recovery: this.state.recovery,
          userMessageId: this.state.pending?.userId || null, answerMessageId: this.state.pending?.answerId || null });
      } finally { this.adapter.close(); this.active = false; this.requested = null; this.save(); }
      await this.finishAutomaticResults();
    })();
  }
  async resume(options={}) {
    if (this.active) throw new Error('任务正在运行');
    if (this.resultTask || this.automaticResults?.running || this.previewTask) throw new Error('文件操作尚未完成，请稍后继续');
    if (!this.state || this.state.phase === 'finished') throw new Error('没有可继续的任务');
    if (options.expectedRunId && options.expectedRunId !== this.state.runId) throw new Error('当前任务已变化，请刷新后继续，不能恢复其他轮次');
    // Reconnection is handled by the engine; no preliminary navigation may overwrite
    // the pending message's page or cause a second new conversation.
    this.event('resumed', '继续原任务，先核对会话与上一条消息'); this.execute();
  }
  interrupt(mode, options={}) {
    if (!this.active) return;
    if (options.expectedRunId && options.expectedRunId !== this.state?.runId) throw new Error('当前任务已变化，不能暂停其他轮次');
    this.requested = mode; this.state.activity = mode === 'stopped' ? '正在停止并保存进度…' : '正在暂停并保存进度…';
  }
  async retryNotSent() {
    if (this.state?.pending?.deliveryFailure) throw new Error('豆包已显示原消息异常，请先在豆包处理原消息，再点击继续；不能从执行器重新发送。');
    if (this.active || this.state?.status !== 'needs_review' || !this.state.pending || this.state.pending.userId) throw new Error('当前状态不允许人工重试');
    const adapter = new DoubaoAdapter(this.state.port);
    try {
      const pending = this.state.pending;
      const info = await adapter.restore(pending, this.state.navigation);
      if (info) {
        await adapter.verifyAccount(this.state.account);
        if (findSent(info, pending)) throw new Error('已找到发送成功的消息，请直接点击继续，不要重试');
      }
      // For a new-conversation send with no receipt, require the original blank
      // page to be verifiable as well as the user's explicit acknowledgement.
      if (!pending.href) await adapter.restoreUnsent(this.state.navigation);
      const review = { stepId: pending.stepId, at: Date.now(), previousAttempt: pending.attemptedAt };
      this.state.deviations.push({ type: 'operator_confirmed_not_sent', ...review });
      this.event('operator_retry', '用户核对未发送，允许重新尝试当前消息', review);
      pending.attemptedAt = null; pending.confirmedAt = null; pending.candidate = null;
      this.state.status = 'paused'; this.save();
    } finally { adapter.close(); }
    return this.resume();
  }
  async shutdown() {
    this.interrupt('stopped');
    if (this.task) await this.task;
    if (this.automaticResults?.task) await this.automaticResults.task;
    if (this.resultTask) await this.resultTask.catch(() => {});
    if (this.previewTask) await this.previewTask.catch(() => {});
  }
  async exportLoaded(options={}, exporter=exportCurrentLoaded) {
    if (this.active) throw new Error('请先暂停并等待执行器停止发送，再导出已加载对话。');
    // This operation never changes run state, message pointers or sender events.
    return exporter({root:this.root,port:Number(options.port||this.settings.port),expectedAccount:options.account});
  }
  async previewDataset(options={}, previewer=previewDatasetFile) {
    if (this.active) throw new Error('请先暂停正在发送的任务，再校验预览测评集');
    if (this.previewTask || this.resultTask || this.automaticResults?.running) throw new Error('上一项文件操作尚未完成，请稍候');
    this.previewTask = Promise.resolve().then(() => previewer(options.filePath));
    try {
      const result=await this.previewTask;
      if(result.valid&&result.scope==='validation_and_preview_only'){
        try{compileExcelDataset(result);result.executionSupported=true;}
        catch(error){result.executionSupported=false;result.executionError=error.message;}
      }
      return result;
    }
    finally { this.previewTask = null; }
  }
  manualDetails(){
    if(this.active||this.state?.datasetId!=='excel')throw new Error('当前没有可处理的Excel人工步骤');
    return manualStepDetails(this.state,loadDataset('excel',this.directory));
  }
  async submitManual(options){
    if(this.active||this.state?.datasetId!=='excel'||this.resultTask||this.automaticResults?.running)throw new Error('请等待当前操作结束再保存人工结果');
    const dataset=loadDataset('excel',this.directory);
    const record=commitManualResult({directory:this.directory,state:this.state,dataset,options});this.save();
    this.event('manual_result_saved',`人工步骤${record.stepId}已记录为${record.status}；来源为人工录入`,{stepId:record.stepId,status:record.status});
    if(this.state.phase==='finished'){this.configureAutomaticResults();await this.finishAutomaticResults();}
    return {finished:this.state.phase==='finished',nextManual:manualStepDetails(this.state,dataset),automaticNext:dataset.data.steps[this.state.stepIndex]?.execution==='automatic',
      result:this.automaticResults?.record?.result||null};
  }
  configureAutomaticResults() {
    this.automaticResults = automaticResultsEnabled(this.state) && this.directory
      ? new AutomaticResults({ directory:this.directory, runId:this.state.runId,
        filename:this.state.datasetId==='excel'&&this.state.phase==='finished'&&Object.keys(this.state.manualResults||{}).length?'结果生成状态_全部步骤.json':'结果生成状态.json',onUpdate:record => {
        const label = record.status === 'running' ? (this.state.datasetId==='excel'?'本阶段已完成，正在生成双份结果表':'自动部分已完成，正在生成结果表；T17仍待人工执行')
          : record.status === 'succeeded' ? `${record.source === 'manual' ? '已手动补生成' : '已自动生成'}结果表：${record.result.file}${record.result.copyStatus==='failed'?'；原Excel目录副本未保存：'+record.result.copyError:''}${record.warning ? '；' + record.warning : ''}`
          : `自动部分已完成，结果表生成失败，可用按钮重试：${record.error}`;
        this.event('results_' + (record.source || 'automatic') + '_' + record.status, label,
          record.status === 'succeeded' ? record.result : { error:record.error || null });
      } }) : null;
  }
  async finishAutomaticResults(worker=runResultWorker) {
    const s = this.state;
    if(!automaticResultsEnabled(s))return;
    const dataset=loadDataset(s.datasetId,this.directory);
    if(s.datasetId==='excel'){
      if(!['manual','finished'].includes(s.phase)||s.completions.length!==dataset.automaticTotal)return;
      if(s.phase==='finished'&&Object.keys(s.manualResults||{}).length&&!this.automaticResults?.file.endsWith('结果生成状态_全部步骤.json'))this.configureAutomaticResults();
    }else if(s.phase!=='finished'||!['completed','awaiting_manual'].includes(s.status))return;
    this.automaticResults ||= new AutomaticResults({ directory:this.directory, runId:s.runId });
    return this.automaticResults.runOnce(async () => {
      if (s.pending || s.completions.length !== (dataset.id==='excel'?dataset.automaticTotal:dataset.total)
        || s.completions.some(x => x.replyArchive?.status !== 'saved')) throw new Error('自动部分的完整回复尚未全部保存，请核对本地记录后用按钮生成');
      // A manual snapshot may still be writing when the sender finishes. Wait
      // for it, then produce the final snapshot using the same verified writer.
      if (this.resultTask) await this.resultTask.catch(() => {});
      return this.generateResults(dataset.id==='excel'&&worker===runResultWorker?runExcelResultWorker:worker, { automatic:true });
    });
  }
  async generateResults(worker=runResultWorker, { automatic=false }={}) {
    if (!automatic && this.automaticResults?.running) throw new Error('正在自动生成结果表，请稍候');
    if (this.resultTask) throw new Error('正在生成结果表，请稍候');
    if (!this.state || !this.directory) throw new Error('当前没有可回填的运行记录');
    const isExcel=this.state.datasetId==='excel';
    const input = isExcel?collectExcelResultInput({directory:this.directory,state:this.state}):collectResultInput({ root:this.root, directory:this.directory, state:this.state });
    this.resultTask = Promise.resolve().then(() => isExcel?generateExcelResults(input,worker===runResultWorker?runExcelResultWorker:worker):worker(input));
    try {
      const generated = await this.resultTask;
      const result = recordRunResult({directory:this.directory,state:this.state,result:generated});
      if (!automatic && automaticResultsEnabled(this.state) && this.state.phase === 'finished'
        && (isExcel?input.records.length===input.run.totalRows:input.turns.length===input.run.totalAutomatic)) this.automaticResults?.recoveredManually(result);
      return result;
    }
    finally { this.resultTask = null; }
  }
}

export async function serve({ port = 0, token = process.env.DOUBAO_RUNNER_TOKEN, root = ROOT } = {}) {
  if (!token || token.length < 24) throw new Error('缺少本地窗口连接凭证，请使用启动程序');
  const release = lockDirectory(resolve(root, '运行数据'));
  let controller;
  try { controller = new Controller(root); } catch (error) { release(); throw error; }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const reply = (code, value) => { response.writeHead(code); response.end(JSON.stringify(value)); };
    if (request.headers.authorization !== `Bearer ${token}`) return reply(403, { error: '本地连接未授权' });
    if (request.method === 'GET' && request.url === '/status') {
      try { return reply(200, controller.status()); } catch (error) { return reply(500, { error: error.message }); }
    }
    if (request.method !== 'POST') return reply(404, { error: '未知操作' });
    try {
      let text = '';
      request.setEncoding('utf8');
      for await (const chunk of request) { text += chunk; if (text.length > (request.url==='/manual-submit'?250000:16000)) throw new Error('请求内容过长'); }
      const data = text ? JSON.parse(text) : {};
      if (request.url === '/pause') { controller.interrupt('paused', data); return reply(200, { ok: true }); }
      if (request.url === '/stop') { controller.interrupt('stopped'); return reply(200, { ok: true }); }
      if (request.url === '/shutdown') {
        await controller.shutdown(); reply(200, { ok: true }); server.close(); return;
      }
      if (controller.busy || controller.automaticResults?.running) throw new Error('上一项操作尚未完成，请稍候');
      controller.busy = true;
      try {
        let result;
        if (request.url === '/check') result = await controller.check(data);
        else if (request.url === '/launch') result = await controller.launch(data);
        else if (request.url === '/start') await controller.start(data);
        else if (request.url === '/resume') await controller.resume(data);
        else if (request.url === '/retry-not-sent') await controller.retryNotSent();
        else if (request.url === '/export-current') result = await controller.exportLoaded(data);
        else if (request.url === '/generate-results') result = await controller.generateResults();
        else if (request.url === '/preview-dataset') result = await controller.previewDataset(data);
        else if (request.url === '/manual-details') result = controller.manualDetails();
        else if (request.url === '/manual-submit') result = await controller.submitManual(data);
        else throw new Error('未知操作');
        reply(200, { ok: true, result });
      } finally { controller.busy = false; }
    } catch (error) { reply(409, { error: error.message }); }
  });
  server.once('close', release);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const shutdown = async () => { await controller.shutdown(); server.close(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  const parentPid = Number(process.env.DOUBAO_PARENT_PID);
  if (Number.isInteger(parentPid) && parentPid > 0) {
    const watchdog = setInterval(() => {
      try { process.kill(parentPid, 0); } catch (error) { if (error.code === 'ESRCH') { clearInterval(watchdog); shutdown(); } }
    }, 3000);
    watchdog.unref(); server.once('close', () => clearInterval(watchdog));
  }
  return { server, controller, port: server.address().port };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve().then(({ port }) => process.stdout.write(JSON.stringify({ port, version: '1.8.0' }) + '\n'))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
