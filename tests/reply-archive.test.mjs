import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ReplyArchive } from '../core/reply-archive.mjs';
import { hash } from '../core/store.mjs';

function cleanup(root) {
  const absolute=resolve(root);
  if(!absolute.startsWith(resolve(tmpdir(),'doubao-archive-')))throw new Error('Unexpected cleanup path');
  const walk=dir=>{if(dir!==absolute&&!dir.startsWith(absolute+'\\'))throw new Error('Cleanup escaped test directory');
    for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())walk(p);else unlinkSync(p);}rmdirSync(dir);};
  walk(absolute);
}
const context={runId:'test-run',datasetId:'doubao-b',datasetHash:'frozen-dataset',account:'test-account'};
const make = (sequence=1,target='M01') => {
  const prompt=`原始输入${sequence}\n保留原文`,answer=`回答${sequence}\n`+'完整回复'.repeat(1000)+'\n```代码```';
  return {sequence,prompt,answer,sourceKind:'输入',completion:{key:`S${sequence}:0`,stepId:`S${sequence}`,target,messageIndex:0,
    href:target==='M01'?'/chat/1':'/chat/2',userMessageId:`u${sequence}`,answerMessageId:`a${sequence}`,promptHash:hash(prompt),answerHash:hash(answer),
    sendAttemptedAt:100000+sequence,sendConfirmedAt:101000+sequence,answerCompletionObservedAt:104000+sequence,completionBasis:'explicit_flag_and_stability'}};
};
const read=file=>JSON.parse(readFileSync(file,'utf8'));

test('每条完整问答独立落盘，按编号生成JSON与MD，长正文不截断',()=>{
  const root=mkdtempSync(join(tmpdir(),'doubao-archive-'));
  try {
    const archive=new ReplyArchive({directory:root,...context}),p=make(),receipt=archive.save(p);
    assert.equal(receipt.status,'saved');assert.equal(read(join(root,receipt.replyFile)).answer,p.answer);
    const backup=read(join(root,'会话备份/M01.json'));
    assert.equal(backup.messages.length,2);assert.equal(backup.messages[0].text,p.prompt);assert.equal(backup.messages[1].text,p.answer);
    assert.ok(readFileSync(join(root,'会话备份/M01.md'),'utf8').includes(p.answer));
    assert.equal(backup.historyCompleteness,'only_captured_script_turns');assert.equal(backup.runId,context.runId);
  } finally {cleanup(root);}
});

test('同一步骤恢复保存不重复追加，重新生成缺失备份',()=>{
  const root=mkdtempSync(join(tmpdir(),'doubao-archive-'));
  try {
    const p=make();new ReplyArchive({directory:root,...context}).save(p);
    unlinkSync(join(root,'会话备份/M01.md'));
    new ReplyArchive({directory:root,...context}).save(p);
    assert.equal(readdirSync(join(root,'回复记录')).filter(x=>x.endsWith('.json')).length,1);
    assert.equal(read(join(root,'会话备份/M01.json')).counts.turns,1);
    assert.ok(existsSync(join(root,'会话备份/M01.md')));
  } finally {cleanup(root);}
});

test('M01到T01再返回M01时更新同一会话文件，保持消息顺序',()=>{
  const root=mkdtempSync(join(tmpdir(),'doubao-archive-'));
  try {
    const archive=new ReplyArchive({directory:root,...context});archive.save(make(1));archive.save(make(2,'T01'));archive.save(make(3));
    const m=read(join(root,'会话备份/M01.json')),t=read(join(root,'会话备份/T01.json'));
    assert.deepEqual(m.messages.map(x=>x.messageId),['u1','a1','u3','a3']);assert.equal(t.messages.length,2);
    const index=read(join(root,'会话备份/_备份索引.json'));
    assert.equal(index.savedTurns,3);assert.equal(index.conversationCount,2);
  } finally {cleanup(root);}
});

test('同一步骤出现不同正文时拒绝覆盖已有证据',()=>{
  const root=mkdtempSync(join(tmpdir(),'doubao-archive-'));
  try {
    const archive=new ReplyArchive({directory:root,...context}),p=make();const receipt=archive.save(p);
    const changed=structuredClone(p);changed.answer='changed';changed.completion.answerHash=hash(changed.answer);
    assert.throws(()=>archive.save(changed),/禁止覆盖/);
    assert.equal(read(join(root,receipt.replyFile)).answer,p.answer);
  } finally {cleanup(root);}
});

test('Markdown保存失败后原始问答仍在，下一次只从本地重建完整备份',()=>{
  const root=mkdtempSync(join(tmpdir(),'doubao-archive-'));
  try {
    const p=make(),broken=new ReplyArchive({directory:root,...context,writeText:()=>{throw new Error('文件占用');}});
    assert.throws(()=>broken.save(p),/文件占用/);
    assert.equal(readdirSync(join(root,'回复记录')).filter(x=>x.endsWith('.json')).length,1);
    const result=new ReplyArchive({directory:root,...context}).save(p);
    assert.equal(result.status,'saved');assert.equal(read(join(root,'会话备份/_备份索引.json')).savedTurns,1);
  } finally {cleanup(root);}
});

test('不同运行保存在不同目录，同名会话不串轮',()=>{
  const root=mkdtempSync(join(tmpdir(),'doubao-archive-'));
  try {
    const a=join(root,'run-a'),b=join(root,'run-b');
    new ReplyArchive({directory:a,...context,runId:'run-a'}).save(make());
    const p=make();p.answer='另一轮';p.completion.answerHash=hash(p.answer);
    new ReplyArchive({directory:b,...context,runId:'run-b'}).save(p);
    assert.notEqual(read(join(a,'会话备份/M01.json')).messages[1].text,read(join(b,'会话备份/M01.json')).messages[1].text);
  } finally {cleanup(root);}
});

test('不安全文件名、重复消息编号及已损坏的本地记录阻止新增提交',()=>{
  const root=mkdtempSync(join(tmpdir(),'doubao-archive-'));
  try {
    const archive=new ReplyArchive({directory:root,...context});assert.throws(()=>archive.save(make(1,'../escape')),/文件名/);
    archive.save(make());const duplicate=make(2);duplicate.completion.userMessageId='u1';
    assert.throws(()=>archive.save(duplicate),/重复记录/);
    assert.equal(existsSync(join(root,'回复记录/S2_001.json')),false);
    writeFileSync(join(root,'回复记录/S1_001.json'),'{damaged','utf8');
    assert.throws(()=>archive.save(make(2)));assert.equal(existsSync(join(root,'回复记录/S2_001.json')),false);
  } finally {cleanup(root);}
});
