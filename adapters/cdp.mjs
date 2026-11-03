export class ConnectionError extends Error {
  constructor(message, options) { super(message, options); this.name = 'ConnectionError'; }
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function listTargets(port) {
  try {
    const result = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!result.ok) throw new Error(`HTTP ${result.status}`);
    return (await result.json()).filter(x => x.type === 'page' && /doubao-(chat|launcher)\/chat/.test(x.url));
  } catch (cause) { throw new ConnectionError('未连接到豆包。请先启动调试连接，或检查豆包是否已退出。', { cause }); }
}
export async function connect(target, { timeoutMs = 6000, WebSocketImpl = WebSocket } = {}) {
  const socket = new WebSocketImpl(target.webSocketDebuggerUrl);
  let dead = false, nextId = 0;
  const pending = new Map();
  function fail(reason) {
    dead = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new ConnectionError(reason)); }
    pending.clear();
  }
  socket.addEventListener('close', () => fail('豆包页面连接已断开'));
  socket.addEventListener('error', () => fail('豆包页面连接异常'));
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) {
      const detail = message.error.message || JSON.stringify(message.error);
      item.reject(/closed|destroyed|cannot find context|navigat/i.test(detail) ? new ConnectionError(detail) : new Error(detail));
    } else item.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new ConnectionError('建立豆包页面连接超时')); }, timeoutMs);
    const failed = () => { clearTimeout(timer); reject(new ConnectionError('无法建立豆包页面连接')); };
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('close', failed, { once: true }); socket.addEventListener('error', failed, { once: true });
  });
  return {
    target,
    send(method, params = {}) {
      if (dead || socket.readyState !== 1) return Promise.reject(new ConnectionError('豆包连接不可用'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new ConnectionError(`页面操作超时：${method}`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); } catch { fail('发送页面操作时连接断开'); }
      });
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    close() { fail('已释放豆包连接'); socket.close(); }
  };
}
