import { normalize, renderedKey, hash } from './store.mjs';

export function summarize(snapshot) {
  if (!snapshot) return { available: false };
  return { available: true, href: new URL(snapshot.url).pathname, visibility: snapshot.visibility || 'unknown',
    lastUserId: snapshot.sent.at(-1)?.id || null, lastAnswerId: snapshot.received.at(-1)?.id || null,
    userCount: snapshot.sent.length, answerCount: snapshot.received.length,
    focused: snapshot.focused ?? null, readyState: snapshot.readyState || null, timeOrigin: snapshot.timeOrigin ?? null,
    selectedConversationHref: snapshot.selectedConversationHref || null,
    observationScope: snapshot.observationScope || 'known', matchedConversation: snapshot.matchedConversation ?? true,
    draftLength: normalize(snapshot.inputText).length, draftHash: hash(normalize(snapshot.inputText)),
    sendReady: !!snapshot.sendReady, sendButtonTag: snapshot.sendButtonTag || null,
    failedUserIds: snapshot.sent.filter(x => x.failed).map(x => x.id || null),
    failedAnswerIds: snapshot.received.filter(x => x.failed).map(x => x.id || null),
    busy: !!snapshot.busy, thinking: !!snapshot.thinking,
    streaming: !!snapshot.received.at(-1)?.streaming, inputExists: !!snapshot.inputExists };
}

export function pendingUser(snapshot, pending) {
  if (!snapshot || snapshot.pendingPage === false) return null;
  if (pending.href && new URL(snapshot.url).pathname !== pending.href) return null;
  if (pending.userId) return snapshot.sent.find(x => x.id === pending.userId) || null;
  const candidates = snapshot.sent.filter(x => !pending.knownSentIds?.includes(x.id)
    && (!pending.beforeSentId || x.id !== pending.beforeSentId) && renderedKey(x.text) === renderedKey(pending.text));
  return candidates.length === 1 ? candidates[0] : null;
}

export function messageFailure(snapshot, pending, answer = null) {
  const user = pendingUser(snapshot, pending);
  const failed = user?.failed ? user : answer?.failed ? answer : null;
  if (!failed) return null;
  return { direction: failed === user ? 'send' : 'reply', messageId: failed.id || null,
    marker: 'message_box_failed_icon', hint: String(failed.failureHint || '').slice(0, 200) };
}

export function submissionState(snapshot, pending) {
  if (!snapshot) return { kind: 'page_unavailable', label: '正在读取页面，核对本条发送结果' };
  const draft = normalize(snapshot.inputText);
  if (!draft) return { kind: 'draft_cleared', label: '输入框已清空，等待本条消息编号' };
  if (draft === normalize(pending.text)) return { kind: 'draft_retained', label: '原文仍在输入框，正在核对提交结果；不会重复点击发送' };
  return { kind: 'draft_changed', label: '输入框内容已变化，正在核对本条发送结果' };
}

export function replyState(snapshot, answer) {
  if (answer?.failed) return { stage: 'platform_failure', label: '豆包显示回答异常标志，需处理原消息' };
  if (snapshot.thinking || answer?.thinking) return { stage: 'thinking', label: '消息已发送，AI正在思考' };
  if (snapshot.busy || answer?.streaming) return { stage: 'generating', label: '消息已发送，回答正在生成' };
  if (!answer?.id || !normalize(answer.text)) return { stage: 'awaiting_reply', label: '消息已发送，等待回答显示' };
  if (answer.explicitComplete) return { stage: 'checking_completion', label: '正在确认回答已结束', stableMs: 3000, basis: 'explicit_flag_and_stability' };
  if (answer.completionControls) return { stage: 'checking_completion', label: '正在核对回答完成标记', stableMs: 8000, basis: 'completion_controls_and_stability' };
  return { stage: 'awaiting_completion', label: '回答文字已显示，等待可靠的结束标记' };
}
