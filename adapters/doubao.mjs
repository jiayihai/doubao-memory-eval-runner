import { listTargets, connect, sleep, ConnectionError } from './cdp.mjs';
import { normalize, renderedKey, ReviewRequired, PageNotReady } from '../core/store.mjs';
import { renameConversation } from './doubao-naming.mjs';

export const SNAPSHOT = `(() => {
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
  const thinking=root=>[...root.querySelectorAll('[data-testid*="thinking"],[data-testid*="reasoning"],[role="status"],[aria-busy="true"],[data-state="thinking"]')]
    .some(e=>visible(e)&&(e.getAttribute('aria-busy')==='true'||e.getAttribute('data-state')==='thinking'
      ||e.getAttribute('data-streaming')==='true'||/^(正在思考|思考中|深度思考中|正在深度思考|正在生成|生成中|正在搜索|搜索中)[.…。\\s]*$/.test((e.innerText||'').trim())));
  const read = (root, role) => {
    const content=root.querySelector('[data-testid="message_content"]');
    const parts=[...root.querySelectorAll('[data-testid="message_text_content"]')];
    const failure=root.querySelector('[data-testid="message_box_failed_icon"]');
    return {role,id:content?.getAttribute('data-message-id')||root.getAttribute('data-message-id')||null,
      failed:!!failure,failureHint:failure?(failure.getAttribute('aria-label')||failure.getAttribute('title')||''):null,
      text:parts.length?parts.map(e=>e.innerText||e.textContent||'').join('\\n').trim():(content?.innerText||root.innerText||'').trim(),
      thinking:role==='assistant'&&thinking(root),
      completionControls:role==='assistant'&&[...root.querySelectorAll('[data-testid*="copy"],[data-testid*="regenerate"]')].some(visible),
      streaming:parts.some(e=>e.getAttribute('data-streaming')==='true'),
      explicitComplete:parts.length>0&&parts.every(e=>e.getAttribute('data-streaming')==='false')};
  };
  const ordered=[...document.querySelectorAll('[data-testid="send_message"],[data-testid="receive_message"]')]
    .map(e=>read(e,e.getAttribute('data-testid')==='send_message'?'user':'assistant'));
  const input=document.querySelector('[data-testid="chat_input_input"]');
  const editor=input?.querySelector('[contenteditable="true"]');
  const inputText=editor?[...editor.children].map(e=>(e.innerText||e.textContent||'').replace(/\\n$/,'')).join('\\n'):(input?.innerText||input?.value||'');
  const sw=document.querySelector('[data-testid="conversation-mode-switch"]');
  const currentMode=document.querySelector('[data-testid="chat_input"] [title="对话"], [data-testid="chat_input"] [title="工作"]')?.getAttribute('title');
  const dialogue=currentMode==='对话'||!!sw&&[...sw.querySelectorAll('button,[role="button"],div')]
    .some(e=>(e.innerText||'').trim()==='对话'&&/text-dbx-text-primary|font-medium/.test(String(e.className)));
  const sendButton=document.querySelector('[data-testid="chat_input_send_button"]');
  const sendReady=!!sendButton&&!sendButton.disabled&&sendButton.getAttribute('aria-disabled')!=='true';
  const stop=[...document.querySelectorAll('button,[role="button"]')].some(e=>{
    const r=e.getBoundingClientRect();const id=e.getAttribute('data-testid')||'';
    const label=e.getAttribute('aria-label')||e.getAttribute('title')||'';
    return r.width>0&&r.height>0&&(/chat_input_stop|stop_generat|stop_response/.test(id)||/停止生成|停止回答/.test(label));});
  const selectedLink=[...document.querySelectorAll('a[aria-current="page"][href]')].find(e=>/^\\/chat\\/\\d+$/.test(new URL(e.href,location.href).pathname));
  return {url:location.href,visibility:document.visibilityState,focused:document.hasFocus?.()??null,
    readyState:document.readyState||null,timeOrigin:typeof performance==='undefined'?null:performance.timeOrigin,
    selectedConversationHref:selectedLink?new URL(selectedLink.href,location.href).pathname:null,
    inputExists:!!editor,inputText,sendButtonTag:sendButton?.tagName||null,
    account:(document.querySelector('[data-testid="chat_header_avatar_button"]')?.closest('button')?.innerText||document.querySelector('[data-testid="sidebar_bottom"]')?.innerText?.split('\\n')[0]||'').replace(/\\s+/g,' ').trim(),
    dialogue,mode:currentMode||null,sendReady,busy:stop,thinking:ordered.filter(e=>e.role==='assistant').at(-1)?.thinking||false,
    ordered,sent:ordered.filter(e=>e.role==='user'),received:ordered.filter(e=>e.role==='assistant')};
})()`;

