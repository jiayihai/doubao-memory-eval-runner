import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listTargets, connect, sleep } from '../adapters/cdp.mjs';
import { SNAPSHOT } from '../adapters/doubao.mjs';

// Read only: no focus, scrolling, navigation, click, input or network interception.
// Keep extraction separate from the sender's stable snapshot and completion path.
export const CURRENT_LOADED_SNAPSHOT = `(() => {
  const info=${SNAPSHOT};
  const roots=[...document.querySelectorAll('[data-testid="send_message"],[data-testid="receive_message"]')];
  const ordered=info.ordered.map((message,index)=>{
    const root=roots[index],parts=[...root.querySelectorAll('[data-testid="message_text_content"]')];
    const content=root.querySelector('[data-testid="message_content"]');
    const text=parts.length?parts.map(e=>e.innerText??e.textContent??'').join('\\n'):(content?.innerText??root.innerText??'');
    return {...message,text};
  });
  const entry=document.getElementById('conversation_'+location.pathname.split('/').at(-1));
  const item=entry?.querySelector('[data-testid="conversation-list-v2-item"]');
  const label=item&&[...item.children].find(e=>e.tagName==='SPAN'&&e.classList.contains('min-w-0'));
  let title='';
  if(label){const clone=label.cloneNode(true);clone.querySelectorAll('[aria-hidden="true"]').forEach(e=>e.remove());title=(clone.textContent||'').trim();}
  return {...info,ordered,title:title||document.title||''};
})()`;

function desktopChatLocation(value) {
  try {
    const url = new URL(value);
    // Desktop CDP target URLs may use doubao:, even when Runtime reports chrome:.
    // Keep one allowlist for discovery and snapshot validation.
    return ['chrome:','doubao:'].includes(url.protocol) && url.hostname === 'doubao-chat'
      && /^\/chat(?:\/\d+)?$/.test(url.pathname) ? url : null;
  } catch { return null; }
}

function validateSnapshot(snapshot, account) {
  const url = desktopChatLocation(snapshot.url);
  if (!url || !/^\/chat\/\d+$/.test(url.pathname)) {
    throw new Error('请在豆包中打开已有的普通对话，再导出已加载内容。');
  }
  if (!snapshot.account || snapshot.account !== account) throw new Error('当前账号与已核验账号不一致或尚未加载，请重新检查连接。');
  if (!snapshot.dialogue) throw new Error('请在豆包普通“对话”模式中提取。');
  if (snapshot.busy || snapshot.thinking || snapshot.ordered?.some(x => x.streaming || x.thinking)) {
    throw new Error('当前已加载消息仍在思考或生成，请等回答结束后再导出。');
  }
  if (!Array.isArray(snapshot.ordered) || !snapshot.ordered.length) throw new Error('当前页面未读取到消息，请先打开一个有内容的对话。');
  const ids = new Set();
  for (const message of snapshot.ordered) {
    if (!['user','assistant'].includes(message.role) || typeof message.text !== 'string') throw new Error('消息结构无法核对，未保存导出。');
    if (message.id) {
      if (ids.has(message.id)) throw new Error('当前页面有重复消息编号，无法可靠核对顺序，请检查后再导出。');
      ids.add(message.id);
    }
  }
  return url;
}

export function buildConversationExport(snapshot, { account, targetId, exportedAt, exportId }) {
  const url = validateSnapshot(snapshot, account);
  const warnings = ['仅包含当前页面已加载并可读取的消息，历史完整性未验证；未滚动加载更早记录。',
    '本版保存页面正文文字，不承诺图片、附件、引用链接、表格/代码格式或思考过程的完整导出。',
    '导出时间是本机采集时间，未取得的平台原始消息时间不作推测。'];
  if (snapshot.ordered.some(x => !x.id)) warnings.push('存在没有平台消息编号的节点，只保留页面顺序，暂不能据此做精确回填。');
  if (snapshot.ordered.some(x => x.failed)) warnings.push('部分已加载消息带平台失败标记，已原样标明，不代表发送或回答成功。');
  if (snapshot.ordered.some(x => !x.text.trim())) warnings.push('部分消息没有可读取的文字，可能是附件或不支持的内容；未将其丢弃。');
  const messages = snapshot.ordered.map((m,index) => ({ sequence:index+1, role:m.role, messageId:m.id||null,
    text:m.text, failed:!!m.failed, streaming:!!m.streaming, thinking:!!m.thinking,
    completionMarkerPresent:!!m.explicitComplete }));
  return { schemaVersion:1, exportId, scope:'currently_loaded_messages', historyCompleteness:'not_verified',
    exportedAt, source:{product:'doubao_desktop',targetId,url:snapshot.url,conversationId:url.pathname.slice('/chat/'.length),
      title:snapshot.title||'',account}, warnings,
    counts:{total:messages.length,user:messages.filter(m=>m.role==='user').length,assistant:messages.filter(m=>m.role==='assistant').length},messages };
}

