import { sleep } from './cdp.mjs';
import { normalize, ReviewRequired, Interrupted } from '../core/store.mjs';
import { RenameError } from '../core/naming.mjs';

// These selectors were checked against the app's own loaded menu/dialog code.
// Every mutating action is scoped to the exact conversation or an owned overlay.
export function namingExpression(action, job) {
  if (!/^\/chat\/\d+$/.test(job.href)) throw new Error('改名会话地址无效');
  const data = { id: job.id, href: job.href, desiredName: job.desiredName, originalName: job.originalName ?? null, phase: job.phase };
  return `(() => {
    const action=${JSON.stringify(action)},job=${JSON.stringify(data)};
    const owner='data-doubao-runner-rename-owner';
    const open=e=>!!e&&e.getAttribute('data-state')!=='closed'&&e.getAttribute('aria-hidden')!=='true'
      &&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden';
    const entry=document.getElementById('conversation_'+job.href.slice('/chat/'.length));
    const trigger=entry?.querySelector('[data-testid="chat_list_item_more_button"]');
    const dialog=document.querySelector('[data-testid="edit_conversation_dialog"]');
    const dialogs=[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(open);
    const menus=[...document.querySelectorAll('[role="menu"]')].filter(open);
    const ownedDialog=open(dialog)&&dialog.getAttribute(owner)===job.id?dialog:null;
    const ownedMenu=menus.find(e=>e.getAttribute(owner)===job.id)||null;
    const inputFor=e=>{const node=e?.querySelector('[data-testid="edit_conversation_dialog_name_input"]');return node?.tagName==='INPUT'?node:node?.querySelector('input');};
    const title=()=>{
      const item=entry?.querySelector('[data-testid="conversation-list-v2-item"]');
      const root=item&&[...item.children].find(e=>e.tagName==='SPAN'&&e.classList.contains('min-w-0'));
      if(!root)return null;
      const clone=root.cloneNode(true);clone.querySelectorAll('[aria-hidden="true"]').forEach(e=>e.remove());
      return (clone.textContent||'').trim();
    };
    const controlledValue=()=>{const input=inputFor(ownedDialog),key=input&&Object.keys(input).find(k=>k.startsWith('__reactProps'));return key?input[key]?.value??null:null;};
    const inspect=()=>({href:location.pathname,title:title(),entryExists:!!entry,triggerExists:!!trigger,
      triggerExpanded:trigger?.getAttribute('aria-expanded')??null,triggerState:trigger?.getAttribute('data-state')??null,
      triggerControls:trigger?.getAttribute('aria-controls')??null,
      triggerDisabled:!!trigger&&(!!trigger.disabled||trigger.getAttribute('aria-disabled')==='true'),
      dialogOwned:!!ownedDialog,menuOwned:!!ownedMenu,dialogPresent:open(dialog),
      otherDialogs:dialogs.filter(e=>e!==ownedDialog).length,otherMenus:menus.filter(e=>e!==ownedMenu).length,
      inputValue:ownedDialog?inputFor(ownedDialog)?.value??null:null,
      controlledValue:controlledValue(),
      confirmReady:!!ownedDialog&&!!ownedDialog.querySelector('[data-testid="edit_conversation_dialog_confirm_button"]')
        &&!ownedDialog.querySelector('[data-testid="edit_conversation_dialog_confirm_button"]').disabled,
      chatReady:!!document.querySelector('[data-testid="chat_input_input"] [contenteditable="true"]')});
    const toggleOwnedMenu=()=>{
      if(!trigger||trigger.getAttribute(owner)!==job.id)throw new Error('未取得本次会话菜单');
      if(trigger.disabled||trigger.getAttribute('aria-disabled')==='true')throw new Error('目标会话菜单按钮不可用');
      if(typeof PointerEvent!=='function')throw new Error('当前页面不支持菜单指针事件');
      // The app's DropdownMenuTrigger toggles on primary pointerdown. DOM
      // click only runs its stopPropagation/preventDefault business handler.
      // Activation stays on this element and never moves the desktop pointer.
      const options={bubbles:true,cancelable:true,composed:true,pointerId:1,pointerType:'mouse',isPrimary:true,
        button:0,ctrlKey:false,altKey:false,metaKey:false,shiftKey:false};
      trigger.dispatchEvent(new PointerEvent('pointerdown',{...options,buttons:1}));
      trigger.dispatchEvent(new PointerEvent('pointerup',{...options,buttons:0}));
      // A prevented default on pointerdown is normal while Radix opens.
      // Read aria-expanded and the linked menu later, rather than clicking twice.
      return true;
    };
    if(action==='inspect')return inspect();
    if(location.pathname!==job.href)throw new Error('改名时目标会话已变化');
    if(action==='open_menu'){
      if(dialogs.length||menus.length)throw new Error('存在其他菜单或对话框');
      if(!trigger)throw new Error('找不到目标会话菜单');
      trigger.setAttribute(owner,job.id);return toggleOwnedMenu();
    }
    if(action==='claim_menu'){
      if(trigger?.getAttribute(owner)!==job.id||trigger.getAttribute('aria-expanded')!=='true')return false;
      const controls=trigger.getAttribute('aria-controls');
      const menu=controls?document.getElementById(controls):menus.length===1?menus[0]:null;
      if(!open(menu)||menu.getAttribute('role')!=='menu')return false;
      menu.setAttribute(owner,job.id);return true;
    }
    if(action==='open_dialog'){
      if(!ownedMenu)throw new Error('目标菜单未就绪');
      const item=ownedMenu.querySelector('[data-testid="chat_item_menu_edit_name_icon"]')?.closest('[role="menuitem"]');
      if(!item||item.getAttribute('aria-disabled')==='true')throw new Error('找不到可用的重命名入口');
      item.click();return true;
    }
    if(action==='claim_dialog'){
      if(!open(dialog)||trigger?.getAttribute(owner)!==job.id)return false;
      const input=inputFor(dialog),allowed=[job.originalName,job.desiredName,title()].filter(x=>x!==null);
      if(!input||!allowed.includes(input.value))return false;
      if(dialog.getAttribute(owner)&&dialog.getAttribute(owner)!==job.id)return false;
      dialog.setAttribute(owner,job.id);return true;
    }
    if(action==='fill_input'){
      if(!ownedDialog)throw new Error('未取得本次改名输入框');
      const input=inputFor(ownedDialog);
      if(!input||input.disabled||input.readOnly)throw new Error('名称输入框不可用');
      if(input.maxLength>0&&job.desiredName.length>input.maxLength)throw new Error('名称超过产品长度限制');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
      if(!setter)throw new Error('无法安全填写名称输入框');
      setter.call(input,job.desiredName);
      input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true;
    }
    if(action==='confirm'){
      if(!ownedDialog||inputFor(ownedDialog)?.value!==job.desiredName)throw new Error('名称输入核对失败');
      const button=ownedDialog.querySelector('[data-testid="edit_conversation_dialog_confirm_button"]');
      if(!button||button.disabled||button.getAttribute('aria-disabled')==='true')throw new Error('保存名称按钮不可用');
      button.click();return true;
    }
    if(action==='cancel_owned'){
      if(ownedDialog){
        const cancel=ownedDialog.querySelector('[data-testid="edit_conversation_dialog_cancel_button"]');
        if(!cancel)throw new Error('无法安全退出改名输入框');cancel.click();
      }else if(trigger?.getAttribute(owner)===job.id&&trigger.getAttribute('aria-expanded')==='true')toggleOwnedMenu();
      return true;
    }
    if(action==='release'){
      if(trigger?.getAttribute(owner)===job.id)trigger.removeAttribute(owner);return true;
    }
    throw new Error('未知改名动作');
  })()`;
}