export function historyNavigationExpression(href) {
  if (!/^\/chat\/\d+$/.test(href)) throw new Error('历史会话地址无效');
  return `(() => {
    const href=${JSON.stringify(href)};
    const link=document.getElementById('conversation_'+href.slice('/chat/'.length));
    if(!link||link.tagName!=='A'||new URL(link.getAttribute('href'),location.href).pathname!==href)return {status:'missing'};
    const key=Object.keys(link).find(k=>k.startsWith('__reactProps'));
    if(!key||typeof link[key]?.onClick!=='function')return {status:'not_ready'};
    const beforeTimeOrigin=performance.timeOrigin;
    // Use the existing app entry and its pointer preparation hooks. Never assign
    // location.href: that reloads the entire background app and its services.
    link.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,buttons:1,detail:1,view:window}));
    link.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0,buttons:0,detail:1,view:window}));
    link.click();
    return {status:'clicked',method:'history_link',href,beforeTimeOrigin,at:Date.now()};
  })()`;
}

export class DoubaoAdapter {
  constructor(port = 9223) { this.port = port; this.client = null; }
  pages() { return listTargets(this.port); }
  close() { this.client?.close(); this.client = null; }
  async use(target) {
    if (this.client?.target.id === target.id) return;
    this.close(); this.client = await connect(target);
  }
  async snapshot() { return this.client.evaluate(SNAPSHOT); }
  renameConversation(job, account, options) { return renameConversation(this, job, account, options); }
  async scrollLatest() {
    return this.client.evaluate(`(() => {
      const messages=[...document.querySelectorAll('[data-testid="send_message"],[data-testid="receive_message"]')];
      let e=messages.at(-1); let atBottom=true;
      while(e){
        const style=getComputedStyle(e);
        if(/auto|scroll|overlay/.test(style.overflowY)&&e.scrollHeight>e.clientHeight+2){
          e.scrollTop=e.scrollHeight;
          atBottom=atBottom&&(e.scrollHeight-e.clientHeight-e.scrollTop<4);
        }
        e=e.parentElement;
      }
      const root=document.scrollingElement;
      if(root&&root.scrollHeight>root.clientHeight+2)root.scrollTop=root.scrollHeight;
      return {atBottom};
    })()`);
  }
  async latestSnapshot(href, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    let previous = null, stableSince = null;
    while (Date.now() < deadline) {
      const scroll = await this.scrollLatest();
      await sleep(250);
      const info = await this.snapshot();
      const key = info.sent.at(-1)?.id || null;
      if (new URL(info.url).pathname === href && key && scroll.atBottom) {
        if (key !== previous) { previous = key; stableSince = Date.now(); }
        else if (Date.now() - stableSince >= 750) return info;
      } else { previous = null; stableSince = null; }
    }
    throw new PageNotReady('原会话最新消息尚未稳定加载', 'latest_message_loading');
  }
  async choose() {
    const pages = await this.pages();
    const chats = pages.filter(x => /doubao-chat\/chat/.test(x.url));
    const options = chats.length ? chats : pages;
    if (options.length !== 1) throw new ConnectionError(`找到 ${options.length} 个聊天页面，请只保留一个豆包主聊天窗口。`);
    await this.use(options[0]); return this.snapshot();
  }
  async verifyAccount(account, info = null) {
    info ||= await this.snapshot();
    if (!info.account) throw new PageNotReady('豆包账号信息尚未加载', 'account_loading');
    if (normalize(info.account) !== normalize(account)) throw new ReviewRequired('豆包账号与本轮记录不一致，请核对账号再继续。', 'account_changed');
    if (!info.inputExists) throw new PageNotReady('豆包输入框尚未就绪', 'input_loading');
    if (!info.dialogue) {
      if (info.mode) throw new ReviewRequired('当前不是普通“对话”模式，请切回对话模式再继续。', 'mode_changed');
      throw new PageNotReady('豆包对话模式标记尚未加载', 'mode_loading');
    }
    return info;
  }
  async waitPage(predicate, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = await this.snapshot();
      if (predicate(info)) return info;
      await sleep(300);
    }
    throw new PageNotReady(`${label}暂未完成`, 'page_loading');
  }
  async prepareNew(account, { onIntent = () => {} } = {}) {
    const info = await this.choose();
    await this.verifyAccount(account, info);
    if (normalize(info.inputText)) throw new Error('豆包当前有未发送的草稿，请自行处理后继续。');
    const beforeHrefs = [...new Set((await this.pages()).map(x => new URL(x.url).pathname))];
    onIntent({ targetId: this.client.target.id, beforeHrefs, url: info.url });
    // Reuse the real new-chat control rather than assuming a separate launcher exists.
    if (/^\/chat\/\d+/.test(new URL(info.url).pathname) || info.sent.length) {
      await this.client.evaluate(`(() => {const b=document.querySelector('[data-testid="create_conversation_button"] [role="button"]')||document.querySelector('button[data-testid="create_conversation_button"]');
        if(!b)throw new Error('找不到新对话按钮');b.click();})()`);
    }
    return this.recoverNew({ beforeHrefs }, account);
  }
  async recoverNew(intent, account) {
    // Re-observe an already attempted new-chat action; never click it again.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      for (const target of await this.pages()) {
        await this.use(target);
        const ready = await this.snapshot();
        if (ready.inputExists && !ready.sent.length && !normalize(ready.inputText)
          && !/^\/chat\/\d+/.test(new URL(ready.url).pathname)) {
          await this.verifyAccount(account, ready);
          return { targetId: this.client.target.id, beforeHrefs: intent.beforeHrefs, url: ready.url };
        }
      }
      await sleep(400);
    }
    throw new PageNotReady('新会话页面尚未加载，不重复点击新建按钮', 'new_chat_loading');
  }
  async openKnown(href, { settle = true } = {}) {
    const pages = await this.pages();
    const exact = pages.filter(x => new URL(x.url).pathname === href);
    let target = exact.find(x => /doubao-chat/.test(x.url)) || exact[0];
    if (!target) {
      const main = pages.filter(x => /doubao-chat\/chat/.test(x.url));
      if (main.length !== 1) throw new ConnectionError('无法唯一定位豆包主页面，请打开对应会话。');
      target = main[0];
    }
    await this.use(target);
    const current = await this.snapshot();
    let navigation = null;
    if (new URL(current.url).pathname !== href) {
      if (normalize(current.inputText)) throw new Error('当前页面存在未发送草稿，请先处理，执行器不会覆盖它。');
      if (current.busy || current.thinking) throw new ReviewRequired('其他会话仍在生成回答，请核对后再切换。', 'other_chat_busy');
      const action = await this.client.evaluate(historyNavigationExpression(href));
      if (action.status !== 'clicked') throw new PageNotReady('目标历史会话入口尚未加载，请在侧边栏定位原会话后继续', 'history_entry_loading');
      this.navigationEvidence = navigation = action;
    } else {
      this.navigationEvidence = { status: 'already_open', method: 'already_open', href,
        beforeTimeOrigin: current.timeOrigin ?? null, afterTimeOrigin: current.timeOrigin ?? null, at: Date.now() };
    }
    const info = await this.waitPage(x => new URL(x.url).pathname === href && x.inputExists
      && (!x.selectedConversationHref || x.selectedConversationHref === href), '通过历史入口打开原会话');
    if (navigation && Number.isFinite(info.timeOrigin)) {
      const before = navigation.beforeTimeOrigin;
      this.navigationEvidence.afterTimeOrigin = info.timeOrigin;
      if (Number.isFinite(before) && before !== info.timeOrigin) throw new ReviewRequired('返回历史会话时发生整页重载，已暂停以避免在未就绪页面提交。请打开原会话后继续。', 'history_document_reloaded');
    }
    return settle ? this.latestSnapshot(href) : info;
  }
  async restoreUnsent(navigation) {
    const pages = await this.pages();
    let target = pages.find(x => x.id === navigation.targetId);
    if (!target) {
      const blank = pages.filter(x => /^\/chat$/.test(new URL(x.url).pathname));
      if (blank.length === 1) target = blank[0];
    }
    if (!target) throw new ConnectionError('找不到待发送的新会话，请在豆包中打开空白对话。');
    await this.use(target);
    const info = await this.snapshot();
    if (info.sent.length || /^\/chat\/\d+/.test(new URL(info.url).pathname)) throw new ReviewRequired('待发送的新会话已变化，请先核对，不能继续向未知会话发送。');
    return info;
  }
  async locateSentNew(pending, navigation = null, observeUnmatched = false) {
    const matches = new Map();
    let original = null;
    for (const target of await this.pages()) {
      const href = new URL(target.url).pathname;
      const candidate = /^\/chat\/\d+/.test(href) && !pending.beforeHrefs.includes(href);
      const isOriginal = observeUnmatched && target.id === navigation?.targetId;
      if (!candidate && !isOriginal) continue;
      await this.use(target);
      const info = await this.snapshot();
      if (isOriginal) original = { target, info };
      if (candidate && info.sent.length === 1 && renderedKey(info.sent[0].text) === renderedKey(pending.text)) matches.set(href, { target, info });
    }
    if (matches.size > 1) throw new ReviewRequired('发现多个同文的新会话，请核对并只打开本轮对应会话。');
    if (matches.size) {
      const match = [...matches.values()][0]; await this.use(match.target);
      return observeUnmatched ? { ...match.info, observationScope: 'matched_new', matchedConversation: true, sourceTargetId: match.target.id } : match.info;
    }
    if (!original) return null;
    await this.use(original.target);
    const href = new URL(original.info.url).pathname;
    return { ...original.info, observationScope: 'unmatched_new', matchedConversation: false,
      pendingPage: !pending.beforeHrefs.includes(href), sourceTargetId: original.target.id };
  }
  async restore(pending, navigation) {
    if (pending.href) return this.openKnown(pending.href);
    return pending.attemptedAt === null ? this.restoreUnsent(navigation) : this.locateSentNew(pending);
  }
  async observe(pending, navigation) {
    if (this.client) {
      const info = await this.snapshot();
      if (pending.href && new URL(info.url).pathname === pending.href) return info;
    }
    if (pending.href) return this.openKnown(pending.href, { settle: false });
    return pending.attemptedAt === null ? this.restoreUnsent(navigation) : this.locateSentNew(pending, navigation, true);
  }
  async recover(pending, navigation) {
    const info = pending ? await this.observe(pending, navigation) : await this.choose();
    if (info && (pending?.href && new URL(info.url).pathname === pending.href || info.observationScope === 'unmatched_new')) await this.scrollLatest();
    return info;
  }
  async fill(text) {
    const before = await this.snapshot();
    if (normalize(before.inputText) !== normalize(text)) {
      if (normalize(before.inputText)) throw new Error('输入框出现其他草稿，已停止，避免覆盖人工内容。');
      await this.client.evaluate(`document.querySelector('[data-testid="chat_input_input"] [contenteditable="true"]').focus()`);
      await this.client.send('Input.insertText', { text });
    }
    const after = await this.snapshot();
    if (normalize(after.inputText) !== normalize(text)) throw new Error('输入框文字与预设消息不一致，未点击发送。请检查后继续。');
    return this.waitPage(x => x.sendReady && normalize(x.inputText) === normalize(text) && !x.busy && !x.thinking, '等待发送按钮就绪', 5000);
  }
  async send() {
    // Element activation avoids viewport coordinates becoming stale after a hidden
    // desktop window is resized. Delivery still requires a new message receipt.
    const action = await this.client.evaluate(`(() => {const e=document.querySelector('[data-testid="chat_input_send_button"]');
      if(!e||e.disabled||e.getAttribute('aria-disabled')==='true')return {clicked:false};
      const result={clicked:true,method:'dom_click',tag:e.tagName,visibility:document.visibilityState,
        focused:document.hasFocus(),timeOrigin:performance.timeOrigin,href:location.pathname,at:Date.now()};
      e.click();return result;})()`);
    if (!action?.clicked) throw new ReviewRequired('发送按钮不可用，请核对上一条消息是否发送成功，再继续。');
    return action;
  }
}
