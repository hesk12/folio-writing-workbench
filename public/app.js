import { Marked } from './marked.esm.js';

const $ = sel => document.querySelector(sel);
const all = sel => [...document.querySelectorAll(sel)];
const esc = val => String(val ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const labels = { SOP: 'Statement of Purpose', PS: 'Personal Statement' };
const markdown = new Marked({ breaks:true, renderer:{
  html({text}) { return esc(text); },
  image({text}) { return esc(text); },
  link({href,tokens}) {
    const label = this.parser.parseInline(tokens);
    if (!/^https?:\/\//i.test(href)) return label;
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  }
}});
function messageBody(value) {
  return '<div class="messageBody">' + markdown.parse(String(value ?? '')) + '</div>';
}
const policyLabels = { off: 'AI 暂停', grammar: '语法校对', review: '独立反馈', write: '共同写作' };
let boot, doc, threadId = null, who = 'Claude', selection = null, tab = 'write', busy = false;
let timer, saving, toastTimer, modalAction, briefDirty = false;
const draft = $('#draft'), question = $('#question'), briefForm = $('#briefForm');
const cacheKey = id => 'folio.unsaved.' + id;
const activeThread = () => doc.threads.find(t => t.id === threadId);
const outdatedPolicy = t => t && (doc.policy !== t.policy || doc.policyNote !== t.policyNote);
const attached = new Set();
const roomKey = () => 'folio.room.' + doc.id;
const questionKey = () => 'folio.question.' + doc.id + '.' + (threadId || 'new');
const quoteKey = () => questionKey() + '.quotes';
let quotes = [];
const tray = document.createElement('div');
tray.className = 'quoteTray';
question.before(tray);
function drawQuotes() {
  const usable = ['review','write'].includes(doc.policy);
  tray.hidden = !quotes.length || !usable;
  tray.innerHTML = quotes.map(({source,text,note},i) => `<div class="quoteItem">
    <details><summary><strong>${esc(source)}</strong>${esc(text.replace(/\s+/g,' '))}</summary><p>${esc(text)}</p></details>
    <button type="button" data-index="${i}" aria-label="移除第 ${i+1} 条引用" ${busy?'disabled':''}>×</button>
    <textarea rows="1" data-note="${i}" aria-label="第 ${i+1} 段的批注" placeholder="写下你对这段的看法…" ${busy?'disabled':''}>${esc(note)}</textarea></div>`).join('');
}
function persistQuotes() {
  if (quotes.length) sessionStorage.setItem(quoteKey(), JSON.stringify(quotes));
  else sessionStorage.removeItem(quoteKey());
}
function saveQuotes() {
  persistQuotes();
  drawQuotes();
}
tray.oninput = e => {
  if (!e.target.matches('textarea[data-note]')) return;
  quotes[Number(e.target.dataset.note)].note = e.target.value;
  persistQuotes();
};
tray.onclick = e => {
  const button = e.target.closest('button[data-index]');
  if (button && !busy) { quotes.splice(Number(button.dataset.index),1); saveQuotes(); }
};
function addQuote(source,text) {
  if (busy || !['review','write'].includes(doc.policy) || !text.trim()) return;
  let index = quotes.findIndex(q => q.source===source && q.text===text);
  if (index < 0) { index = quotes.push({source,text,note:''})-1; saveQuotes(); }
  if (document.body.classList.contains('focusmode')) {
    document.body.classList.remove('focusmode'); view('write');
  }
  tray.querySelector('[data-note="'+index+'"]').focus();
}
const quoteDraft = $('#quoteDraft'), quoteReply = $('#quoteReply');
quoteDraft.onmousedown = quoteReply.onmousedown = e => e.preventDefault();
quoteDraft.onclick = () => {
  if (selection) quoteInput(draft);
};
let replyQuote;
let inputAnchor;
function quoteInput(input) {
  const end = input.selectionEnd;
  const text = input.value.slice(input.selectionStart,end);
  if (!text.trim()) return;
  input.setSelectionRange(end,end);
  if (input===draft) { selection=null; showTarget(); }
  inputAnchor=null; quoteReply.hidden=true;
  addQuote(input===draft?'正文':'我的问题',text);
}
for (const input of [draft,question]) {
  input.addEventListener('pointerup', e => {
    inputAnchor={input,x:e.clientX,y:e.clientY};
    placeReplyQuote();
  });
  input.addEventListener('keyup', () => { inputAnchor=null; placeReplyQuote(); });
}
function showQuoteButton(x,top,bottom) {
  quoteReply.hidden=false;
  quoteReply.style.left=Math.max(6,Math.min(x,innerWidth-quoteReply.offsetWidth-6))+'px';
  quoteReply.style.top=(top>quoteReply.offsetHeight+6 ? top-quoteReply.offsetHeight-5 : Math.min(bottom+4,innerHeight-quoteReply.offsetHeight-4))+'px';
}
function placeReplyQuote() {
  const sel = window.getSelection();
  replyQuote = null; quoteReply.hidden = true;
  if (!doc || busy || !['review','write'].includes(doc.policy)) return;
  const input=document.activeElement;
  if (input===draft || input===question) {
    if (input.selectionStart===input.selectionEnd || !input.value.slice(input.selectionStart,input.selectionEnd).trim()) return;
    const rect=input.getBoundingClientRect();
    if (rect.bottom<=0 || rect.top>=innerHeight) return;
    const anchor=inputAnchor?.input===input ? inputAnchor : null;
    const y=Math.max(0,Math.min(innerHeight,anchor ? Math.max(rect.top,Math.min(rect.bottom,anchor.y)) : rect.top));
    replyQuote={input};
    showQuoteButton(anchor?.x ?? rect.left+12,y,y);
    return;
  }
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const element = range.commonAncestorContainer.nodeType===1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const region = element?.closest('.messageBody,.reply .diff,.turn > details .diff');
  if (!region || !region.closest('#discussion')) return;
  const text = sel.toString();
  if (!text.trim()) return;
  const bounds = range.getBoundingClientRect(), feed = region.closest('.feed').getBoundingClientRect();
  const top = Math.max(bounds.top,feed.top,0), bottom = Math.min(bounds.bottom,feed.bottom,innerHeight);
  if (top >= bottom) return;
  const reply = region.closest('.reply');
  replyQuote = {source:reply ? reply.querySelector('b').textContent + (region.matches('.diff')?' 修改建议':' 回复') : region.matches('.diff')?'当轮文稿':'我的发言',text};
  showQuoteButton(bounds.left,top,bottom);
}
document.addEventListener('selectionchange',placeReplyQuote);
document.addEventListener('scroll',placeReplyQuote,true);
window.addEventListener('resize',placeReplyQuote);
quoteReply.onclick = () => {
  if (replyQuote?.input) { quoteInput(replyQuote.input); return; }
  if (replyQuote) { const {source,text} = replyQuote; window.getSelection().removeAllRanges(); addQuote(source,text); }
};
function rememberQuestion() {
  if (question.value) sessionStorage.setItem(questionKey(), question.value);
  else sessionStorage.removeItem(questionKey());
}
question.oninput = rememberQuestion;
function openRoom(id) {
  threadId = id;
  if (id) sessionStorage.setItem(roomKey(), id); else sessionStorage.removeItem(roomKey());
  question.value = sessionStorage.getItem(questionKey()) || '';
  quotes = JSON.parse(sessionStorage.getItem(quoteKey()) || '[]');
  drawQuotes();
  attached.clear(); drawAttachments();
}
function chooseRole(role) {
  who = role;
  sessionStorage.setItem('folio.role.' + doc.id, role);
}
async function api(route, input = {}) {
  const r = await fetch('/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Folio': '1' }, body: JSON.stringify(input) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}
window.addEventListener('unhandledrejection', e => { e.preventDefault(); toast(e.reason?.message || '操作失败'); });
function dialog(title, html, action, confirm = '保存') {
  $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#confirmModal').textContent = confirm;
  $('#modalError').textContent = '';
  modalAction = action; if (!$('#modal').open) $('#modal').showModal();
}
$('#modalForm').onsubmit = async e => {
  e.preventDefault(); $('#confirmModal').disabled = true;
  try { await modalAction(new FormData(e.target)); $('#modal').close(); }
  catch (err) { $('#modalError').textContent = err.message; }
  finally { $('#confirmModal').disabled = false; }
};
$('#closeModal').onclick = $('#cancelModal').onclick = () => $('#modal').close();
function updateWords() {
  const str = draft.value;
  const words = str.match(/[a-zA-Z0-9]+(?:[’'-][a-zA-Z0-9]+)*/g)?.length || 0;
  const han = str.match(/\p{Script=Han}/gu)?.length || 0;
  $('#wordcount').textContent = words.toLocaleString() + ' 英文词' + (han ? ' · ' + han + ' 汉字' : '');
}
function keepLocal() {
  if (doc && draft.value !== doc.text) localStorage.setItem(cacheKey(doc.id), JSON.stringify({ rev: doc.rev, text: draft.value }));
}
function flush() {
  clearTimeout(timer);
  if (saving) return saving.then(flush);
  if (!doc || draft.value === doc.text) return Promise.resolve();
  const id = doc.id, text = draft.value;
  $('#saved').textContent = '保存中…';
  saving = api('save', { id, rev: doc.rev, text }).then(r => {
    doc.text = text; doc.rev = r.rev;
    if (draft.value === text) { localStorage.removeItem(cacheKey(id)); $('#saved').textContent = '已保存到本地'; }
    else keepLocal();
  }).catch(err => {
    $('#saved').textContent = '未同步 · 点击处理';
    throw err;
  }).finally(() => { saving = null; });
  return saving.then(flush);
}
async function readExternal() {
  if (!doc || saving) return;
  const id = doc.id;
  const disk = await api('get', { id });
  if (id !== doc.id || saving || disk.rev === doc.rev) return;
  if (draft.value !== doc.text) { $('#saved').textContent = '两边都有改动 · 点击合并'; return; }
  doc.rev = disk.rev; doc.text = draft.value = disk.text; selection = null;
  $('#saved').textContent = '已载入磁盘改动'; updateWords(); drawRoom();
}
window.addEventListener('focus', () => { readExternal().catch(err => toast(err.message)); });
$('#saved').onclick = async () => {
  if (draft.value === doc.text) { await readExternal(); return; }
  const disk = await api('get', { id: doc.id });
  if (disk.rev === doc.rev) { await flush(); return; }
  dialog('合并磁盘与编辑器改动',
    '<p class="textmuted">上方是当前磁盘版本。请在下方保留两边需要的内容后保存。</p><label>磁盘版本<textarea rows="5" readonly>' + esc(disk.text) + '</textarea></label><label>合并后的正文<textarea name="merged" rows="8">' + esc(draft.value) + '</textarea></label>',
    async form => { const text = form.get('merged'); const r = await api('save', { id: doc.id, rev: disk.rev, text }); doc.text = draft.value = text; doc.rev = r.rev; localStorage.removeItem(cacheKey(doc.id)); $('#saved').textContent = '已保存到本地'; updateWords(); }, '保存合并稿');
};
draft.oninput = () => {
  keepLocal(); updateWords(); selection = null; showTarget(); $('#saved').textContent = '正在编辑';
  clearTimeout(timer); timer = setTimeout(() => flush().catch(err => toast(err.message)), 650);
};
function selectPassage() {
  const start = draft.selectionStart, end = draft.selectionEnd;
  selection = start < end ? { start, end } : null; showTarget();
}
for (const evt of ['select', 'keyup', 'pointerup']) draft.addEventListener(evt, selectPassage);
function showTarget() {
  const t = activeThread();
  const selected = selection ? '选中 ' + (selection.end - selection.start) + ' 字符' : '全文';
  const latest = t?.turns.at(-1)?.rev || t?.rev;
  const changed = latest && (latest !== doc.rev || draft.value !== doc.text);
  $('#target').textContent = [changed ? '更新后的正文' : '当前正文', selected, (t?.turns.length || 0) + ' 轮记录', attached.size ? '随附 ' + attached.size + ' 份资料' : '按需查阅资料'].join(' · ');
  const items = [who === 'pair' ? '两位模型独立阅读同一版全文和选区。' : '发送当前全文，选区标示讨论重点。',
    t?.turns.length ? '包含本讨论各模型此前的公开回复。' : '本轮从空白讨论记录开始。',
    '项目 AI 范围与角色提示词', doc.prompt && '申请题目', doc.notes && '本项目素材', boot.prompts?.style && '共享写作偏好', boot.references.length > 0 && '共享资料目录（可按需查阅正文）'];
  $('#materialList').textContent = items.filter(Boolean).join('\n');
  $('#scope').textContent = selection ? '已选 ' + (selection.end - selection.start) + ' 字符' : '选中文字可讨论这一段';
  quoteDraft.hidden = !selection || busy || !['review','write'].includes(doc.policy);
}
function drawAttachments() {
  const refs = boot.references;
  for (const id of attached) if (!refs.some(r => r.id === id)) attached.delete(id);
  $('#attachedRefs').innerHTML = refs.length ? '<fieldset><legend>本轮随附资料</legend>' +
    refs.map(r => '<label><input type="checkbox" value="' + esc(r.id) + '"' + (attached.has(r.id) ? ' checked' : '') +
      '><span>' + esc(r.title) + (r.characters > 16000 ? '（先附首段，可继续查阅）' : '') + '</span></label>').join('') + '</fieldset>' : '';
}
$('#attachedRefs').onchange = e => {
  if (e.target.checked) attached.add(e.target.value); else attached.delete(e.target.value);
  showTarget();
};
function projectMenu() {
  $('#projects').innerHTML = boot.projects.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + ' · ' + p.kind + '</option>').join('');
}
async function load(id) {
  doc = await api('get', { id }); threadId = null; selection = null; briefDirty = false;
  openRoom(doc.threads.find(t => t.id === sessionStorage.getItem(roomKey()))?.id || null);
  const lastRole = sessionStorage.getItem('folio.role.' + id);
  who = ['Claude','Gemini','GPT','pair'].includes(lastRole) && !(threadId && lastRole === 'pair') ? lastRole : 'Claude';
  $('#projects').value = id; localStorage.setItem('folio.last', id);
  $('#school').textContent = doc.name; $('#title').textContent = labels[doc.kind]; document.title = doc.name + ' · ' + doc.kind + ' | Folio';
  draft.value = doc.text; $('#saved').textContent = '已保存到本地';
  const cached = JSON.parse(localStorage.getItem(cacheKey(id)) || 'null');
  if (cached && cached.text !== doc.text) {
    draft.value = cached.text; $('#saved').textContent = '已恢复未同步文字 · 点击处理';
    if (cached.rev !== doc.rev) doc.rev = cached.rev;
  }
  for (const k of ['prompt', 'policy', 'policyNote', 'notes']) briefForm.elements[k].value = doc[k];
  updateWords(); drawRoom(); drawHistory(); view('write');
}
function view(next) {
  tab = next; $('#library').hidden = tab !== 'library'; if (tab === 'library') refreshLibrary().catch(e => toast(e.message)); $('#paper').hidden = tab !== 'write'; $('#brief').hidden = tab !== 'brief'; $('#history').hidden = tab !== 'history';
  for (const b of all('[data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
  if (tab !== 'write') document.body.classList.remove('focusmode');
  $('#focusLabel').textContent = document.body.classList.contains('focusmode') ? '退出专注' : '专注写作';
  $('#focus').hidden = tab !== 'write';
}
for (const b of all('[data-tab]')) b.onclick = () => view(b.dataset.tab);
$('#focus').onclick = () => { document.body.classList.toggle('focusmode'); view('write'); draft.focus(); };
function canLeave() { return !briefDirty || window.confirm('项目资料尚未保存。放弃这次资料编辑？'); }
$('#projects').onchange = async e => {
  const id = e.target.value; e.target.value = doc.id;
  if (canLeave()) { await flush(); await load(id); }
};
$('#add').onclick = () => {
  dialog('新建文稿', '<label>学校或项目<input name="name" maxlength="100" required placeholder="例如 Princeton · Physics"></label><label>文书类型<select name="kind"><option>SOP</option><option>PS</option></select></label><label>起始正文<select name="start"><option value="blank">空白稿</option><option value="current">复制当前正文</option></select></label>',
    async form => {
      if (!canLeave()) throw new Error('请先保存项目资料');
      await flush();
      const r = await api('create', { name: form.get('name'), kind: form.get('kind'), text: form.get('start') === 'current' ? doc.text : '' });
      boot = await api('boot'); projectMenu(); await load(r.id);
    }, '创建');
};
const choices = {
  Claude: { 'anthropic/claude-fable-5.2': 'Claude Fable 5.2', 'anthropic/claude-opus-5.5': 'Claude Opus 5.5' },
  Gemini: { 'google/gemini-4-carbon': 'Gemini 4 Carbon', 'google/gemini-4-neon': 'Gemini 4 Neon' },
  GPT: { 'openai/gpt-6.2-sol': 'GPT‑6.2 Sol', 'openai/gpt-6.2-astra': 'GPT‑6.2 Astra', 'openai/gpt-6-astra': 'GPT‑6 Astra' }
};
function modelForm(models) {
  return Object.entries(models).map(([role,c]) => {
    const custom = !Object.hasOwn(choices[role], c.model);
    return '<div class="settingsrow"><label>' + role + ' 型号<select name="' + role + '" data-picker="' + role + '">' +
      Object.entries(choices[role]).map(([id,name]) => '<option value="' + id + '"' + (id === c.model ? ' selected' : '') + '>' + name + '</option>').join('') +
      '<option value="custom"' + (custom ? ' selected' : '') + '>其他模型…</option></select></label><label>推理档位<select name="' + role + 'Effort">' +
      ['low','medium','high'].map(x => '<option' + (c.effort === x ? ' selected' : '') + '>' + x + '</option>').join('') +
      '</select></label></div><input name="custom' + role + '" aria-label="自定义 ' + role + ' 型号" placeholder="厂商/模型 ID" ' + (custom ? 'required' : 'hidden disabled') + ' value="' + esc(custom ? c.model : '') + '">';
  }).join('');
}
function bindPickers() {
  for (const el of all('[data-picker]')) el.onchange = () => {
    const input = $('#modalForm').elements['custom' + el.name], show = el.value === 'custom';
    input.required = show; input.hidden = input.disabled = !show;
    if (show) input.focus();
  };
}
function readModels(form) {
  return Object.fromEntries(Object.keys(choices).map(role => [role, { model: (form.get(role) === 'custom' ? form.get('custom' + role) : form.get(role)).trim(), effort: form.get(role + 'Effort') }]));
}
$('#switchModels').onclick = () => {
  const t = activeThread();
  dialog('带着当前讨论切换型号', '<p class="textmuted">下一轮沿用本讨论记录。以下选择只用于这条讨论。</p>' + modelForm(t.models), async f => {
    await api('switchModels', { id: doc.id, thread: t.id, before: t.models, models: readModels(f) });
    await refreshHistory();
  }, '应用到本讨论');
  bindPickers();
};
$('#settings').onclick = async () => {
  boot = await api('boot');
  const defaults = boot.defaultPrompts;
  const current = boot.prompts || { ...defaults, style: '' };
  const nav = '<nav class="tabs prefsTabs"><button type="button" class="active" data-pane="models">默认模型</button><button type="button" data-pane="prompts">角色提示词</button></nav>';
  const models = '<section id="modelPane"><p class="textmuted">新讨论使用这些型号与档位。</p>' + modelForm(boot.models) +
    '<p class="textmuted">GPT 使用本机 Codex 登录的 ChatGPT 订阅。</p><label>Claude 与 Gemini 共用的 OpenRouter API Key<input type="password" autocomplete="off" spellcheck="false" name="key" placeholder="' + (boot.connected ? '输入新密钥以切换账号' : '输入 OpenRouter 密钥') + '"></label><p class="textmuted">Windows 会为当前用户加密保存密钥。其他系统仅在本次运行使用，可通过 OPENROUTER_API_KEY 配置。</p></section>';
  const prompts = '<section id="promptPane" hidden><p class="textmuted">保存后从下一轮起生效。学校的 AI 使用范围优先。</p>' +
    Object.keys(defaults).map(role => '<label>' + role + '<textarea rows="3" name="prompt' + role + '">' + esc(current[role]) + '</textarea></label><button type="button" class="textbtn" data-reset="' + role + '">恢复 ' + role + ' 默认提示词</button>').join('') +
    '<label>共享写作偏好<textarea rows="3" name="style" placeholder="例如：保留我的措辞，标明科研贡献归属。">' + esc(current.style) + '</textarea></label></section>';
  dialog('模型设置', nav + models + prompts, async form => {
    const value = Object.fromEntries(Object.keys(defaults).map(r => [r, form.get('prompt' + r)]));
    value.style = form.get('style');
    await api('settings', { models: readModels(form), key: form.get('key'), beforeModels: boot.models,
      ...(JSON.stringify(value) === JSON.stringify(current) ? {} : { prompts: value, beforePrompts: boot.prompts }) });
    if (form.get('key')?.trim()) {
      $('#modalForm').elements.key.value = '';
      toast('新密钥已验证并保存到本机');
    }
    boot = await api('boot'); drawRoom();
  });
  bindPickers();
  for (const btn of all('[data-pane]')) btn.onclick = () => {
    const modelTab = btn.dataset.pane === 'models';
    $('#modelPane').hidden = !modelTab; $('#promptPane').hidden = modelTab;
    for (const b of all('[data-pane]')) b.classList.toggle('active', b === btn);
  };
  for (const btn of all('[data-reset]')) btn.onclick = () => {
    const role = btn.dataset.reset; $('#modalForm').elements['prompt' + role].value = defaults[role];
  };
};
briefForm.oninput = () => { briefDirty = true; };
briefForm.onsubmit = async e => {
  e.preventDefault(); const b = Object.fromEntries(new FormData(briefForm)); const before = {};
  for (const k of Object.keys(b)) before[k] = doc[k];
  await api('brief', { id: doc.id, ...b, before }); Object.assign(doc, b); briefDirty = false;
  const t = activeThread();
  if (outdatedPolicy(t)) openRoom(null);
  drawRoom(); view('write'); toast('已保存项目资料');
};
async function refreshLibrary() {
  boot.references = await api('references');
  const list = $('#referenceList');
  list.innerHTML = boot.references.map(r => '<div class="refRow"><button class="record refEdit" data-ref="' + esc(r.id) + '" aria-label="编辑 ' + esc(r.title) + '"><b>' +
    esc(r.title) + '</b><span>' + esc(r.filename || '粘贴的文本') + ' · ' + r.characters.toLocaleString() + ' 字符</span><small>编辑</small></button>' +
    '<button class="textbtn" data-remove="' + esc(r.id) + '" aria-label="移出 ' + esc(r.title) + '">移出</button></div>').join('') ||
    '<p class="textmuted">资料库为空。你可以逐份添加 CV、科研笔记或其他申请材料。</p>';
  for (const btn of list.querySelectorAll('[data-ref]')) btn.onclick = async () => {
    const ref = await api('referenceRead', { ref:btn.dataset.ref });
    dialog('编辑资料', '<label>标题<input name="title" required maxlength="160"></label>' +
      '<label>模型可查阅的正文<textarea class="referencePreview" name="text" required maxlength="1000000"></textarea></label>' +
      '<p class="textmuted" id="refHint"></p>', async f => {
      await api('referenceUpdate', {ref:ref.id, revision:ref.revision, title:f.get('title'), text:f.get('text')});
      await refreshLibrary(); toast('资料已保存');
    }, '保存修改');
    const { title, text } = $('#modalForm').elements;
    title.value = ref.title; text.value = ref.text;
    const hint = () => {
      $('#refHint').textContent = /^https?:\/\/\S+$/i.test(text.value.trim())
        ? '这份资料只有链接。若希望模型参考网页内容，请把相关段落粘贴到正文。'
        : ref.filename ? '此处编辑供模型查阅的文字。上传原件单独保留。' : '';
    };
    text.oninput = hint; hint();
  };
  for (const btn of list.querySelectorAll('[data-remove]')) btn.onclick = async () => {
    const ref = boot.references.find(r => r.id === btn.dataset.remove);
    dialog('移出资料库', '<p>移出「' + esc(ref.title) + '」后，后续请求将无法再查阅这份资料。</p>', async () => {
      await api('referenceRemove', { ref:ref.id }); await refreshLibrary();
    }, '确认移出');
  };
  const legacy = $('#legacyRefs');
  legacy.innerHTML = boot.legacyNames?.length ? '<details><summary>旧版暂存 · 尚未入库</summary>' +
    boot.legacyNames.map(k => '<button class="textbtn" data-legacy="' + k + '">' + (k === 'cv' ? '查看旧版 CV' : '查看旧版共享事实') + '</button>').join('') + '</details>' : '';
  for (const b of legacy.querySelectorAll('button')) b.onclick = async () => {
    const { text } = await api('legacyReference', {field:b.dataset.legacy});
    pasteReference(b.dataset.legacy === 'cv' ? 'CV' : '科研事实', text);
  };
  drawAttachments(); showTarget();
}
function pasteReference(title = '', text = '') {
  dialog('添加文本资料', '<label>标题<input name="title" required maxlength="160" value="' + esc(title) + '"></label>' +
    '<label>正文<textarea name="text" rows="12" required placeholder="粘贴要共享的文字">' + esc(text) + '</textarea></label>', async f => {
      await api('referenceAdd', {title:f.get('title'), text:f.get('text')}); await refreshLibrary();
    }, '加入资料库');
}
$('#pasteRef').onclick = () => pasteReference();
$('#openLibrary').onclick = () => view('library');
$('#uploadRef').onclick = () => {
  dialog('上传文件', '<label>文件<input type="file" required name="file" accept=".pdf,.docx,.txt,.md"></label>' +
    '<p class="textmuted">支持文字版 PDF、Word（.docx）、Markdown 和 TXT，每份最多 15 MB。</p>' +
    '<label>资料标题<input name="title" maxlength="160" required></label>', async f => {
      const file = f.get('file');
      if (file.size > 15 * 1024 * 1024) throw new Error('单份文件最大 15 MB');
      const data = await new Promise((resolve,reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取文件'));
        reader.readAsDataURL(file);
      });
      await api('referenceAdd', {title:f.get('title'), filename:file.name, data}); await refreshLibrary();
    }, '加入资料库');
  $('#modalForm').elements.file.onchange = e => {
    const file = e.target.files[0]; if (file) $('#modalForm').elements.title.value = file.name.replace(/\.[^.]+$/, '');
  };
};
function drawHistory() {
  const list = $('#historyList');
  list.innerHTML = [...doc.threads].reverse().map(t => '<div class="refRow"><button class="record" data-thread="' + esc(t.id) + '"><b>' + esc(t.title) + '</b><span>' +
    esc(new Date(t.created).toLocaleString('zh-CN')) + ' · ' + policyLabels[t.policy] + ' · ' + t.turns.length + ' 轮</span></button><button class="textbtn" data-delete-thread="' + esc(t.id) + '" aria-label="删除讨论 ' + esc(t.title) + '">删除</button></div>').join('') || '<p class="textmuted">发起第一条讨论后，可在这里查看原稿、模型意见和已采纳的修改。</p>';
  for (const b of list.querySelectorAll('[data-thread]')) b.onclick = () => { if (busy) return; openRoom(b.dataset.thread); selection = null; if (who === 'pair') chooseRole('Claude'); drawRoom(); view('write'); };
  for (const b of list.querySelectorAll('[data-delete-thread]')) b.onclick = () => {
    const thread = doc.threads.find(t => t.id === b.dataset.deleteThread);
    dialog('删除讨论', '<p>确定删除「' + esc(thread.title) + '」的全部对话和修改建议？已写入正文的文字会保留。</p>', async () => {
      await api('deleteThread', {id: doc.id, thread: thread.id});
      sessionStorage.removeItem('folio.question.' + doc.id + '.' + thread.id);
      sessionStorage.removeItem('folio.question.' + doc.id + '.' + thread.id + '.quotes');
      if (threadId === thread.id) { openRoom(null); selection = null; }
      await refreshHistory(); toast('讨论已删除');
    }, '删除讨论');
  };
}
function drawRoom() {
  const t = activeThread(); showTarget();
  drawQuotes(); quoteReply.hidden = true; replyQuote = null;
  $('#webOption').hidden = !['review','write'].includes(doc.policy);
  $('#webSearch').disabled = busy || $('#webOption').hidden;
  $('#memoryOption').hidden = who !== 'GPT' || $('#webOption').hidden;
  $('#localMemory').disabled = busy || $('#memoryOption').hidden;
  for (const b of all('.rolelist [data-role]')) {
    const role = b.dataset.role, c = (t?.models || boot.models)[role];
    b.setAttribute('aria-pressed', String(role === who));
    b.querySelector('strong').textContent = choices[role][c.model] || c.model.split('/').at(-1);
    b.title = c.model + ' · ' + c.effort;
  }
  $('#switchModels').hidden = !t; $('#switchModels').disabled = busy;
  $('#pair').setAttribute('aria-pressed', String(who === 'pair')); $('#newThread').hidden = !t;
  $('#threadLabel').textContent = t ? '讨论 · ' + t.title : '新讨论';
  $('#threadLabel').title = t?.title || '';
  const role = who === 'pair' ? '两位协作者' : who;
  question.placeholder = doc.policy === 'grammar' ? '本项目只检查语法、拼写和标点' : '你想和' + ' ' + role + ' 讨论什么？';
  question.disabled = doc.policy === 'grammar'; $('#send').disabled = busy;
  $('#send').textContent = busy ? '正在等待回复…' : doc.policy === 'off' ? '设置项目 AI 范围' : outdatedPolicy(t) ? '按当前范围另开讨论' : '发送给' + ' ' + role;
  $('#attachedRefs').inert = busy;
  briefForm.querySelector('button').disabled = busy;
  $('#projects').disabled = $('#add').disabled = $('#pair').disabled = $('#newThread').disabled = busy;
  for (const b of all('.rolelist [data-role]')) b.disabled = busy;
  if (!busy) $('#callstatus').textContent = outdatedPolicy(t) ? '这条讨论使用此前的项目 AI 范围。' : !t && doc.policy === 'off' ? '首次使用时，按学校要求选择协作范围。' : '';
  const feed = $('#discussion');
  if (!t) { feed.innerHTML = ''; return; }
  const previous = feed.firstElementChild;
  const sameThread = previous?.dataset.threadId === t.id;
  const scrollTop = sameThread ? previous.scrollTop : 0;
  const expanded = sameThread ? Array.from(previous.querySelectorAll('details'), d => d.open) : [];
  feed.innerHTML = '<div class="feed">' +
t.turns.map(turn => '<div class="turn"><strong>你</strong>' + messageBody(turn.q) + '<details><summary class="meta">本轮文稿 · ' + ((turn.rev ? turn.selection : t.selection) ? '含选区' : '全文') + (turn.withCV ? ' · 已附 CV' : '') + '</summary><div class="diff">' + esc(turn.base ?? t.base) + '</div></details>' + turn.replies.map(r => '<div class="reply"><b>' + esc(r.role) + '</b><div class="meta">' + esc(r.provider || 'OpenRouter') + ' · ' + esc(r.model) + ' · ' + esc(r.effort) + '</div>' + (r.opened?.length ? '<div class="meta">已查阅 · ' + esc([...new Set(r.opened.map(x => x.title))].join('、')) + '</div>' : '') + (r.error ? '<p class="error">' + esc(r.error) + '</p>' : messageBody(r.comment)) + (r.notice ? '<p class="meta">' + esc(r.notice) + '</p>' : '') +
      (r.error && ['Claude', 'Gemini'].includes(r.role) && !outdatedPolicy(t)
        ? '<a class="textbtn" href="https://openrouter.ai/activity" target="_blank" rel="noreferrer">查看用量</a><button class="outline" data-retry="' + esc(turn.id) + '" data-role="' + esc(r.role) + '"' + (busy ? ' disabled' : '') + '>重新调用 ' + esc(r.role) + '（可能计费）</button>' : '') +
      (r.edits || []).map(e => '<details><summary>' + (e.accepted ? '已采纳' : '查看修改建议') + '</summary><div class="diff"><del>' + esc(e.before) + '</del><br><ins>' + esc(e.accepted ? e.applied : e.after) + '</ins></div>' +
        (e.accepted || outdatedPolicy(t) ? '' : '<button class="textbtn" data-edit="' + esc(e.id) + '">编辑并采纳</button>') + '</details>').join('') + '</div>').join('') + '</div>').join('') + '</div>';
  for (const b of feed.querySelectorAll('[data-edit]')) b.onclick = () => propose(b.dataset.edit);
  for (const button of feed.querySelectorAll('[data-retry]')) button.onclick = async () => {
    if (busy) return;
    if (briefDirty) { view('brief'); toast('请先保存项目资料'); return; }
    const role = button.dataset.role;
    busy = true;
    try {
      drawRoom(); $('#callstatus').textContent = role + ' 正在重新处理原问题…';
      await api('ask', {id:doc.id, thread:t.id, retryTurn:button.dataset.retry, who:role});
      await refreshHistory();
    } finally { busy = false; drawRoom(); }
  };
  const panel = feed.firstElementChild;
  panel.dataset.threadId = t.id;
  if (sameThread) {
    panel.querySelectorAll('details').forEach((d, i) => { if (expanded[i]) d.open = true; });
    panel.scrollTop = scrollTop;
  }
}
function propose(id) {
  const t = activeThread(), edit = t.turns.flatMap(turn => turn.replies.flatMap(r => r.edits || [])).find(e => e.id === id);
  dialog('采纳前核对', '<label>原文<div class="diff">' + esc(edit.before || '（空白文稿）') + '</div></label><label>写入正文的文字<textarea rows="7" name="after">' + esc(edit.after) + '</textarea></label>',
    async f => {
      await flush(); const result = await api('apply', { id: doc.id, thread: t.id, edit: id, rev: doc.rev, after: f.get('after') });
      doc.text = draft.value = result.text; doc.rev = result.rev; selection = null; updateWords(); await refreshHistory(); toast('已写入正文');
    }, '采纳修改');
}
async function refreshHistory() {
  const fresh = await api('get', { id: doc.id }); doc.threads = fresh.threads; drawRoom(); drawHistory();
}
for (const b of all('.rolelist [data-role]')) b.onclick = () => { chooseRole(b.dataset.role); drawRoom(); question.focus(); };
$('#newThread').onclick = () => { openRoom(null); drawRoom(); question.focus(); };
$('#pair').onclick = () => { chooseRole('pair'); if (threadId) openRoom(null); drawRoom(); question.focus(); };
$('#send').onclick = async () => {
  if (busy) return;
  if (doc.policy === 'off') { view('brief'); briefForm.elements.policy.focus(); return; }
  if (outdatedPolicy(activeThread())) {
    const pendingQuestion = question.value;
    const pendingQuotes = quotes;
    openRoom(null);
    if (pendingQuestion) { question.value = pendingQuestion; rememberQuestion(); }
    if (pendingQuotes.length) { quotes = pendingQuotes; saveQuotes(); }
    drawRoom(); question.focus(); return;
  }
  if (who !== 'GPT' && !boot.connected) { $('#settings').click(); return; }
  if (briefDirty) { view('brief'); toast('请先保存已编辑的项目资料'); return; }
  if (!question.value.trim() && !quotes.some(q=>q.note?.trim()) && doc.policy !== 'grammar') { question.focus(); toast('写下问题，或给引用加一条批注'); return; }
  const q = question.value;
  const message = [q, ...(doc.policy==='grammar' ? [] : quotes).map(({source,text,note},i) =>
    '引用 '+(i+1)+' · '+source+'\n'+text.split(/\r?\n/).map(line=>'> '+line).join('\n')+
    (note?.trim() ? '\n\n我的批注：'+note.trim() : ''))].filter(Boolean).join('\n\n');
  if (doc.policy!=='grammar' && message.length>16000) { toast('问题与引用合计超过 16,000 字符，请缩短后发送'); return; }
  const questionSlot = questionKey(), sources = [...attached];
  busy = true;
  try {
    drawRoom(); $('#callstatus').textContent = who === 'pair' ? '两位协作者正在独立阅读同一份稿件…' : who + ' 正在阅读讨论材料…';
    await flush();
    const r = await api('ask', { id: doc.id, rev: doc.rev, thread: threadId, selection, who, question: message, attached:sources, memory: $('#localMemory').checked && !$('#memoryOption').hidden, web: $('#webSearch').checked && !$('#webOption').hidden });
    threadId = r.thread; sessionStorage.setItem(roomKey(), threadId);
    if (who === 'pair') chooseRole('Claude');
    await refreshHistory();
    const last = activeThread().turns.at(-1);
    if (last.replies.some(r => !r.error)) {
      if (question.value === q) question.value = '';
      quotes = [];
      attached.clear(); drawAttachments();
    }
    if (questionKey() !== questionSlot) { sessionStorage.removeItem(questionSlot); sessionStorage.removeItem(questionSlot+'.quotes'); }
    rememberQuestion(); saveQuotes();
  } finally { busy = false; drawRoom(); $('#callstatus').textContent = ''; const feed = $('.feed'); if (feed) feed.scrollTop = feed.scrollHeight; }
};
question.onkeydown = tray.onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#send').click(); } };
const splitter = $('#splitter'), workspace = $('.workspace');
const widthKey = 'folio.chatWidth';
let preferred = Number(localStorage.getItem(widthKey)) || 36;
function adjustWidth(value) {
  const width = workspace.getBoundingClientRect().width;
  const min = Math.min(55,Math.ceil(300/width*100));
  const percent = Math.min(55,Math.max(min,value));
  workspace.style.setProperty('--chat-width',percent+'%');
  splitter.setAttribute('aria-valuemin',min);
  splitter.setAttribute('aria-valuemax','55');
  splitter.setAttribute('aria-valuenow',Math.round(percent));
  splitter.setAttribute('aria-valuetext','对话栏占 '+Math.round(percent)+'%');
  return percent;
}
new ResizeObserver(() => adjustWidth(preferred)).observe(workspace);
let dragOffset = 0;
splitter.onpointerdown = e => {
  if (e.button!==0 || !e.isPrimary) return;
  dragOffset = $('#studio').getBoundingClientRect().left - e.clientX;
  splitter.setPointerCapture(e.pointerId); document.body.classList.add('resizing');
};
splitter.onpointermove = e => {
  if (!splitter.hasPointerCapture(e.pointerId)) return;
  const bounds = workspace.getBoundingClientRect();
  preferred = adjustWidth((bounds.right-e.clientX-dragOffset)*100/bounds.width);
};
splitter.onlostpointercapture = () => { document.body.classList.remove('resizing'); localStorage.setItem(widthKey,preferred); };
splitter.ondblclick = () => { preferred=36; adjustWidth(preferred); localStorage.removeItem(widthKey); };
splitter.onkeydown = e => {
  const current = Number(splitter.getAttribute('aria-valuenow'));
  const widths = {ArrowLeft:current+2, ArrowRight:current-2, Home:0, End:55};
  if (Object.hasOwn(widths,e.key)) { e.preventDefault(); preferred=adjustWidth(widths[e.key]); localStorage.setItem(widthKey,preferred); }
};
window.addEventListener('beforeunload', e => { if (doc && (doc.text !== draft.value || briefDirty)) { keepLocal(); e.preventDefault(); e.returnValue = ''; } });
async function init() {
  boot = await api('boot'); projectMenu();
  await load(boot.projects.find(p => p.id === localStorage.getItem('folio.last'))?.id || boot.projects[0].id);
  if (location.hash === '#openrouter') {
    await $('#settings').onclick();
    $('#modalForm').elements.key.focus();
    history.replaceState(null, '', location.pathname + location.search);
  }
}
init().catch(e => { $('#saved').textContent = '读取失败'; toast(e.message); });
