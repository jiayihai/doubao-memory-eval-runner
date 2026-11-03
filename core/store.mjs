import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = text => createHash('sha256').update(text).digest('hex');
export const normalize = text => String(text ?? '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
// Doubao reformats displayed dates and paragraph spacing. Use this only for
// rendered-message checks; editor verification and source hashes stay exact.
export const renderedKey = text => normalize(text).replace(/\s+/gu, '');
export function saveJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, 'w');
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
}
export function loadJSON(path, fallback = null) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}
export function lockDirectory(directory) {
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, 'runner.lock');
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); fsyncSync(fd); }
      finally { closeSync(fd); }
      return () => {
        if (loadJSON(path)?.nonce === nonce) unlinkSync(path);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = loadJSON(path);
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0) throw new Error('运行锁损坏，请先确认没有其他执行器，再移除运行数据/runner.lock');
      try { process.kill(owner.pid, 0); }
      catch (probe) {
        if (probe.code !== 'ESRCH') throw new Error('无法核实另一个执行器是否已退出');
        unlinkSync(path); continue;
      }
      throw new Error('执行器已经运行，请使用已打开的窗口，不能同时启动两份');
    }
  }
  throw new Error('未能取得运行锁');
}

export class ReviewRequired extends Error {
  constructor(message, code = 'review_required') { super(message); this.name = 'ReviewRequired'; this.code = code; }
}
export class PageNotReady extends Error {
  constructor(message, code = 'page_loading') { super(message); this.name = 'PageNotReady'; this.code = code; }
}
export class Interrupted extends Error {
  constructor(mode) { super(mode === 'stopped' ? '已停止，进度已保存' : '已暂停，进度已保存'); this.name = 'Interrupted'; this.mode = mode; }
}
export function findSent(snapshot, pending) {
  if (pending.href && new URL(snapshot.url).pathname !== pending.href) throw new ReviewRequired('当前会话地址与断点不一致，请打开原会话后继续。');
  let offset = 0;
  if (pending.beforeSentId) {
    const index = snapshot.sent.findIndex(x => x.id === pending.beforeSentId);
    if (index < 0) {
      // Virtualized chat history may unmount the previous user message. Only
      // allow the fallback with a durable, complete list of this run's prior IDs.
      if (pending.attemptedAt == null || !pending.knownSentIds?.includes(pending.beforeSentId)) {
        throw new ReviewRequired('当前页面未显示发送前的消息位置。请打开原会话并滚动到底部，再继续。');
      }
      const unknown = snapshot.sent.filter(x => !x.id || !pending.knownSentIds.includes(x.id));
      if (!unknown.length) return null;
      if (unknown.length !== 1 || snapshot.sent.at(-1) !== unknown[0]) throw new ReviewRequired('原会话出现了额外输入或消息顺序不一致，请核对后再继续。');
      if (pending.userId && unknown[0].id !== pending.userId) throw new ReviewRequired('已确认的用户消息编号发生变化，请核对。');
      if (renderedKey(unknown[0].text) !== renderedKey(pending.text)) throw new ReviewRequired('原会话最新消息与待确认文字不一致，请核对后再继续。');
      return unknown[0];
    }
    offset = index + 1;
  }
  const newMessages = snapshot.sent.slice(offset);
  if (!newMessages.length) return null;
  if (newMessages.length !== 1 || renderedKey(newMessages[0].text) !== renderedKey(pending.text)) {
    throw new ReviewRequired('原会话出现了额外输入或消息文字不一致，请核对后再继续。');
  }
  // A freshly rendered optimistic message may not have its server ID yet. Keep
  // it visible as an observed send, but let the engine wait for the durable ID.
  return newMessages[0];
}
export function findAnswer(snapshot, userId, history = null) {
  const index = snapshot.ordered.findIndex(x => x.role === 'user' && x.id === userId);
  if (index < 0) {
    if (!history) throw new ReviewRequired('找不到刚发送的消息，请打开对应会话并滚动到底部。');
    const knownUsers = new Set([...(history.knownSentIds || []), userId]);
    if (snapshot.sent.some(x => x.id && !knownUsers.has(x.id))) throw new ReviewRequired('检测到额外用户消息，已暂停，避免执行位置错乱。', 'extra_user_message');
    const answers = snapshot.received.filter(x => !history.knownAnswerIds?.includes(x.id));
    if (answers.length > 1) throw new ReviewRequired('发现多个候选回答，请核对后继续。', 'multiple_answers');
    if (history.answerId && answers[0]?.id && answers[0].id !== history.answerId) throw new ReviewRequired('已记录的回答编号发生变化，请核对。', 'answer_changed');
    return answers[0] || null;
  }
  const tail = snapshot.ordered.slice(index + 1);
  if (tail.some(x => x.role === 'user')) throw new ReviewRequired('检测到额外用户消息，已暂停，避免执行位置错乱。');
  const answers = tail.filter(x => x.role === 'assistant');
  if (answers.length > 1) throw new ReviewRequired('发现多个候选回答，已暂停，请保留首次回答并核对。');
  return answers[0] || null;
}
