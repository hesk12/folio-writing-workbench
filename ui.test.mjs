import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const room = source.slice(source.indexOf('function drawRoom()'), source.indexOf('function propose('));
const send = source.slice(source.indexOf("$('#send').onclick ="), source.indexOf('question.onkeydown ='));

function fixture() {
  const noop = () => {};
  const element = () => ({dataset:{}, setAttribute:noop, querySelector:() => null, querySelectorAll:() => []});
  const roles = ['Claude','Gemini','GPT'].map(role => ({...element(), dataset:{role}, querySelector:() => ({})}));
  // A rendered failed reply has a role but no <strong>, unlike a model picker.
  const retry = {...element(), dataset:{role:'Claude',retry:'turn'}};
  const nodes = new Map();
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  $('#discussion').firstElementChild = {...element(), dataset:{threadId:'thread'}, scrollTop:12};
  $('#discussion').querySelectorAll = selector => selector === '[data-retry]' ? [retry] : [];
  const models = Object.fromEntries(roles.map(r => [r.dataset.role,{model:'fixture',effort:'high'}]));
  const thread = {id:'thread',title:'Test', models, turns:[{id:'turn',q:'Question',replies:[{role:'Claude',error:'Interrupted'}]}]};
  const calls = [];
  const context = vm.createContext({
    $, all:selector => selector === '.rolelist [data-role]' ? roles : selector === '[data-role]' ? [...roles,retry] : [],
    activeThread:() => thread, showTarget:noop, drawQuotes:noop, quoteReply:{}, replyQuote:null,
    doc:{id:'project',rev:'rev',policy:'write'}, boot:{connected:true,models}, choices:{Claude:{},Gemini:{},GPT:{}},
    who:'Claude',busy:false,briefDirty:false,briefForm:{querySelector:() => ({})},
    question:{value:'Go ahead',focus:noop}, quotes:[{source:'正文',text:'Draft',note:'Keep this annotation'}],
    attached:new Set(), selection:null, threadId:'thread',
    outdatedPolicy:() => false, esc:String, messageBody:String, view:noop, toast:noop,
    api:async (route, body) => { calls.push({route,body}); return {thread:'thread'}; },
    refreshHistory:async () => {thread.turns.at(-1).replies = [{role:'Claude',comment:'Done'}];},
    flush:async () => {}, questionKey:() => 'question', roomKey:() => 'room',
    sessionStorage:{setItem:noop,removeItem:noop}, rememberQuestion:noop,saveQuotes:noop,drawAttachments:noop,
  });
  vm.runInContext(room + '\n' + send, context);
  return {context, $, retry, calls};
}

test('failed reply retry controls do not break redraw or normal send', async () => {
  const {context,$,calls} = fixture();
  vm.runInContext('drawRoom(); drawRoom();', context);
  await $('#send').onclick();
  assert.equal(calls.length,1);
  assert.equal(calls[0].route,'ask');
  assert.match(calls[0].body.question,/Keep this annotation/);
  assert.equal(context.busy,false);
  assert.equal($('#send').disabled,false);
  assert.equal(context.quotes.length,0);
});

test('retry reaches the original turn and restores controls', async () => {
  const {context,retry,$,calls} = fixture();
  vm.runInContext('drawRoom()',context);
  await retry.onclick();
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.retryTurn,'turn');
  assert.equal(calls[0].body.who,'Claude');
  assert.equal(context.busy,false);
  assert.equal($('#send').disabled,false);
  assert.equal(context.quotes[0].note,'Keep this annotation');
});

for (const action of ['send','retry']) test(`${action} releases busy state if rendering fails before the request`, async () => {
  const {context,$,retry,calls} = fixture();
  vm.runInContext('drawRoom()', context);
  let fail = true;
  context.showTarget = () => { if (fail) {fail=false; throw new Error('Render failed');} };
  await assert.rejects(action === 'send' ? $('#send').onclick() : retry.onclick(), /Render failed/);
  assert.equal(calls.length,0);
  assert.equal(context.busy,false);
  assert.equal($('#send').disabled,false);
  assert.equal(context.question.value,'Go ahead');
  assert.equal(context.quotes[0].note,'Keep this annotation');
});
