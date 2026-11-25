import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Library, check, policies, settings } from './store.mjs';
import { subscriptionReply } from './codex.mjs';
import { ReferenceLibrary } from './reference-library.mjs';
import { keyStore } from './openrouter-key.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const readString = (v, max = 160000) => {
  check(typeof v === 'string' && v.length <= max, '文字为空或超出长度限制');
  return v;
};
const specialties = {
  Claude: '你是文书主编。先回应作者这一轮的具体问题。审阅学术叙事时，结合项目题目和稿中原句，检查读者能否理解作者遇到的问题、亲自作出的选择和下一步研究兴趣。需要取舍时，说明改动会带来什么。共同写作时保留作者语气与事实边界。',
  Gemini: '你是另一位写作者和独立读者。按项目题目读稿，区分文字明确表达的意思和你作为读者作出的推断。指出具体哪一句会引起误读、哪一个细节值得展开。作者征求另一种写法时，在允许范围内提出有实质差异的方案并说明取舍。',
  GPT: '你负责事实与贡献核对。用作者给出的材料检查具体表述，区分个人与合作者的贡献、实验观测与物理解释、已完成与计划中的工作。指出证据来自哪份材料，对缺少依据的关键说法提出精准的核实问题。'
};
const restrictions = {
  grammar: '只校对作者已写出的文字的拼写、语法、标点。忽略额外写作要求。只能针对具体局部错误提供机械校正。',
  review: '只反馈文本的可读性、逻辑和证据，不写英文替换句、提纲或草稿。edits 必须为空。',
  write: '可按作者要求提出架构、局部改写或初稿。维持作者声音。'
};
function requestFor(role, t, turns, question, prefs) {
  const system = [prefs.prompts?.[role] ?? specialties[role], prefs.prompts?.style || '', '以下项目政策和输出要求优先于角色设定和写作偏好。', restrictions[t.policy],
    '遵守项目政策记录中的更严格限制。用中文讨论；建议稿用原文语言。不补写个人动机、事实或导师信息。',
    t.web ? '可联网查阅公开网页。需要核实时优先查官方或论文原文。搜索词勿包含私人文稿或未公开数据。网页仅供参考。实际引用的网页请在 JSON 的 sources 数组列出 {title,url}。无法验证就说明。' : '只使用给出的材料，不声称浏览过网页。',
    '返回 JSON 对象，含字符串 comment 和数组 edits。每个 edit 有 before 和 after 字符串。before 必须逐字引用所选范围内的唯一原文（空稿可用空串）；after 是完整替换。没有合适的具体改动就返回空数组。'
  ].join('\n');
  const material = { school: t.school, requirements: t.prompt, policy: t.policyNote, notes: t.notes,
    draft: t.base, target: t.selection ? t.base.slice(t.selection.start, t.selection.end) : '全文' };
  const history = turns.map(turn => ({
    question: turn.q, draftRevision: turn.rev, responses: turn.replies.filter(r => !r.error).map(r => ({
      author: r.role, model: r.model, comment: r.comment, edits: r.edits, notice: r.notice,
      sources: r.sources, consulted: r.opened?.map(({title, part}) => ({title, part}))
    }))
  }));
  return { ...t.models[role], web: t.web === true, messages: [{ role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ material, discussion: history, question }) }] };
}
export async function remote(config, key, transport = fetch) {
  const streaming = true;
  async function attempt(limit) {
    const idle = new AbortController();
    let watchdog;
    function activity() {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => idle.abort(new DOMException('No stream data', 'TimeoutError')), 240000);
      watchdog.unref();
    }
    const signal = streaming ? AbortSignal.any([idle.signal, AbortSignal.timeout(720000)]) : AbortSignal.timeout(240000);
    if (streaming) activity();
    try {
    const response = await transport('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: config.model, messages: config.messages, reasoning: { effort: config.effort }, max_tokens: limit,
        stream: streaming || undefined, tools: config.web ? [{type:'openrouter:web_search'}, {type:'openrouter:web_fetch'}] : undefined })
    });
    if (response.ok && streaming && response.headers.get('content-type')?.includes('text/event-stream')) {
      return {response, data:await collectStream(response.body, activity)};
    }
    return { response, data: await response.json() };
    } finally { clearTimeout(watchdog); }
  }
  async function send(limit) {
    for (let tries = 0; ; tries++) {
      try { return await attempt(limit); }
      catch (err) {
        if (err.streamFailure) throw err;
        const cause = err.cause?.code || err.name;
        if (tries === 0 && ['EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','ECONNREFUSED'].includes(cause)) continue;
        throw new Error('OpenRouter 请求未取得完整回复（' + cause + '）。' +
          (err.name === 'TimeoutError' ? '等待时间已到，上游可能已计费，请先核对 OpenRouter Activity。' : err.name === 'SyntaxError' ? '服务返回了无法解析的响应。' : ['UND_ERR_SOCKET','ECONNRESET'].includes(cause) ? '连接意外断开，无法判断是代理还是上游中断。上游可能已计费，请先核对用量，再单独重试。' : '请检查网络或代理后重试。'));
      }
    }
  }
  let creditLimit;
  let { response, data } = await send();
  if (response.status === 402) {
    const affordable = Number(data.error?.message?.match(/can only afford ([\d,]+)/i)?.[1]?.replaceAll(',', ''));
    if (Number.isSafeInteger(affordable) && affordable >= 256) {
      creditLimit = Math.floor(affordable * 0.95);
      ({ response, data } = await send(creditLimit));
    }
  }
  check(response.status !== 402 && data.error?.code !== 402,
    'OpenRouter 402 · 可用额度不足以完成本次请求。检查账户余额或密钥限额后，可在这条讨论中重试。', 502);
  check(response.ok && !data.error, 'OpenRouter ' + (data.error?.code || response.status) + ' · ' +
    (data.error?.message || '请求失败').slice(0, 450), 502);
  const raw = data.choices?.[0]?.message?.content;
  const truncated = data.interrupted || data.choices?.[0]?.finish_reason === 'length';
  const limitNote = data.interrupted || (creditLimit ? '本次根据 OpenRouter 返回的可用额度，输出预算设为 ' + creditLimit + ' tokens。' : '服务商报告本轮达到长度上限。');
  if (truncated && !(typeof raw === 'string' && raw.trim())) {
    throw new Error(limitNote + ' 本轮未返回可显示的正文。');
  }
  check(typeof raw === 'string' && raw.trim(), '模型没有返回文字，请重试。', 502);
  let parsed;
  try { parsed = JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '')); } catch {}
  if (truncated) {
    const quotedComment = raw.match(/"comment"\s*:\s*("(?:[^"\\]|\\.)*")/s);
    let partial = parsed?.comment;
    if (!partial && quotedComment) { try { partial = JSON.parse(quotedComment[1]); } catch {} }
    return { comment: partial || raw, edits: [], notice: limitNote + ' 已保留返回的文字，可以在本讨论中继续追问。' };
  }
  const result = typeof parsed?.comment === 'string' || Array.isArray(parsed?.read) ? parsed : { comment: raw, edits: [] };
  const citations = data.choices?.[0]?.message?.annotations?.filter(a => a.type === 'url_citation').map(a => a.url_citation);
  if (citations?.length) result.sources = citations;
  return result;
}
async function collectStream(body, activity) {
  let buffer = '', content = '', id = '', finish = null, done = false;
  const annotations = [];
  function line(raw) {
    if (!raw.startsWith('data:')) return;
    const payload = raw.slice(5).trim();
    if (payload === '[DONE]') { done = true; return; }
    const event = JSON.parse(payload);
    id ||= event.id || '';
    if (event.error) throw new Error('上游错误 ' + (event.error.code || ''));
    const choice = event.choices?.[0];
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (choice?.delta?.annotations) annotations.push(...choice.delta.annotations);
    if (choice?.finish_reason === 'error') throw new Error('上游生成中断');
    finish = choice?.finish_reason || finish;
  }
  let interrupted;
  try {
    for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
      activity();
      const lines = (buffer + chunk).split('\n');
      buffer = lines.pop();
      for (const raw of lines) line(raw);
      if (done) break;
    }
    if (buffer.trim() && !done) line(buffer);
    if (!finish && !done) throw new Error('连接提前关闭');
  } catch (err) {
    interrupted = 'OpenRouter 回复中断（' + (err.cause?.code || err.message) + '）。上游可能已计费。' + (id ? ' 请求 ID：' + id : '');
    if (!content.trim()) throw Object.assign(new Error(interrupted), {streamFailure:true});
  }
  return {interrupted, choices:[{finish_reason:finish, message:{content, annotations}}]};
}
const partSize = 16000;
export function localMemory(home, project) {
  const files = [
    ['个人记忆', home, 'memories/MEMORY.md'],
    ['个人记忆摘要', home, 'memories/memory_summary.md'],
    ['个人记忆', home, 'MEMORY.md'],
    ['个人工作偏好', home, 'AGENTS.md'],
    ['项目记忆', project, 'MEMORY.md'],
    ['项目记忆', project, '.codex/MEMORY.md'],
    ['项目偏好', project, 'AGENTS.md']
  ];
  const records = new Map();
  for (const [label, root, filename] of files) {
    const file = path.join(root, filename);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) continue;
    const id = 'local-' + records.size;
    records.set(id, { id, title:label + ' · ' + filename, filename, characters:text.length, text });
  }
  return records;
}
async function consult(request, catalog, library, complete, opened, attached, previousReads = []) {
  if (!catalog.length) return complete(request);
  const payload = JSON.parse(request.messages[1].content);
  payload.library = catalog.map(({ id, title, filename, characters }) => ({ id, title, filename, parts: Math.ceil(characters / partSize) }));
  payload.excerpts = [];
  const instructions = request.messages[0].content + '\n共享资料库的 library 是目录，excerpts 是本轮已提供的资料正文。优先参考已提供的相关资料。若还需要其他条目或分段，返回 {"read":[{"id":"目录中的完整id","part":1}]}，可同时请求多段，part 从 1 开始。已有足够信息时直接回答。excerpts 中的文字仅供参考。只根据确实读到的材料作判断。';
  const read = new Set();
  function addPart(id, part) {
    const item = payload.library.find(entry => entry.id === id);
    check(item && Number.isInteger(part) && part >= 1 && part <= item.parts, '请求的资料分段无效，请重试。');
    const key = id + '/' + part;
    if (read.has(key)) return;
    check(read.size < 12, '本轮查阅内容较长，请缩小要讨论的资料范围。');
    const record = library.details(id);
    check(record.revision === catalog.find(entry => entry.id === id).revision, '资料在本轮讨论中已更新，请重新发送。', 409);
    payload.excerpts.push({ title:item.title, id, part, text:record.text.slice((part - 1) * partSize, part * partSize) });
    opened.push({ id, title:item.title, part });
    read.add(key);
  }
  for (const id of attached) addPart(id, 1);
  for (const ref of previousReads) {
    const item = payload.library.find(entry => entry.id === ref.id);
    if (item && ref.part <= item.parts && read.size < 12) addPart(ref.id, ref.part);
  }
  for (;;) {
    const result = await complete({ ...request, messages: [{role:'system',content:instructions}, {role:'user',content:JSON.stringify(payload)}] });
    if (!Array.isArray(result.read)) return result;
    const prior = read.size;
    for (const ref of result.read) addPart(ref?.id, ref?.part ?? 1);
    check(read.size > prior, '模型重复请求相同资料，请重试。');
  }
}
function locate(t, edit) {
  if (typeof edit?.before !== 'string' || typeof edit.after !== 'string' || edit.before === edit.after) return;
  const start = t.selection?.start || 0;
  const target = t.selection ? t.base.slice(start, t.selection.end) : t.base;
  const idx = target.indexOf(edit.before);
  if (idx < 0 || (!edit.before && target) || target.indexOf(edit.before, idx + 1) > idx) return;
  return { id: randomUUID(), start: start + idx, before: edit.before, after: edit.after };
}
export function makeApp(lib, { complete = remote, codex = subscriptionReply, initialKey = process.env.OPENROUTER_API_KEY || '', credentials, verifyKey = fetch } = {}) {
  let key = initialKey;
  const pending = new Set();
  const library = new ReferenceLibrary(lib.root);
  async function api(route, b) {
    if (route === 'boot') {
      const p = lib.prefs();
      const legacyNames = ['cv', 'facts'].filter(k => p[k]?.trim());
      return { projects: lib.list(), models: p.models, prompts: p.prompts, gptRoute: p.gptRoute, legacyNames, references: library.list(), defaultPrompts: specialties, connected: Boolean(key) };
    }
    if (route === 'legacyReference') {
      check(['cv', 'facts'].includes(b.field), '旧资料不存在', 404);
      return { text: lib.prefs()[b.field] || '' };
    }
    if (route === 'references') return library.list();
    if (route === 'referenceAdd') return library.add(b);
    if (route === 'referenceRead') return library.details(b.ref);
    if (route === 'referenceUpdate') return library.update(b);
    if (route === 'referenceRemove') { library.remove(b.ref); return {}; }
    if (route === 'settings') {
      const prompts = b.prompts && Object.fromEntries([...Object.keys(specialties), 'style'].map(k => [k, readString(b.prompts[k], 16000)]));
      const newKey = b.key && readString(b.key, 500).trim();
      if (newKey) {
        let response;
        try {
          response = await verifyKey('https://openrouter.ai/api/v1/key', {
            headers:{Authorization:'Bearer ' + newKey}, redirect:'error', signal:AbortSignal.timeout(15000)
          });
        } catch { check(false, '暂时无法连接 OpenRouter 验证新密钥，请稍后重试。', 502); }
        check(response.ok, response.status === 401 || response.status === 403 ? 'OpenRouter 未接受这把密钥，请检查后重试。' : 'OpenRouter 暂时无法验证新密钥，请稍后重试。', 400);
      }
      lib.configure(b.models, { beforeModels: b.beforeModels, beforePrompts: b.beforePrompts, prompts });
      if (newKey) {
        try { credentials?.save(newKey); }
        catch { check(false, '无法保存到当前 Windows 用户，请检查本机存储后重试。', 500); }
        key = newKey;
      }
      return { connected: Boolean(key) };
    }
    if (route === 'create') return { id: lib.create({ name: b.name, kind: b.kind, text: readString(b.text || '') }) };
    const d = lib.get(b.id);
    if (route === 'deleteThread') {
      check(!pending.has(b.thread), '请等这条讨论的回复完成后再删除。', 409);
      lib.update(d.id, p => { p.threads = p.threads.filter(t => t.id !== b.thread); });
      return {};
    }
    if (route === 'switchModels') {
      check(!pending.has(b.thread), '请等当前回复完成后再切换', 409);
      const models = settings(b.models);
      lib.update(d.id, p => {
        const t = p.threads.find(t => t.id === b.thread);
        check(t && JSON.stringify(t.models) === JSON.stringify(b.before), '讨论配置已变更，请重新载入。', 409);
        t.models = models;
      });
      return {};
    }
    if (route === 'get') return d;
    if (route === 'save') return { rev: lib.save(d.id, b.rev, readString(b.text)) };
    if (route === 'brief') {
      check(policies.includes(b.policy), '请选择 AI 使用范围');
      lib.update(d.id, p => {
        for (const k of ['prompt', 'notes', 'policyNote', 'policy']) {
          check(p[k] === b.before?.[k], '项目资料已在别处修改，请重新载入。', 409);
          p[k] = readString(b[k]);
        }
      });
      return {};
    }
    if (route === 'apply') {
      const t = d.threads.find(t => t.id === b.thread);
      check(t && d.policy === t.policy && d.policyNote === t.policyNote && ['write', 'grammar'].includes(d.policy), '当前项目范围不支持采纳这条改动');
      const entries = t.turns.map(turn => ({ base: turn.base ?? t.base, edits: turn.replies.flatMap(r => r.edits || []) }));
      const source = entries.find(x => x.edits.some(e => e.id === b.edit));
      const e = source?.edits.find(e => e.id === b.edit);
      check(e && !e.accepted, '建议已处理或不存在');
      // Earlier accepted non-overlapping edits in this thread may shift an anchor.
      const accepted = entries.filter(x => x.base === source.base).flatMap(x => x.edits.filter(e => e.accepted))
        .sort((a, b) => a.start - b.start);
      let expected = source.base;
      for (const a of [...accepted].reverse()) expected = expected.slice(0, a.start) + a.applied + expected.slice(a.start + a.before.length);
        check(b.rev === d.rev, '磁盘正文已更新，请先同步正文，再采纳这条建议。', 409);
      check(accepted.every(a => a.start !== e.start && (a.start + a.before.length <= e.start || e.start + e.before.length <= a.start)), '这处原文已经采纳过其他建议。', 409);
        let pos = e.start + accepted.filter(a => a.start < e.start).reduce((n, a) => n + a.applied.length - a.before.length, 0);
        if (d.text !== expected) {
          check(e.before && source.base.indexOf(e.before) === source.base.lastIndexOf(e.before),
            '原稿中的位置无法唯一确定，请选中当前段落重新获取建议。', 409);
          pos = d.text.indexOf(e.before);
          check(pos >= 0, '这条建议引用的原文已经改动，请选中当前段落重新获取建议。', 409);
          check(pos === d.text.lastIndexOf(e.before), '当前稿有多处相同原文，请选中目标段落重新获取建议。', 409);
        }
      const applied = readString(b.after);
      const text = d.text.slice(0, pos) + applied + d.text.slice(pos + e.before.length);
      const rev = lib.save(d.id, d.rev, text);
      lib.update(d.id, p => {
        const edit = p.threads.find(v => v.id === t.id).turns.flatMap(v => v.replies.flatMap(r => r.edits || [])).find(v => v.id === e.id);
        Object.assign(edit, { accepted: Date.now(), applied });
      });
      return { text, rev };
    }
    check(route === 'ask', '接口不存在', 404);
    check(b.who === 'GPT' || key, 'Claude 和 Gemini 需要在模型设置中连接 OpenRouter。');
    check(d.policy !== 'off', '请在项目资料中按学校要求设置 AI 使用范围。');
    check(['Claude', 'Gemini', 'GPT', 'pair'].includes(b.who), '请选择协作者');
    let t = d.threads.find(t => t.id === b.thread);
    const retry = b.retryTurn ? t?.turns.find(turn => turn.id === b.retryTurn) : null;
    const failed = retry?.replies.find(r => r.role === b.who && r.error);
    if (b.retryTurn) check(['Claude', 'Gemini'].includes(b.who) && failed, '这条回复已处理或不存在。', 409);
    const q = retry ? retry.q : d.policy === 'grammar' ? '请检查目标文本的拼写、语法和标点。' : readString(b.question, 16000).trim();
    check(q, '请输入讨论问题');
    const prefs = lib.prefs();
    const catalog = library.list();
    const attached = retry ? retry.attached ?? [...new Set((failed.opened || []).map(r => r.id))].filter(id => catalog.some(r => r.id === id)) : b.attached ?? [];
    check(Array.isArray(attached) && attached.length <= 12 && attached.every(id => catalog.some(r => r.id === id)), '请重新选择本轮资料，最多可附 12 份。');
    check(b.rev === d.rev || (b.thread && b.rev === undefined), '文稿已在其他窗口更新，请重新载入再发送。', 409);
    const s = b.selection;
    if (s) check(Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end > s.start && s.end <= d.text.length, '选区已变化');
    if (b.thread) check(t && b.who !== 'pair', '独立双评需要新讨论。');
    if (!t) {
      check(b.rev === d.rev, '文稿版本已变化，请先刷新。', 409);
      t = { id: randomUUID(), school: d.name, policy: d.policy, policyNote: d.policyNote, prompt: d.prompt,
        notes: d.notes, models: prefs.models, base: d.text, rev: d.rev,
        selection: s || null, created: Date.now(), title: q.slice(0, 55), turns: [] };
      lib.update(d.id, p => p.threads.push(t));
    }
    check(t.policy === d.policy && t.policyNote === d.policyNote, '项目使用范围已变更，请新开讨论。');
    check(!pending.has(t.id), '这条讨论正在等待模型回复。', 409);
    pending.add(t.id);
    try {
      const current = { ...t, web: (retry ? retry.web : b.web) === true && ['review','write'].includes(d.policy), base: retry ? retry.base ?? t.base : d.text, selection: retry ? retry.selection ?? null : s || null, notes: retry ? retry.notes ?? t.notes : d.notes, prompt: retry ? retry.prompt ?? t.prompt : d.prompt };
      const turn = { id: randomUUID(), q, created: Date.now(), replies: [], rev: d.rev, selection: current.selection, attached, web:current.web, notes:current.notes, prompt:current.prompt };
      if (d.text !== t.base) turn.base = d.text;
      const workers = b.who === 'pair' ? ['Claude', 'Gemini'] : [b.who];
      turn.replies = await Promise.all(workers.map(async role => {
        const model = retry ? {model:failed.model, effort:failed.effort} : t.models[role];
        const provider = role === 'GPT' ? 'ChatGPT · Codex' : 'OpenRouter';
        const opened = [];
        try {
          const request = requestFor(role, current, retry ? t.turns.slice(0,t.turns.indexOf(retry)) : t.turns, q, prefs);
          Object.assign(request, model);
          const useMemory = role === 'GPT' && b.memory === true && ['review','write'].includes(d.policy);
          const memory = useMemory ? localMemory(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), lib.root) : new Map();
          if (useMemory) request.messages[0].content += '\n可按需查阅目录中的个人和项目记忆、工作偏好。记忆用于定位线索，核实科研贡献应以原始证据为准。偏好仅按其适用范围使用。缺少依据时明确说明。';
          const result = await consult(request, [...catalog, ...memory.values()], {details:id => memory.get(id) ?? library.details(id)}, role === 'GPT' ? codex : req => complete(req, key), opened, attached, failed?.opened);
          const edits = t.policy === 'review' || !Array.isArray(result.edits) ? [] : result.edits.map(e => locate(current, e)).filter(Boolean);
          const sources = current.web && Array.isArray(result.sources) ? result.sources.filter(s => typeof s?.url === 'string' && /^https?:\/\//i.test(s.url)).map(s => ({title:String(s.title || s.url),url:s.url})) : [];
          return { role, provider, ...model, opened, sources, comment: result.comment, notice: result.notice, edits };
        } catch (err) {
          const message = err.message || '请求失败';
          return { role, provider, ...model, opened, error: (key ? message.replaceAll(key, '[key]') : message).slice(0, 600), edits: [] };
        }
      }));
      lib.update(d.id, p => {
        const turns = p.threads.find(v => v.id === t.id).turns;
        if (!retry) { turns.push(turn); return; }
        const replies = turns.find(v => v.id === retry.id).replies;
        replies[replies.findIndex(r => r.role === b.who)] = turn.replies[0];
      });
      return { thread: t.id };
    } finally { pending.delete(t.id); }
  }
  return http.createServer(async (req, res) => {
    const answer = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(body);
    };
    try {
      const host = '127.0.0.1:' + req.socket.localPort;
      check(req.headers.host === host || req.headers.host === 'localhost:' + req.socket.localPort, '仅本机访问', 403);
      const url = new URL(req.url, 'http://' + host);
      if (url.pathname.startsWith('/api/')) {
        check(req.method === 'POST' && req.headers['x-folio'] === '1' &&
          (!req.headers.origin || req.headers.origin === 'http://' + req.headers.host), '无效的请求来源', 403);
        const chunks = []; let size = 0;
        const maxBody = url.pathname === '/api/referenceAdd' ? 22 * 1024 * 1024 :
          url.pathname === '/api/referenceUpdate' ? 7 * 1024 * 1024 : 2500000;
        for await (const chunk of req) { size += chunk.length; check(size <= maxBody, '内容过长', 413); chunks.push(chunk); }
        const result = await api(url.pathname.slice(5), JSON.parse(Buffer.concat(chunks).toString() || '{}'));
        return answer(200, 'application/json; charset=utf-8', JSON.stringify(result));
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/marked.esm.js': ['marked.esm.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/folio.svg': ['folio.svg', 'image/svg+xml'] };
      check(Object.hasOwn(assets, url.pathname) && req.method === 'GET', '页面不存在', 404);
      const [file, type] = assets[url.pathname];
      answer(200, type + '; charset=utf-8', fs.readFileSync(path.join(here, 'public', file)));
    } catch (err) {
      answer(err.status || 500, 'application/json; charset=utf-8', JSON.stringify({ error: err.status ? err.message : '本地读写失败，请检查文件和服务。' }));
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.FOLIO_DATA || path.join(os.homedir(), '.folio', 'data');
  const lib = new Library(root);
  const port = Number(process.env.FOLIO_PORT || 43827);
  const credentials = process.platform === 'win32' ? keyStore(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Folio')) : undefined;
  const initialKey = credentials?.load(process.env.OPENROUTER_API_KEY || '') ?? process.env.OPENROUTER_API_KEY ?? '';
  makeApp(lib, {initialKey, credentials}).listen(port, '127.0.0.1', () => console.log('Folio · http://127.0.0.1:' + port));
}
