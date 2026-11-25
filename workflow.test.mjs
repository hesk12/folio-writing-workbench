import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { makeApp, remote, localMemory } from './server.mjs';
import { Library } from './store.mjs';
import { keyStore } from './openrouter-key.mjs';

test('local memory is limited to personal and project files and picks up edits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-memory-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const home = path.join(root,'personal'), project = path.join(root,'project');
  fs.mkdirSync(path.join(home,'memories'),{recursive:true});
  fs.mkdirSync(path.join(home,'automations','other'),{recursive:true});
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(home,'automations','other','memory.md'),'excluded');
  fs.writeFileSync(path.join(home,'memories','MEMORY.md'),'personal note');
  fs.writeFileSync(path.join(project,'AGENTS.md'),'project preferences');
  assert.deepEqual([...localMemory(home,project).values()].map(r => r.text), ['personal note','project preferences']);
  fs.writeFileSync(path.join(home,'memories','MEMORY.md'),'updated');
  assert.equal([...localMemory(home,project).values()][0].text, 'updated');
});

test('Folio loads the saved Windows credential on restart and keeps it on an empty or rejected replacement', {skip:process.platform !== 'win32'}, async ctx => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-credential-test-'));
  ctx.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const credentials = keyStore(dir);
  const lib = new Library(path.join(dir, 'library'));
  const old = 'old-fixture', next = 'new-fixture';
  assert.equal(credentials.load(old), old);
  const app = makeApp(lib, {initialKey:old, credentials, verifyKey:async (_url, opts) =>
    new Response(null, {status: opts.headers.Authorization === 'Bearer ' + next ? 200 : 401})});
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  ctx.after(() => new Promise(resolve => app.close(resolve)));
  const set = key => fetch('http://127.0.0.1:' + app.address().port + '/api/settings', {
    method:'POST', headers:{'X-Folio':'1','Content-Type':'application/json'}, body:JSON.stringify({models:lib.prefs().models, key})
  });
  assert.equal((await set(next)).status, 200);
  assert.equal((await set('')).status, 200);
  assert.equal((await set('rejected')).status, 400);
  assert.equal(keyStore(dir).load(old), next);
  assert.ok(!fs.readFileSync(path.join(dir,'openrouter.dpapi'),'utf8').includes(next));
});

test('OpenRouter uses provider defaults and preserves partial replies when truncated', async () => {
  const config = {model:'google/gemini-4-carbon', effort:'high', messages:[]};
  const calls = [];
  const transport = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) return Response.json({error:{message:'can only afford 2000'}}, {status:402});
    return Response.json({choices:[{finish_reason:'length',message:{content:'{"comment":"First point","edits":['}}]});
  };
  const partial = await remote(config, 'dummy', transport);
  assert.equal(Object.hasOwn(calls[0], 'max_tokens'), false);
  assert.equal(calls[1].max_tokens, 1900);
  assert.match(partial.notice, /1900/);
  assert.equal(partial.comment, 'First point');
  assert.deepEqual(partial.edits, []);
  await assert.rejects(remote(config, 'dummy', async () => Response.json({choices:[{finish_reason:'length',message:{content:''}}]})), /服务商报告.*未返回/);
});

test('OpenRouter models preserve streamed text and never repeat interrupted generations', async () => {
  for (const model of ['google/gemini-4-carbon', 'anthropic/claude-fable-5.2']) {
  const config = {model, effort:'high', messages:[]};
  for (const ending of ['complete','partial','reasoning','socket']) {
    let calls = 0;
    const result = remote(config,'fixture',async (_url, opts) => {
      calls++;
      assert.equal(JSON.parse(opts.body).stream,true);
      const delta = ending === 'reasoning' ? {reasoning:'internal'} : {content:'{"comment":"已收到","edits":[]}'};
      const event = JSON.stringify({id:'gen-fixture',choices:[{delta}]});
      const bytes = new TextEncoder().encode(': waiting\r\n\r\ndata: ' + event + '\r\n\r\n' + (ending === 'complete' ? 'data: [DONE]\n\n' : ''));
      let sent = false;
      return new Response(new ReadableStream({pull(c){
        if (!sent) { sent = true; c.enqueue(bytes); }
        else if (ending === 'socket') c.error(Object.assign(new Error('terminated'), {cause:{code:'UND_ERR_SOCKET'}}));
        else c.close();
      }}),{headers:{'Content-Type':'text/event-stream'}});
    });
    if (ending === 'reasoning') await assert.rejects(result,/可能已计费.*gen-fixture/);
    else {
      const reply = await result;
      assert.equal(reply.comment,'已收到');
      if (ending === 'partial' || ending === 'socket') {
        assert.match(reply.notice,/可能已计费/);
        assert.deepEqual(reply.edits, []);
      }
      else assert.equal(reply.notice,undefined);
    }
    assert.equal(calls,1);
  }
  }
});