export function conversationMarkdown(record) {
  const lines = ['# 豆包当前已加载对话','',`会话标题：${JSON.stringify(record.source.title)}`,
    `会话编号：${record.source.conversationId}`,`采集时间：${record.exportedAt}`,
    `消息：${record.counts.total}条（用户${record.counts.user}条，豆包${record.counts.assistant}条）`,'',
    '历史完整性：未验证。此文件仅包含当前已加载内容，不表示整段历史已导出。','',
    ...record.warnings.map(x=>'- '+x),''];
  for (const message of record.messages) {
    // Longer fences preserve literal backticks/code text inside the message.
    const runs=message.text.match(/`+/g)||[];
    const fence='`'.repeat(Math.max(3,...runs.map(x=>x.length+1)));
    lines.push(`## ${message.sequence}. ${message.role==='user'?'用户':'豆包'}`,'',
      `消息编号：${message.messageId||'未取得'}${message.failed?'；平台失败标记：有':''}`,'',
      fence+'text',message.text,fence,'');
  }
  return lines.join('\n');
}

export async function exportCurrentLoaded({ root, port, expectedAccount, list=listTargets, connectTo=connect, delay=sleep,
  clock=Date.now }) {
  if (!Number.isInteger(port) || port<1024 || port>65535) throw new Error('调试端口无效。');
  const account=String(expectedAccount||'').trim();
  if (!account) throw new Error('请先点击“检查连接”核实账号，再导出。');
  const targets=(await list(port)).filter(t=>desktopChatLocation(t.url));
  if (targets.length!==1) throw new Error(targets.length?'检测到多个豆包对话页面，暂不能确定目标，请只保留一个对话界面后重试。':'没有找到已连接的豆包对话页面，请先检查连接。');
  const client=await connectTo(targets[0]);
  let record;
  try {
    const first=await client.evaluate(CURRENT_LOADED_SNAPSHOT);validateSnapshot(first,account);
    await delay(350);
    const second=await client.evaluate(CURRENT_LOADED_SNAPSHOT);validateSnapshot(second,account);
    if(first.url!==second.url || JSON.stringify(first.ordered)!==JSON.stringify(second.ordered)) {
      throw new Error('会话或消息内容正在变化，请等页面稳定后再导出。');
    }
    const exportId=new Date(clock()).toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
    record=buildConversationExport(second,{account,targetId:targets[0].id,exportId,exportedAt:new Date(clock()).toISOString()});
  } finally { client.close(); }
  const exportRoot=resolve(root,'对话导出');
  const temporary=resolve(exportRoot,'.partial-'+record.exportId), destination=resolve(exportRoot,record.exportId);
  if(dirname(temporary)!==exportRoot || dirname(destination)!==exportRoot) throw new Error('导出目录无效。');
  mkdirSync(exportRoot,{recursive:true});mkdirSync(temporary);
  // Publish the directory only after both files exist. A failed write leaves an
  // explicitly partial folder, never a completed-looking JSON/Markdown pair.
  writeFileSync(resolve(temporary,'conversation.json'),JSON.stringify(record,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  writeFileSync(resolve(temporary,'conversation.md'),conversationMarkdown(record),{encoding:'utf8',flag:'wx'});
  renameSync(temporary,destination);
  return { directory:destination,files:['conversation.json','conversation.md'],...record.counts,
    title:record.source.title,scope:record.scope,historyCompleteness:record.historyCompleteness };
}