export async function renameConversation(adapter, job, account, { checkpoint = () => {}, onCheckpoint = () => {},
  clock = Date.now, delay = sleep, timeoutMs = 5000 } = {}) {
  const evaluate = action => adapter.client.evaluate(namingExpression(action, job));
  const captureFailure = async () => {
    job.failureStage = job.phase;
    try {
      const view = await evaluate('inspect');
      const keys = ['href','entryExists','triggerExists','triggerExpanded','triggerState','triggerControls','triggerDisabled',
        'menuOwned','dialogOwned','dialogPresent','otherDialogs','otherMenus','confirmReady','chatReady'];
      job.failureView = Object.fromEntries(keys.map(key => [key, view[key]]));
    } catch (error) { job.failureView = { unavailable: true, reason: error.message }; }
    onCheckpoint(job);
  };
  const wait = async (predicate, label) => {
    const deadline = clock() + timeoutMs;
    while (clock() < deadline) { checkpoint(); if (await predicate()) return; await delay(200); }
    throw new Error('等待'+label+'超时');
  };
  const stage = (phase, details = {}) => { Object.assign(job, details, { phase }); onCheckpoint(job); };
  let failure = null, result = null, cleanupVerified = false;
  try {
    const initial = await adapter.choose(); await adapter.verifyAccount(account, initial);
    if (normalize(initial.inputText) || initial.busy || initial.thinking) throw new ReviewRequired('当前有草稿或回答尚未结束，已暂停自动改名。', 'rename_input_busy');
    await adapter.openKnown(job.href, { settle: false });
    let view = await evaluate('inspect');
    if (view.dialogOwned || view.menuOwned) {
      await evaluate('cancel_owned');
      await wait(async () => { const state = await evaluate('inspect'); return !state.dialogOwned && !state.menuOwned; }, '退出上次改名界面');
      view = await evaluate('inspect');
    }
    if (view.otherDialogs || view.otherMenus) throw new ReviewRequired('存在非本次改名打开的菜单或对话框，请处理后继续。', 'rename_foreign_overlay');
    if (!view.entryExists || view.title === null) throw new Error('目标会话标题尚未加载');
    if (view.title === job.desiredName) result = { status: 'already_named', title: view.title, href: job.href };
    else {
      stage('menu_open_attempted', { originalName: view.title });
      await evaluate('open_menu'); await wait(async () => evaluate('claim_menu'), '会话菜单展开并确认归属');
      stage('dialog_open_attempted'); await evaluate('open_dialog');
      await wait(async () => evaluate('claim_dialog'), '改名输入框出现并确认归属');
      stage('dialog_owned'); checkpoint(); await evaluate('fill_input');
      await wait(async () => { const state = await evaluate('inspect'); return state.dialogOwned && state.inputValue === job.desiredName
        && (state.controlledValue === null || state.controlledValue === job.desiredName) && state.confirmReady; }, '名称输入及保存按钮就绪');
      stage('save_attempted', { saveAttemptedAt: clock() }); await evaluate('confirm');
      await wait(async () => { const state = await evaluate('inspect'); return state.title === job.desiredName && !state.dialogPresent; }, '保存后标题更新且改名窗口关闭');
      await delay(300); checkpoint();
      const saved = await evaluate('inspect');
      if (saved.title !== job.desiredName) throw new Error('保存后标题核对不一致');
      result = { status: 'renamed', title: saved.title, href: job.href };
    }
  } catch (error) { failure = error; await captureFailure(); }
  finally {
    try {
      // A paused process can resume between dialog creation and ownership tagging.
      // Claim only the known rename dialog tied to our marked conversation trigger.
      if (job.phase === 'dialog_open_attempted') await evaluate('claim_dialog');
      await evaluate('cancel_owned');
      const deadline = clock() + Math.min(timeoutMs, 3000);
      do {
        const view = await evaluate('inspect');
        if (!view.dialogOwned && !view.menuOwned && !view.otherDialogs && !view.otherMenus && view.chatReady && view.href === job.href) { cleanupVerified = true; break; }
        await delay(150);
      } while (clock() < deadline);
      if (cleanupVerified) await evaluate('release');
    } catch { cleanupVerified = false; }
    job.cleanupVerified = cleanupVerified; onCheckpoint(job);
  }
  if (!cleanupVerified) throw new RenameError(`${failure ? failure.message + '；' : ''}未能确认退出改名界面，已保留断点，请检查豆包后继续。`, false);
  if (failure instanceof Interrupted || failure instanceof ReviewRequired) throw failure;
  if (failure) throw new RenameError(failure.message, true);
  return result;
}
