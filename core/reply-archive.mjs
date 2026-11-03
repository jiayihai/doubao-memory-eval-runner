import { mkdirSync, readdirSync, existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { saveJSON, hash } from './store.mjs';

function filePart(value, label) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_.-]{1,80}$/u.test(value)
    || value === '.' || value === '..' || /\.$/.test(value) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)) {
    throw new Error(`${label}不能安全用作备份文件名`);
  }
  return value;
}
function writeTextAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = file + '.tmp', fd = openSync(temporary, 'w');
  try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, file);
}
function fenced(text) {
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g)||[]).map(x=>x.length+1)));
  return `${fence}text\n${text}\n${fence}`;
}
function canonicalTurn(payload, context) {
  const c = payload.completion;
  filePart(c.stepId, '步骤ID'); filePart(c.target, '会话ID');
  if (c.target === '_备份索引') throw new Error('会话ID与备份索引文件名冲突');
  if (!Number.isSafeInteger(c.messageIndex) || c.messageIndex < 0 || c.key !== `${c.stepId}:${c.messageIndex}`
    || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 || !/^\/chat\/\d+$/.test(c.href)
    || typeof c.userMessageId !== 'string' || !c.userMessageId || typeof c.answerMessageId !== 'string' || !c.answerMessageId
    || !Number.isFinite(c.answerCompletionObservedAt) || typeof payload.prompt !== 'string' || typeof payload.answer !== 'string'
    || hash(payload.prompt) !== c.promptHash || hash(payload.answer) !== c.answerHash) {
    throw new Error('待保存问答的步骤、消息编号或正文哈希不一致');
  }
  return { schemaVersion: 1, scope: 'this_run_script_turn', ...context,
    sequence: payload.sequence, key: c.key, stepId: c.stepId, messageIndex: c.messageIndex,
    conversationId: c.target, href: c.href, userMessageId: c.userMessageId, answerMessageId: c.answerMessageId,
    prompt: payload.prompt, answer: payload.answer, promptHash: c.promptHash, answerHash: c.answerHash,
    sendAttemptedAt: c.sendAttemptedAt, sendConfirmedAt: c.sendConfirmedAt,
    answerCompletionObservedAt: c.answerCompletionObservedAt, completionBasis: c.completionBasis,
    completionTimeUncertain: !!c.completionTimeUncertain, recovered: !!c.recovered, sourceKind: payload.sourceKind || null,
    questionId: null };
}