test('Claude socket failure before headers is not silently billed again', async () => {
  let calls = 0;
  await assert.rejects(remote({model:'anthropic/claude-fable-5.2', messages:[]}, 'fixture', async () => {
    calls++;
    throw Object.assign(new Error('fetch failed'), {cause:{code:'UND_ERR_SOCKET'}});
  }), /UND_ERR_SOCKET.*可能已计费/);
  assert.equal(calls, 1);
});

test('Claude retry retains the original prompt and draft and replaces only its failed reply', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-claude-retry-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const lib = new Library(root);
  const id = lib.list()[0].id;
  lib.save(id, lib.get(id).rev, 'Original draft');
  lib.update(id, p => { p.policy = 'write'; });
  let failing = true;
  const requests = [];
  const app = makeApp(lib, {initialKey:'fixture', complete:async req => {
    requests.push(req);
    if (failing && req.model.startsWith('anthropic/')) throw new Error('UND_ERR_SOCKET');
    return {comment:'Complete', edits:[]};
  }});
  app.listen(0,'127.0.0.1');
  await once(app,'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  const api = async data => {
    const response = await fetch('http://127.0.0.1:' + app.address().port + '/api/ask', {
      method:'POST',headers:{'X-Folio':'1','Content-Type':'application/json'},body:JSON.stringify({id,...data})
    });
    return {status:response.status,data:await response.json()};
  };
  const first = await api({who:'pair',rev:lib.get(id).rev,question:'Original question'});
  const original = lib.get(id).threads[0].turns[0];
  const sibling = original.replies[1];
  lib.save(id,lib.get(id).rev,'Newer draft');
  failing = false;
  const count = requests.length;
  const retry = {who:'Claude',thread:first.data.thread,retryTurn:original.id};
  assert.equal((await api(retry)).status,200);
  assert.equal(requests.length,count+1);
  const packet = JSON.parse(requests.at(-1).messages[1].content);
  assert.equal(packet.question,'Original question');
  assert.equal(packet.material.draft,'Original draft');
  const turns = lib.get(id).threads[0].turns;
  assert.equal(turns.length,1);
  assert.equal(turns[0].replies[0].comment,'Complete');
  assert.deepEqual(turns[0].replies[1],sibling);
  assert.equal((await api(retry)).status,409);
});

