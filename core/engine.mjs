import { ConnectionError, sleep } from '../adapters/cdp.mjs';
import { normalize, renderedKey, hash, findSent, findAnswer, ReviewRequired, PageNotReady, Interrupted } from './store.mjs';
import { summarize, replyState, submissionState, pendingUser, messageFailure } from './observation.mjs';
import { queueConversationName, RenameError } from './naming.mjs';

export const TIMING_POLICY = Object.freeze({ id: 'reply_then_30s_v1', replyGapMs: 30000, overridesSourceWaits: true });

export class Engine {
  constructor({ dataset, adapter, state, save, event, clock = Date.now, delay = sleep,
    request = () => null, reconnectMs = null, recoveryMs = 90000, confirmMs = 90000, responseMs = 600000, archiveReply = null }) {
    Object.assign(this, { dataset, adapter, state, save, event, clock, delay, request, confirmMs, responseMs, archiveReply });
    this.recoveryMs = Math.min(recoveryMs, reconnectMs ?? Infinity);
    this.deadlines = new Map(); this.recovery = null; this.activeDeadline = null;
    this.lastReportAt = -Infinity; this.lastProbeAt = clock(); this.progressSignature = null;
    this.renameAttempts = new Map();
  }
  persist() { this.state.updatedAt = this.clock(); this.save(this.state); }
  checkpoint() { const mode = this.request(); if (mode) throw new Interrupted(mode); }
  async pauseableDelay(ms) {
    const deadline = this.clock() + ms;
    while (this.clock() < deadline) { this.checkpoint(); await this.delay(Math.min(500, deadline - this.clock())); }
  }
  budget(kind, ms) {
    const key = `${this.state.stepIndex}:${this.state.messageIndex}:${kind}`;
    if (!this.deadlines.has(key)) this.deadlines.set(key, this.clock() + ms);
    return this.deadlines.get(key);
  }
  report(stage, label, snapshot = null, deadline = null) {
    const state = this.state, now = this.clock(), previous = state.observation;
    const changed = previous?.stage !== stage || previous?.label !== label;
    state.activity = label;
    state.observation = { stage, label, since: changed ? now : previous.since, deadline,
      observedAt: now, page: snapshot ? summarize(snapshot) : this.latestPage || previous?.page || null };
    if (changed || now - this.lastReportAt >= 5000) {
      this.persist(); this.lastReportAt = now;
      if (changed) this.event('observation', label, state.observation);
    }
  }
  recoverySucceeded() {
    if (!this.recovery) return;
    this.event('recovered', '页面状态已恢复，继续当前步骤，不重复发送', { elapsedMs: this.clock() - this.recovery.startedAt });
    this.recovery = null; this.state.recovery = null; this.state.status = 'running';
  }
  async recover(error) {
    this.checkpoint();
    const now = this.clock();
    this.recovery ||= { startedAt: now, attempts: 0, lastProbeAt: -Infinity, lastLogAt: -Infinity, lastCode: null };
    const episode = this.recovery;
    const deadline = Math.min(episode.startedAt + this.recoveryMs, this.activeDeadline ?? Infinity);
    const code = error.code || 'connection_lost';
    if (this.state.pending) {
      this.state.pending.recovered = true; this.state.pending.timingUncertain = true; this.state.pending.candidate = null;
    }
    if (now >= deadline) {
      const prefix = this.state.pending?.userId ? '消息已发送，回答状态仍无法可靠读取' : this.state.pending?.attemptedAt != null ? '当前消息是否发送仍无法确认' : '会话页面仍未准备好';
      throw new ReviewRequired(`${prefix}：${error.message}。自动恢复已达上限，请检查豆包后点击继续。`, code);
    }
    if (error instanceof ConnectionError) this.adapter.close();
    this.state.status = error instanceof ConnectionError ? 'reconnecting' : 'recovering';
    this.state.recovery = { startedAt: episode.startedAt, deadline, attempts: ++episode.attempts, reason: error.message, code };
    this.report('recovering', `${this.state.pending?.userId ? '消息已发送，正在恢复回答读取' : '正在恢复页面状态'}：${error.message}`, null, deadline);
    if (episode.lastCode !== code || now - episode.lastLogAt >= 10000) {
      this.event(error instanceof ConnectionError ? 'reconnecting' : 'recovering', error.message,
        { ...this.state.recovery, page: this.state.observation?.page });
      episode.lastCode = code; episode.lastLogAt = now;
    }
    if (!(error instanceof ConnectionError) && this.adapter.recover && now - episode.lastProbeAt >= 5000 && this.state.pending) {
      episode.lastProbeAt = now;
      try { await this.adapter.recover(this.state.pending, this.state.navigation); }
      catch (probeError) {
        if (probeError instanceof ConnectionError) this.adapter.close();
        else if (!(probeError instanceof PageNotReady)) throw probeError;
      }
    }
    await this.pauseableDelay(Math.min(1000 * 2 ** Math.min(episode.attempts - 1, 3), 5000, Math.max(0, deadline - this.clock())));
  }
  async run() {
    this.checkpoint(); this.initializeTiming();
    if (this.state.pending?.attemptedAt != null && !this.state.pending.replyToSave) {
      this.state.pending.recovered = true; this.state.pending.timingUncertain = true; this.state.pending.candidate = null;
    }
    while (this.state.phase !== 'finished') {
      this.checkpoint();
      try { await this.tick(); }
      catch (error) {
        if (!(error instanceof ConnectionError) && !(error instanceof PageNotReady)) throw error;
        await this.recover(error);
      }
    }
  }
  initializeTiming() {
    const state = this.state;
    state.intervals ||= [];
    if (state.timingPolicy?.id === TIMING_POLICY.id) return;
    if (state.timingPolicy) throw new Error('断点使用了其他计时规则，不能直接继续');
    state.timingPolicy = { ...TIMING_POLICY };
    const last = state.completions.at(-1), step = this.dataset.data.steps[state.stepIndex];
    if (last && !state.pending && step && step.execution !== 'manual' && state.phase !== 'finished') {
      if (state.messageIndex < step.messages.length || this.hasLaterAutomaticMessage()) {
        const nextPhase = state.phase === 'gap' ? (state.messageIndex < step.messages.length ? 'messages' : 'transitions') : state.phase;
        state.phase = 'gap'; state.wait = this.replyWait(last.answerCompletionObservedAt, nextPhase);
      } else state.wait = null;
      state.deviations.push({ type: 'timing_policy_changed', at: this.clock(), timingPolicy: TIMING_POLICY.id });
    }
    this.persist(); this.event('timing_policy', '测评间隔：确认回答结束后等待30秒，再准备下一条', TIMING_POLICY);
  }
  hasLaterAutomaticMessage() {
    return this.dataset.data.steps.slice(this.state.stepIndex + 1).some(x => x.execution !== 'manual' && x.messages?.length);
  }
  replyWait(startedAt, nextPhase) {
    const gapMs = this.state.timingPolicy.replyGapMs;
    if (!Number.isSafeInteger(gapMs) || gapMs < 0) throw new Error('测评间隔设置无效');
    return { startedAt, deadline: startedAt + gapMs, gapMs, label: `回答已完成，测评间隔${gapMs / 1000}秒`, nextPhase };
  }
  async navigate(index) {
    this.checkpoint(); this.activeDeadline = null;
    const state = this.state, step = this.dataset.data.steps[index];
    this.report('preparing', `准备会话：${step.target}`);
    if (step.navigation === 'new') {
      if (state.navigationAttempt?.stepIndex === index) {
        if (!this.adapter.recoverNew) throw new ReviewRequired('新建会话结果待确认，请打开本轮空白会话后继续。');
        state.navigation = await this.adapter.recoverNew(state.navigationAttempt, state.account);
      } else {
        state.navigation = await this.adapter.prepareNew(state.account, { onIntent: intent => {
          state.navigationAttempt = { ...intent, stepIndex: index, attemptedAt: this.clock() }; this.persist();
        } });
      }
      state.navigationAttempt = null;
    } else {
      const known = state.conversations[step.target];
      if (!known) throw new Error(`未保存 ${step.target} 的会话地址，不能猜测目标会话。`);
      const info = await this.adapter.openKnown(known.href);
      await this.adapter.verifyAccount(state.account, info);
      if (this.adapter.navigationEvidence) this.event('conversation_opened', '已定位原会话，保留当前页面实例', this.adapter.navigationEvidence);
      state.navigation = { href: known.href, beforeHrefs: [], targetId: known.targetId };
    }
    this.recoverySucceeded();
  }
  async waitForDeadline(wait) {
    this.report('gap', wait.label, null, wait.deadline);
    await this.pauseableDelay(Math.max(0, wait.deadline - this.clock()));
  }
  recordInterval(pending, now) {
    const state = this.state, previous = state.completions.at(-1);
    if (!previous || pending.intervalRecorded) return;
    const plannedGapMs = previous.plannedGapMs ?? state.timingPolicy.replyGapMs;
    const earliestSendAt = previous.nextAllowedAt ?? previous.answerCompletionObservedAt + plannedGapMs;
    if (now < earliestSendAt) throw new Error('尚未达到测评间隔截止时间，未发送');
    const record = { previousKey: previous.key, nextKey: `${pending.stepId}:${pending.messageIndex}`,
      answerCompletionObservedAt: previous.answerCompletionObservedAt, plannedGapMs, earliestSendAt,
      sendAttemptedAt: now, actualGapMs: now - previous.answerCompletionObservedAt,
      additionalMs: now - earliestSendAt, completionTimeUncertain: !!previous.completionTimeUncertain };
    state.intervals.push(record); pending.intervalRecorded = true;
    if (record.additionalMs > 2000) {
      state.deviations.push({ type: 'interval_extended', ...record });
      this.event('timing_deviation', '实际发送间隔超过计划，已记录额外耗时', record);
    }
    this.event('message_interval', '已记录计划间隔与实际发送间隔', record);
  }
  async tick() {
    const state = this.state, step = this.dataset.data.steps[state.stepIndex];
    state.status = 'running';
    if (await this.processRename()) return;
    if (!step || step.execution === 'manual') {
      state.phase = 'finished'; state.status = step ? 'awaiting_manual' : 'completed';
      state.activity = step ? `自动部分已完成；${step.target} 按原计划人工执行` : '本轮自动执行完成';
      if (!step && this.dataset.id === 'smoke') {
        const passed = state.completions.length === this.dataset.total && state.completions.every(x => x.replyMatched === true);
        state.status = passed ? 'completed' : 'check_failed';
        state.activity = passed ? '连通性测试通过：4/4 条，回复标记全部匹配' : '发送流程结束：4/4 条，请核对未匹配的回复标记';
      }
      state.observation = null; state.recovery = null; state.finishedAt = this.clock();
      this.persist(); this.event('finished', state.activity); return;
    }
    if (state.phase === 'navigation') {
      if (state.preparedStepIndex === state.stepIndex) state.preparedStepIndex = null;
      else await this.navigate(state.stepIndex);
      state.phase = 'messages'; this.persist(); return;
    }
    if (state.phase === 'messages') return this.message(step);
    if (state.phase === 'gap') {
      await this.waitForDeadline(state.wait);
      state.phase = state.wait.nextPhase || (state.messageIndex < step.messages.length ? 'messages' : 'transitions');
      state.wait = null; this.persist(); return;
    }
    if (state.phase !== 'transitions') throw new Error('无法识别保存的执行阶段');
    const action = step.transition_actions[state.transitionIndex];
    if (!action) {
      state.stepIndex++; state.messageIndex = 0; state.transitionIndex = 0; state.phase = 'navigation'; this.persist(); return;
    }
    if (action.action === 'wait') state.wait = null;
    else { await this.navigate(state.stepIndex + 1); state.preparedStepIndex = state.stepIndex + 1; }
    state.transitionIndex++; this.persist();
  }
  async processRename() {
    if (!this.state.features?.renameConversations) return false;
    const job = Object.values(this.state.renameJobs || {}).find(x => x.status === 'pending' || x.status === 'in_progress');
    if (!job) return false;
    this.checkpoint(); this.activeDeadline = null;
    const attempt = (this.renameAttempts.get(job.id) || 0) + 1; this.renameAttempts.set(job.id, attempt);
    job.status = 'in_progress'; job.attempts++; this.persist();
    this.report('renaming', `正在将新会话命名为 ${job.desiredName}，消息进度已保存`);
    try {
      if (!this.adapter.renameConversation) throw new RenameError('当前产品适配尚未提供重命名操作', true);
      const result = await this.adapter.renameConversation(job, this.state.account,
        { checkpoint: () => this.checkpoint(), onCheckpoint: () => this.persist() });
      job.status = 'done'; job.verifiedAt = this.clock(); job.result = result; job.lastError = '';
      this.persist(); this.event('conversation_renamed', `已核对对话名称：${job.desiredName}`, { target: job.target, href: job.href, ...result });
    } catch (error) {
      job.lastError = error.message; this.persist();
      if (error instanceof Interrupted || error instanceof ReviewRequired) throw error;
      if (!(error instanceof RenameError) || !error.safeToContinue) {
        throw new ReviewRequired(`对话改名未能安全结束：${error.message}。消息完成记录已保存，请检查界面后点击继续。`, 'rename_ui_unresolved');
      }
      job.status = attempt < 2 ? 'pending' : 'failed';
      this.persist(); this.event(job.status === 'failed' ? 'rename_failed' : 'rename_retry',
        job.status === 'failed' ? `未能确认 ${job.desiredName} 改名，已退出编辑界面，继续测评` : `改名暂未完成，将核对后再试：${job.desiredName}`,
        { target: job.target, href: job.href, attempts: job.attempts, reason: error.message });
      if (job.status === 'pending') await this.pauseableDelay(500);
    }
    return true;
  }
  async probeIfStalled(snapshot, pending) {
    const signature = JSON.stringify([snapshot?.sent.at(-1)?.id, snapshot?.received.at(-1)?.id,
      hash(snapshot?.received.at(-1)?.text || ''), hash(normalize(snapshot?.inputText)), !!snapshot?.busy, !!snapshot?.thinking]);
    if (signature !== this.progressSignature) { this.progressSignature = signature; this.lastProbeAt = this.clock(); return; }
    if (this.clock() - this.lastProbeAt < 30000 || snapshot?.busy || snapshot?.thinking) return;
    this.lastProbeAt = this.clock(); pending.timingUncertain = true;
    this.event('recovery_probe', '页面长时间无新状态，重新读取并定位当前会话，不重新发送', { page: summarize(snapshot), userId: pending.userId });
    if (this.adapter.recover) await this.adapter.recover(pending, this.state.navigation);
  }
  checkPlatformFailure(snapshot, pending, answer = null) {
    const failure = messageFailure(snapshot, pending, answer);
    if (failure) {
      const code = failure.direction === 'send' ? 'platform_send_failed' : 'platform_reply_failed';
      pending.deliveryFailure = { ...failure, detectedAt: this.clock() };
      this.report('platform_failure', `豆包显示${failure.direction === 'send' ? '发送' : '回答'}异常标志（红色感叹号），请处理原消息后点击继续`, snapshot);
      this.persist(); this.event('platform_failure', this.state.activity, { ...pending.deliveryFailure, stepId: pending.stepId, page: summarize(snapshot) });
      throw new ReviewRequired(`${this.state.activity}；工具不会自动重发或点击平台重试按钮。`, code);
    }
    if (pending.deliveryFailure) {
      const message = pending.deliveryFailure.direction === 'send' ? pendingUser(snapshot, pending) : answer;
      if (message && !message.failed && (pending.deliveryFailure.direction === 'reply' || snapshot.matchedConversation !== false)) {
        delete pending.deliveryFailure; this.persist(); this.event('platform_failure_cleared', '已重新核对原消息，异常标志消失，继续原断点');
      }
    }
  }
  async message(step) {
    const state = this.state, text = step.messages[state.messageIndex]?.send_text;
    if (!text) throw new Error('断点指向不存在的消息');
    let pending = state.pending;
    if (pending?.replyToSave) {
      if (!state.features?.captureReplies) throw new ReviewRequired('本断点有待保存正文，请使用已开启回复采集的版本继续。', 'reply_archive_disabled');
      if (pending.stepId !== step.id || pending.messageIndex !== state.messageIndex || pending.textHash !== hash(text)) throw new ReviewRequired('待保存步骤与冻结流程不一致，不能继续或重发。','reply_archive_mismatch');
      this.checkpoint(); this.complete(step, pending); return;
    }
    if (!pending) {
      this.activeDeadline = null;
      this.report('preparing', `准备发送：${step.target} 第${state.messageIndex + 1}条`);
      const known = state.conversations[step.target];
      const before = known ? await this.adapter.openKnown(known.href) : await this.adapter.restoreUnsent(state.navigation);
      this.latestPage = summarize(before);
      await this.adapter.verifyAccount(state.account, before);
      const prior = known ? state.completions.filter(x => x.href === known.href) : [];
      const ids = prior.map(x => x.userMessageId), expectedLastId = ids.at(-1) || null;
      if (expectedLastId && before.sent.at(-1)?.id !== expectedLastId) {
        const otherKnownIds = state.completions.filter(x => x.href !== known.href).map(x => x.userMessageId);
        if (before.sent.some(x => x.id && !ids.includes(x.id) && !otherKnownIds.includes(x.id))) throw new ReviewRequired('原会话出现额外用户消息，请核对。', 'extra_user_message');
        if (before.sent.some(x => otherKnownIds.includes(x.id))) throw new PageNotReady('地址已切换，目标会话内容仍在加载，当前条尚未发送', 'conversation_content_loading');
        throw new PageNotReady('最近一条已完成消息尚未加载，当前条尚未发送', 'latest_message_loading');
      }
      const beforeSentId = expectedLastId || before.sent.at(-1)?.id || null;
      if (before.sent.length && !beforeSentId) throw new PageNotReady('发送前的消息编号尚未加载', 'message_id_loading');
      if (before.busy || before.thinking || before.received.at(-1)?.streaming) throw new PageNotReady('原会话仍在生成回答，继续等待', 'previous_reply_busy');
      pending = state.pending = { stepId: step.id, messageIndex: state.messageIndex, text, textHash: hash(text),
        beforeSentId, knownSentIds: ids, knownAnswerIds: prior.map(x => x.answerMessageId),
        beforeHrefs: [...new Set([...(state.navigation.beforeHrefs || []), ...Object.values(state.conversations).map(x => x.href)])], href: known?.href || null,
        attemptedAt: null, confirmedAt: null, userId: null, answerId: null, candidate: null, recovered: false };
      this.recoverySucceeded(); this.persist();
    }
    if (pending.stepId !== step.id || pending.messageIndex !== state.messageIndex || pending.textHash !== hash(text)) throw new Error('断点与冻结流程不一致，已停止');
    if (pending.href) {
      const prior = state.completions.filter(x => x.href === pending.href), ids = prior.map(x => x.userMessageId);
      if (!pending.knownSentIds && ids.includes(pending.beforeSentId)) {
        const previousId = pending.beforeSentId;
        pending.beforeSentId = ids.at(-1); pending.knownSentIds = ids; this.persist();
        this.event('message_anchor_restored', '已从完成记录恢复发送前的位置，不重新发送', { previousId, beforeSentId: pending.beforeSentId });
      }
      pending.knownSentIds ||= ids; pending.knownAnswerIds ||= prior.map(x => x.answerMessageId);
    }
    if (pending.attemptedAt === null) {
      const before = await this.adapter.restore(pending, state.navigation);
      if (!before) throw new PageNotReady('待发送会话尚未加载');
      this.latestPage = summarize(before);
      await this.adapter.verifyAccount(state.account, before);
      if (findSent(before, pending)) throw new ReviewRequired('界面与待发送状态不一致，请核对。');
      this.checkpoint(); this.report('preparing', `正在输入：${step.target} 第${state.messageIndex + 1}条`, before);
      const ready = await this.adapter.fill(text) || before; this.checkpoint();
      const previous = state.completions.at(-1);
      if (previous) await this.pauseableDelay(Math.max(0, (previous.nextAllowedAt ?? previous.answerCompletionObservedAt + state.timingPolicy.replyGapMs) - this.clock()));
      pending.attemptedAt = this.clock(); this.activeDeadline = this.budget('confirm', this.confirmMs);
      this.recordInterval(pending, pending.attemptedAt);
      // Persist the send intent BEFORE clicking. Recovery never retries this click.
      this.report('confirming_send', '正在确认当前消息是否已发送', ready, this.activeDeadline); this.persist();
      this.event('send_intent', `准备发送 ${step.id} 第${state.messageIndex + 1}条`, { textHash: pending.textHash });
      const action = await this.adapter.send();
      pending.sendAction = action || { method: 'adapter', clicked: true }; pending.clickReturnedAt = this.clock(); this.persist();
      this.event('send_action', '发送动作已触发，正在等待实际消息证据', pending.sendAction);
    }
    while (true) {
      this.checkpoint();
      this.activeDeadline = pending.userId ? this.budget('reply', this.responseMs) : this.budget('confirm', this.confirmMs);
      const snapshot = await (this.adapter.observe ? this.adapter.observe(pending, state.navigation) : this.adapter.restore(pending, state.navigation));
      this.latestPage = summarize(snapshot);
      if (snapshot) {
        await this.adapter.verifyAccount(state.account, snapshot);
        if (pending.href && new URL(snapshot.url).pathname !== pending.href) throw new PageNotReady('正在定位原会话', 'conversation_loading');
      }
      this.checkPlatformFailure(snapshot, pending);
      if (!pending.userId) {
        const sent = snapshot && snapshot.matchedConversation !== false && findSent(snapshot, pending);
        if (!sent?.id) {
          const submission = submissionState(snapshot, pending);
          pending.submissionState = submission.kind;
          this.report('confirming_send', snapshot?.thinking ? '已检测到思考状态，正在核对消息编号' : submission.label, snapshot, this.activeDeadline);
          if (this.clock() >= this.activeDeadline) throw new ReviewRequired('当前消息发送结果仍无法确认，请检查豆包后点击继续；确认未发送时才使用“核对后重试”。', 'send_unconfirmed');
          await this.probeIfStalled(snapshot, pending); await this.pauseableDelay(1000); continue;
        }
        pending.userId = sent.id; pending.confirmedAt = this.clock(); pending.href = new URL(snapshot.url).pathname;
        state.conversations[step.target] = { href: pending.href, targetId: this.adapter.client?.target.id || null };
        this.activeDeadline = this.budget('reply', this.responseMs); this.persist();
        this.event('sent', `${step.id} 消息已确认，等待回答`, { userMessageId: sent.id, href: pending.href });
      }
      // A confirmed send stays confirmed even if its DOM node is unmounted.
      if (!snapshot) throw new PageNotReady('消息已发送，回答页面尚未加载', 'answer_loading');
      const visibleUser = snapshot.sent.find(x => x.id === pending.userId);
      if (visibleUser && renderedKey(visibleUser.text) !== renderedKey(pending.text)) throw new ReviewRequired('已发送消息的文字发生变化，请核对。', 'message_changed');
      const answer = findAnswer(snapshot, pending.userId, pending);
      this.checkPlatformFailure(snapshot, pending, answer);
      if (pending.answerId && answer?.id && pending.answerId !== answer.id) throw new ReviewRequired('回答编号发生变化，请核对是否重新生成。', 'answer_changed');
      if (answer?.id && !pending.answerId) { pending.answerId = answer.id; this.persist(); }
      this.recoverySucceeded();
      const observed = replyState(snapshot, answer);
      this.report(observed.stage, observed.label, snapshot, this.activeDeadline);
      if (observed.stableMs) {
        const answerHash = hash(answer.text);
        if (!pending.candidate || pending.candidate.id !== answer.id || pending.candidate.hash !== answerHash) {
          pending.candidate = { id: answer.id, hash: answerHash, since: this.clock(), count: 1 };
        } else pending.candidate.count++;
        if (pending.candidate.count >= 3 && this.clock() - pending.candidate.since >= observed.stableMs) {
          this.complete(step, pending, answer, answerHash, observed.basis); return;
        }
      } else pending.candidate = null;
      if (this.clock() >= this.activeDeadline) throw new ReviewRequired(`消息已发送，但回答尚未可靠确认结束（${observed.label}）。请检查豆包后点击继续，不要重发。`, 'reply_timeout');
      await this.probeIfStalled(snapshot, pending); await this.pauseableDelay(1000);
    }
  }
  complete(step, pending, answer, answerHash, basis) {
    const state = this.state, now = pending.replyToSave?.completion.answerCompletionObservedAt ?? this.clock();
    const record = pending.replyToSave?.completion || { key: `${step.id}:${state.messageIndex}`, stepId: step.id, target: step.target,
      messageIndex: state.messageIndex, href: pending.href, promptHash: pending.textHash,
      userMessageId: pending.userId, answerMessageId: answer.id, answerHash,
      sendAttemptedAt: pending.attemptedAt, sendConfirmedAt: pending.confirmedAt,
      answerCompletionObservedAt: now, recovered: pending.recovered,
      completionTimeUncertain: !!pending.timingUncertain || !!pending.recovered, completionBasis: basis };
    const expected = step.messages[state.messageIndex].expect_reply;
    if (typeof expected === 'string' && !pending.replyToSave) { record.expectedReply = expected; record.replyMatched = normalize(answer.text) === expected; }
    if (state.completions.some(x => x.key === record.key)) throw new Error('发现重复提交，已停止');
    if (state.features?.captureReplies) {
      if (!pending.replyToSave) {
        pending.replyToSave = { sequence:state.completions.length+1, completion:record, prompt:pending.text, answer:answer.text, sourceKind:step.kind||null };
        // Freeze the observed completion time and body before any file work.
        // Resume can finish saving locally without reading or resending a message.
        this.persist();
      }
      const payload = pending.replyToSave;
      if (record.key !== `${step.id}:${state.messageIndex}` || record.target !== step.target || record.href !== pending.href
        || record.userMessageId !== pending.userId || record.answerMessageId !== pending.answerId
        || payload.sequence !== state.completions.length+1 || record.promptHash !== pending.textHash
        || payload.prompt !== step.messages[state.messageIndex].send_text || hash(payload.prompt) !== record.promptHash || hash(payload.answer) !== record.answerHash) {
        throw new ReviewRequired('待保存问答与当前步骤不一致，请核对记录，不能重发。','reply_archive_mismatch');
      }
      this.activeDeadline = null; this.report('saving_reply',`回答已结束，正在保存 ${step.target} 第${state.messageIndex+1}条`);
      try {
        if (!this.archiveReply) throw new Error('未配置本轮回复保存器');
        const receipt = this.archiveReply(payload);
        if (receipt?.status !== 'saved') throw new Error('未确认问答与会话备份均保存成功');
        record.replyArchive = receipt;
      } catch (error) {
        throw new ReviewRequired(`回答已收到，但本地保存未完成：${error.message}。已保留待保存正文；处理文件问题后点击继续，仅补保存，不重发。`,'reply_archive_failed');
      }
    }
    state.completions.push(record);
    const nameJob = queueConversationName(state, step, pending.href, now);
    if (step.t17_anchor) state.t17 = { anchorObservedAt: now,
      earliestAt: now + this.dataset.data.t17.earliest_hours * 3600000,
      targetAt: now + this.dataset.data.t17.target_hours * 3600000,
      latestAt: now + this.dataset.data.t17.latest_hours * 3600000 };
    state.pending = null; state.messageIndex++; state.transitionIndex = 0;
    const moreInStep = state.messageIndex < step.messages.length;
    if (moreInStep || this.hasLaterAutomaticMessage()) {
      state.phase = 'gap'; state.wait = this.replyWait(now, moreInStep ? 'messages' : 'transitions');
      record.plannedGapMs = state.wait.gapMs; record.nextAllowedAt = state.wait.deadline;
    } else { state.phase = 'transitions'; state.wait = null; }
    this.deadlines.clear(); this.activeDeadline = null; this.progressSignature = null;
    state.activity = `已完成 ${state.completions.length}/${this.dataset.total} 条`;
    state.observation = null; state.recovery = null;
    // Completion, interval deadline and cursor advance share one atomic write.
    this.persist(); this.event('message_completed', state.activity, record);
    if (record.replyArchive) this.event('reply_archived',`已保存 ${step.target} 第${record.messageIndex+1}条问答及会话备份`,{key:record.key,...record.replyArchive});
    if (nameJob?.status === 'failed') this.event('rename_failed', '对话名称不符合产品限制，已保留消息完成记录', { target: nameJob.target, reason: nameJob.lastError });
  }
}