export class ReplyArchive {
  constructor({ directory, runId, datasetId, datasetHash, account, writeJSON = saveJSON, writeText = writeTextAtomic }) {
    if (!directory || !runId || !datasetId || !datasetHash || !account) throw new Error('缺少本轮回复归档身份信息');
    this.directory = resolve(directory);
    this.turnDirectory = resolve(this.directory, '回复记录');
    this.conversationDirectory = resolve(this.directory, '会话备份');
    this.context = { runId, datasetId, datasetHash, account };
    this.writeJSON = writeJSON; this.writeText = writeText;
  }
  save(payload) {
    const turn = canonicalTurn(payload, this.context);
    const basename = `${turn.stepId}_${String(turn.messageIndex+1).padStart(3,'0')}.json`;
    const file = resolve(this.turnDirectory, basename);
    if (dirname(file) !== this.turnDirectory) throw new Error('回复路径超出本轮目录');
    mkdirSync(this.turnDirectory, { recursive: true });
    const alreadySaved = existsSync(file);
    if (alreadySaved) {
      if (JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))) !== JSON.stringify(turn)) {
        throw new Error(`步骤${turn.key}已有不同问答，禁止覆盖或重发，请核对本地记录`);
      }
    }

    // Canonical records are independent of the rendered page and can rebuild
    // either backup after a crash. Never query/scroll the UI to finish saving.
    const all = readdirSync(this.turnDirectory).filter(name=>/\.json$/.test(name)).map(name=>JSON.parse(readFileSync(resolve(this.turnDirectory,name),'utf8')));
    if (!alreadySaved) all.push(turn);
    const keys = new Set(), sequences = new Set(), userIds = new Set(), answerIds = new Set(), targets = new Map();
    for (const item of all) {
      if (item.runId !== this.context.runId || item.datasetId !== this.context.datasetId || item.datasetHash !== this.context.datasetHash || item.account !== this.context.account
        || keys.has(item.key) || sequences.has(item.sequence) || userIds.has(item.userMessageId) || answerIds.has(item.answerMessageId)
        || hash(item.prompt) !== item.promptHash || hash(item.answer) !== item.answerHash) throw new Error('本轮回复记录混入其他来源、重复记录或正文已改变');
      filePart(item.conversationId, '会话ID');
      if (targets.has(item.conversationId) && targets.get(item.conversationId) !== item.href) throw new Error('同一会话编号对应了不同实际地址');
      targets.set(item.conversationId,item.href); keys.add(item.key); sequences.add(item.sequence); userIds.add(item.userMessageId); answerIds.add(item.answerMessageId);
    }
    if (!alreadySaved) this.writeJSON(file, turn);
    all.sort((a,b)=>a.sequence-b.sequence);
    const turns = all.filter(item=>item.conversationId === turn.conversationId);
    const messages = turns.flatMap((item,index)=>[
      { sequence:index*2+1, role:'user', stepId:item.stepId, messageIndex:item.messageIndex, messageId:item.userMessageId, text:item.prompt, sendAttemptedAt:item.sendAttemptedAt },
      { sequence:index*2+2, role:'assistant', stepId:item.stepId, messageIndex:item.messageIndex, messageId:item.answerMessageId, text:item.answer,
        answerCompletionObservedAt:item.answerCompletionObservedAt, completionTimeUncertain:item.completionTimeUncertain }
    ]);
    const jsonFile = resolve(this.conversationDirectory,turn.conversationId+'.json');
    const mdFile = resolve(this.conversationDirectory,turn.conversationId+'.md');
    if (dirname(jsonFile)!==this.conversationDirectory || dirname(mdFile)!==this.conversationDirectory) throw new Error('会话备份路径无效');
    const backup = { schemaVersion:1, scope:'this_run_script_messages', ...this.context,
      conversationId:turn.conversationId, href:turn.href, counts:{turns:turns.length,messages:messages.length},
      historyCompleteness:'only_captured_script_turns',
      note:'仅含本轮脚本已采集问答，不包含运行前历史、未采集的人工消息或未执行步骤；不是平台全部聊天历史。', messages };
    this.writeJSON(jsonFile, backup);
    const lines = [`# ${turn.conversationId}`,'',`运行：${turn.runId}`,`实际会话：${turn.href}`,`已保存：${turns.length}组问答（${messages.length}条消息）`,'',backup.note,'',
      '时间字段为本机操作或观察时间，不是平台原始消息时间；本版保存已读取的正文文字。',''];
    for (const item of turns) lines.push(`## ${item.stepId} 第${item.messageIndex+1}条`,'',`回答结束观察时间（UTC）：${new Date(item.answerCompletionObservedAt).toISOString()}`,'',
      `### 用户（${item.userMessageId}）`,'',fenced(item.prompt),'',`### 豆包（${item.answerMessageId}）`,'',fenced(item.answer),'');
    this.writeText(mdFile,lines.join('\n'));
    this.writeJSON(resolve(this.conversationDirectory,'_备份索引.json'),{
      schemaVersion:1,...this.context,scope:'this_run_script_messages',savedTurns:all.length,conversationCount:targets.size,
      conversations:[...targets].map(([id,href])=>({id,href,turns:all.filter(t=>t.conversationId===id).length,json:id+'.json',markdown:id+'.md'}))
    });
    return { status:'saved', replyFile:'回复记录/'+basename, conversationJson:'会话备份/'+turn.conversationId+'.json',
      conversationMarkdown:'会话备份/'+turn.conversationId+'.md',conversationTurns:turns.length };
  }
}
