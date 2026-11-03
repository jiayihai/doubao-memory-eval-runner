// Naming source is isolated here; a future Excel adapter can supply this value.
export function conversationNameFor(step) {
  const name = String(step.conversationName || step.target || '').trim();
  if (!name || name.length > 20 || /[\r\n]/.test(name)) throw new Error('对话名称须为1至20个字符且不含换行');
  return name;
}

export function queueConversationName(state, step, href, now) {
  if (!state.features?.renameConversations || step.navigation !== 'new') return;
  state.renameJobs ||= {};
  if (state.renameJobs[step.target]) return;
  let desiredName;
  try { desiredName = conversationNameFor(step); }
  catch (error) {
    return state.renameJobs[step.target] = { id: `${state.runId || 'local'}:${step.target}`, target: step.target, href,
      desiredName: String(step.target || ''), status: 'failed', attempts: 0, queuedAt: now, phase: 'invalid_name', lastError: error.message };
  }
  return state.renameJobs[step.target] = { id: `${state.runId || 'local'}:${step.target}`, target: step.target, href,
    desiredName, status: 'pending', attempts: 0, queuedAt: now, phase: 'queued' };
}

export class RenameError extends Error {
  constructor(message, safeToContinue = false) {
    super(message); this.name = 'RenameError'; this.code = 'rename_unconfirmed'; this.safeToContinue = safeToContinue;
  }
}