test('independent reads, pinned handoff, accepted changes, external edits and policy limits', async ctx => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-test-'));
  const lib = new Library(root);
  const id = lib.list()[0].id;
  const inputs = [];
  let failGemini = false;
  const codexCalls = [];
  const app = makeApp(lib, { initialKey: 'test-key', codex: async req => {
    codexCalls.push(req);
    const p = JSON.parse(req.messages[1].content);
    if (p.library?.length && !p.excerpts.length) return {read:[{id:p.library.find(r => r.title === 'CV').id, part:1}]};
    return { comment: 'Review only.', edits: [] };
  }, complete: async req => {
    inputs.push(req);
    if (failGemini && req.model.startsWith('google/')) throw new Error('fetch failed');
    return { comment: 'Use a concrete subject.', edits: [
      { before: 'We', after: 'I' }, { before: 'ran', after: 'measured' }, { before: 'invented', after: 'new' }
    ] };
  }});
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  ctx.after(async () => { await new Promise(r => app.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.address().port;
  const api = async (route, b = {}) => {
    const r = await fetch(base + '/api/' + route, { method: 'POST', headers: { 'X-Folio': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...b }) });
    return { status: r.status, data: await r.json() };
  };
  const get = async () => (await api('get')).data;
  let d = await get();
  assert.equal((await api('ask', { rev: d.rev, who: 'pair', question: 'Read' })).status, 400);
  assert.equal(inputs.length, 0);
  await api('brief', { before: d, prompt: 'Study', policy: 'write', notes: '', policyNote: '' });
  await api('save', { rev: d.rev, text: 'We ran tests.' });
  d = await get();
  const pair = await api('ask', { rev: d.rev, who: 'pair', question: 'Read' });
  assert.equal(pair.status, 200);
  const thread = pair.data.thread;
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map(r => JSON.parse(r.messages[1].content).discussion), [[], []]);
  assert.equal(inputs[0].messages[1].content, inputs[1].messages[1].content);
  const old = lib.prefs().models; lib.configure({ ...old, Claude: { ...old.Claude, model: 'anthropic/claude-opus-5.5' } });
  await api('ask', { thread, who: 'Claude', question: 'Compare both' });
  assert.equal(inputs[2].model, old.Claude.model);
  assert.equal(JSON.parse(inputs[2].messages[1].content).discussion[0].responses.length, 2);
  d = await get();
  const edits = d.threads[0].turns[0].replies[0].edits;
  assert.equal(edits.length, 2);
  let accepted = await api('apply', { rev: d.rev, thread, edit: edits[0].id, after: 'The authors' });
  assert.equal(accepted.data.text, 'The authors ran tests.');
  accepted = await api('apply', { rev: accepted.data.rev, thread, edit: edits[1].id, after: 'repeated' });
  assert.equal(accepted.data.text, 'The authors repeated tests.');
  fs.writeFileSync(path.join(lib.dir(id), 'SOP.md'), 'External edit.');
  assert.equal((await api('save', { rev: accepted.data.rev, text: 'stale' })).status, 409);
  d = await get();
  await api('brief', { before: d, policy: 'review', prompt: d.prompt, notes: d.notes, policyNote: '' });
  assert.equal((await api('ask', { thread, who: 'Claude', question: 'Review' })).status, 400);
  await api('ask', { rev: d.rev, who: 'GPT', question: 'Review' });
  assert.equal(codexCalls.length, 1);
  assert.equal(inputs.length, 3);
  assert.equal((await get()).threads.at(-1).turns[0].replies[0].provider, 'ChatGPT · Codex');
  assert.deepEqual((await get()).threads.at(-1).turns[0].replies[0].edits, []);
  // Simulate revisions made after the first review, then hand the same history to another model.
  const reviewThread = (await get()).threads.at(-1).id;
  const profile = (await api('boot')).data;
  const prompts = { ...profile.defaultPrompts, GPT: 'Review attribution.', style: 'Keep the author’s voice.' };
  assert.equal((await api('settings', { models: profile.models, prompts })).status, 200);
  lib.shared('cv', undefined, 'Legacy CV stays private.');
  assert.deepEqual((await api('references')).data, []);
  const ref = (await api('referenceAdd', { title:'Old CV', text:'Prior synthetic CV.' })).data;
  const beforeRef = (await api('referenceRead', {ref:ref.id})).data;
  const revised = {ref:ref.id, revision:beforeRef.revision, title:'CV', text:'Verified synthetic CV.'};
  assert.equal((await api('referenceUpdate', revised)).status, 200);
  assert.equal((await api('referenceUpdate', revised)).status, 200);
  assert.equal((await api('referenceUpdate', {...revised, title:'Stale'})).status, 409);
  const other = (await api('referenceAdd', { title:'Notes', filename:'facts.md', data:Buffer.from('Separate source.').toString('base64') })).data;
  assert.equal((await api('referenceRead', {ref:other.id})).data.text, 'Separate source.');
  const uploaded = (await api('referenceRead', {ref:other.id})).data;
  assert.equal((await api('referenceUpdate', {ref:other.id, revision:uploaded.revision, title:'Notes', text:'  '})).status, 422);
  assert.equal((await api('referenceUpdate', {ref:other.id, revision:uploaded.revision, title:'Revised notes', text:'Current notes.'})).status, 200);
  assert.equal(fs.readFileSync(path.join(root, '资料库', other.id, '原件.md'), 'utf8'), 'Separate source.');
  const metadata = (await api('references')).data.find(r => r.id === other.id);
  assert.equal(metadata.title, 'Revised notes');
  assert.equal(metadata.characters, 'Current notes.'.length);
  assert.equal(metadata.text, undefined);
  const pinned = (await get()).threads.at(-1).models;
  const newModels = { ...pinned, GPT: { model: 'openai/gpt-6.2-astra', effort: 'high' } };
  assert.equal((await api('switchModels', { thread: reviewThread, before: pinned, models: newModels })).status, 200);
  const newRev = (await api('save', { rev: d.rev, text: 'Revised draft.' })).data.rev;
  assert.equal((await api('ask', { thread: reviewThread, rev: d.rev, who: 'GPT', question: 'Old version' })).status, 409);
  await api('ask', { thread: reviewThread, rev: newRev, selection: { start: 0, end: 7 }, who: 'GPT', question: 'Updated?' });
  const last = codexCalls.at(-1);
  assert.equal(last.model, newModels.GPT.model);
  assert.match(last.messages[0].content, /Review attribution/);
  assert.match(last.messages[0].content, /Keep the author/);
  assert.match(last.messages[0].content, /edits 必须为空/);
  const packet = JSON.parse(last.messages[1].content);
  assert.equal(packet.material.draft, 'Revised draft.');
  assert.equal(packet.material.target, 'Revised');
  assert.equal(packet.material.cv, undefined);
  assert.equal(packet.material.sharedFacts, undefined);
  assert.equal(packet.excerpts[0].text, 'Verified synthetic CV.');
  assert.equal(packet.library.length, 2);
  assert.ok(!JSON.stringify(packet).includes('Separate source.'));
  assert.ok(!JSON.stringify(packet).includes('Legacy CV stays private.'));
  assert.equal((await get()).threads.at(-1).turns.at(-1).replies[0].opened[0].id, ref.id);
  assert.equal(packet.discussion.length, 1);
  assert.equal(packet.discussion[0].responses[0].model, pinned.GPT.model);
  await api('ask', { thread: reviewThread, rev: newRev, who: 'Claude', question: 'Read the GPT review.' });
  const handoff = JSON.parse(inputs.at(-1).messages[1].content);
  assert.equal(handoff.material.cv, undefined);
  assert.equal(handoff.excerpts.length, 0);
  assert.equal(handoff.library.length, 2);
  assert.equal(handoff.discussion.at(-1).responses[0].author, 'GPT');
  assert.deepEqual(lib.prefs().models, profile.models);
  await api('ask', {rev:newRev, who:'pair', question:'Compare', attached:[other.id]});
  for (const call of inputs.slice(-2)) {
    assert.deepEqual(JSON.parse(call.messages[1].content).excerpts, [{id:other.id,title:'Revised notes',part:1,text:'Current notes.'}]);
  }
  assert.deepEqual(JSON.parse(inputs.at(-1).messages[1].content).library, JSON.parse(inputs.at(-2).messages[1].content).library);
  await api('referenceRemove', {ref:other.id});
  assert.equal((await api('referenceRead', {ref:other.id})).status,404);
  assert.equal((await api('referenceUpdate', {ref:other.id, revision:uploaded.revision, title:'Notes', text:'Restored?'})).status, 404);
  assert.deepEqual((await api('references')).data.map(r=>r.id),[ref.id]);
  // A proposal from a later revision anchors to that turn's text.
  d = await get();
  await api('brief', { before: d, policy: 'write', prompt: d.prompt, notes: '', policyNote: '' });
  const first = await api('ask', { rev: d.rev, who: 'Claude', question: 'Start' });
  const modified = await api('save', { rev: d.rev, text: 'Today We ran tests.' });
  await api('ask', { rev: modified.data.rev, thread: first.data.thread, who: 'Claude', question: 'And now?' });
  const freshEdit = (await get()).threads.at(-1).turns.at(-1).replies[0].edits[0];
  const applyFresh = rev => api('apply', { thread: first.data.thread, edit: freshEdit.id, rev, after:'I' });
  const duplicate = await api('save', { rev:modified.data.rev, text:'We saw that today We ran tests.' });
  assert.equal((await applyFresh(duplicate.data.rev)).status, 409);
  const moved = await api('save', {rev:duplicate.data.rev, text:'Earlier. Today We ran tests.'});
  assert.equal((await applyFresh(duplicate.data.rev)).status, 409);
  const applied = await applyFresh(moved.data.rev);
  assert.equal(applied.data.text, 'Earlier. Today I ran tests.');
  const beforeDeletion = await get();
  await api('deleteThread', {thread:first.data.thread});
  const afterDeletion = await get();
  assert.equal(afterDeletion.text, beforeDeletion.text);
  assert.deepEqual(afterDeletion.threads, beforeDeletion.threads.filter(t => t.id !== first.data.thread));
  assert.equal((await api('deleteThread', {thread:first.data.thread})).status, 200);
  failGemini = true;
  const pairId = (await api('ask', {rev:afterDeletion.rev, who:'pair', question:'Independent review'})).data.thread;
  const original = (await get()).threads.find(t => t.id === pairId).turns[0];
  assert.equal(original.replies[1].error, 'fetch failed');
  const count = inputs.length;
  failGemini = false;
  await api('save', {rev:afterDeletion.rev, text:'A newer version.'});
  const retry = {thread:pairId, retryTurn:original.id, who:'Gemini'};
  assert.equal((await api('ask', retry)).status, 200);
  assert.equal(inputs.length, count + 1);
  const packetAfterRetry = JSON.parse(inputs.at(-1).messages[1].content);
  assert.deepEqual(packetAfterRetry.discussion, []);
  assert.equal(packetAfterRetry.material.draft, afterDeletion.text);
  const recovered = (await get()).threads.find(t => t.id === pairId).turns;
  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0].replies[0], original.replies[0]);
  assert.ok(recovered[0].replies[1].comment);
  assert.equal((await api('ask', retry)).status, 409);
  const blocked = await fetch(base + '/api/boot', { method: 'POST' });
  assert.equal(blocked.status, 403);
});
