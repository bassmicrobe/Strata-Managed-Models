import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChatHistory } from '../server/chat-history.mjs';

const messages = Array.from({length: 96}, (_, i) => ({id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `fact ${i}`}));
const tail = messages.slice(-40).map(({role, content}) => ({role, content}));
const reference = {rev: 7, startId: 'm56', endId: 'm95'};
const store = rows => ({read: async () => JSON.stringify({rev: 7, session: {messages: rows}})});

test('saved history restores all older turns without duplicating the new question', async () => {
  const chatStore = store([...messages, {id:'next', role:'user',content:'new question'}, {id:'reply',role:'assistant',content:''}]);
  const result = await resolveChatHistory({chatStore, chatId:'chat', history:tail, reference});
  assert.equal(result.length, 96);
  assert.equal(result[0].content,'fact 0');
  assert.equal(result.at(-1).content,'fact 95');
  assert.equal(result.some(m => m.content === 'new question'),false);
});
test('revision and range mismatches are visible failures, never stale history', async () => {
  for (const ref of [{...reference,rev:6},{...reference,startId:'missing'},{...reference,endId:'m94'}]) {
    await assert.rejects(resolveChatHistory({chatStore:store(messages),chatId:'chat',history:tail,reference:ref}), /saved chat changed/);
  }
});
test('older pictures are explicit placeholders and recent image content is preserved', async () => {
  const stored = structuredClone(messages); stored[0].photos = [{name:'private.png',data:'pixels'}];
  const recent = structuredClone(tail); recent[0].content = [{type:'text',text:'fact 56'},{type:'image_url',image_url:{url:'data:image/png;base64,x'}}];
  const result = await resolveChatHistory({chatStore:store(stored),chatId:'chat',history:recent,reference});
  assert.match(result[0].content,/pixels are not included/);
  assert.deepEqual(result[56],recent[0]);
  assert.equal(JSON.stringify(result).includes('private.png'),false);
});
test('local notices and time-skip branches never enter the canonical prefix', async () => {
  const stored = [...messages.slice(0,30),{id:'local',role:'assistant',content:'notice',local:true},{id:'branch',role:'user',content:'other',timeSkipId:'fork'},...messages.slice(30)];
  const result=await resolveChatHistory({chatStore:store(stored),chatId:'chat',history:tail,reference});
  assert.equal(result.length,96);
  assert.equal(result.some(m=>m.content==='notice'||m.content==='other'),false);
});
test('external clients may still supply full history without a stored reference', async () => {
  assert.equal(await resolveChatHistory({history:messages}),messages);
});
