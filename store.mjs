import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const roles = {
  Claude: { model: 'anthropic/claude-fable-5.2', effort: 'high' },
  Gemini: { model: 'google/gemini-4-carbon', effort: 'high' },
  GPT: { model: 'openai/gpt-6.2-sol', effort: 'medium' }
};
export const policies = ['off', 'grammar', 'review', 'write'];
export function check(ok, message, status = 400) {
  if (!ok) throw Object.assign(new Error(message), { status });
}
export const hash = text => createHash('sha256').update(text).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
function put(file, value) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(tmp, value);
  fs.renameSync(tmp, file);
}
export function settings(value) {
  const result = {};
  for (const [role, prefix] of Object.entries({ Claude: 'anthropic/', Gemini: 'google/', GPT: 'openai/' })) {
    const item = value?.[role];
    check(item?.model?.startsWith(prefix) && /^[a-z0-9./_-]{4,100}$/i.test(item.model), role + ' 模型 ID 有误');
    check(['low', 'medium', 'high'].includes(item.effort), '请选择推理档位');
    result[role] = { model: item.model, effort: item.effort };
  }
  return result;
}
export class Library {
  constructor(root) {
    this.root = root;
    this.config = path.join(root, '.folio.json');
    fs.mkdirSync(root, { recursive: true });
    if (!fs.existsSync(this.config)) {
      put(this.config, JSON.stringify({ models: roles, gptRoute: 'codex', facts: '' }));
      this.create({ name: '我的第一份文书', kind: 'SOP' });
    } else {
      const prefs = this.prefs();
      if (!prefs.gptRoute) {
        put(this.config, JSON.stringify({ ...prefs, gptRoute: 'codex' }));
      }
    }
  }
  prefs() { return json(this.config); }
  shared(field, before, value) {
    const p = this.prefs();
    check(JSON.stringify(p[field] ?? null) === JSON.stringify(before ?? null), '内容已在其他窗口更新，请重新打开。', 409);
    put(this.config, JSON.stringify({ ...p, [field]: value }));
  }
  configure(models, { beforeModels, beforePrompts, prompts } = {}) {
    const p = this.prefs();
    if (beforeModels) check(JSON.stringify(p.models) === JSON.stringify(beforeModels), '默认型号已更新，请重新打开设置。', 409);
    if (prompts) {
      check(JSON.stringify(p.prompts ?? null) === JSON.stringify(beforePrompts ?? null), '提示词已在另一窗口更新。', 409);
      p.prompts = prompts;
    }
    put(this.config, JSON.stringify({ ...p, models: settings(models) }));
  }
  facts(before, facts) {
    const p = this.prefs();
    check(before === p.facts, '共享素材已在别处修改，请重新打开。', 409);
    put(this.config, JSON.stringify({ ...p, facts }));
  }
  dir(id) {
    check(typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id), '文稿不存在', 404);
    return path.join(this.root, id);
  }
  metaFile(id) { return path.join(this.dir(id), '.folio.json'); }
  meta(id) {
    check(fs.existsSync(this.metaFile(id)), '文稿不存在', 404);
    return json(this.metaFile(id));
  }
  update(id, fn) {
    const data = this.meta(id);
    fn(data);
    put(this.metaFile(id), JSON.stringify(data));
    return data;
  }
  create({ name, kind, text = '' }) {
    check(typeof name === 'string' && name.trim() && name.length <= 100, '请填写项目名称（最多 100 字）');
    check(['SOP', 'PS'].includes(kind), '请选择文书类型');
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 46) || 'project';
    const id = slug + '-' + kind.toLowerCase() + '-' + randomUUID().slice(0, 8);
    fs.mkdirSync(this.dir(id));
    put(path.join(this.dir(id), kind + '.md'), text);
    put(this.metaFile(id), JSON.stringify({ id, name: name.trim(), kind, created: Date.now(), policy: 'off',
      prompt: '', notes: '', policyNote: '', threads: [] }));
    return id;
  }
  list() {
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^[a-zA-Z0-9-]+$/.test(d.name) && fs.existsSync(this.metaFile(d.name)))
      .map(d => { const { id, name, kind, created } = this.meta(d.name); return { id, name, kind, created }; })
      .sort((a, b) => a.created - b.created);
  }
  get(id) {
    const p = this.meta(id);
    const text = read(path.join(this.dir(id), p.kind + '.md')).replace(/\r\n/g, '\n');
    return { ...p, text, rev: hash(text) };
  }
  save(id, rev, text) {
    const d = this.get(id);
    check(d.rev === rev, '正文已在 其他编辑器或窗口修改。请先保留你的文字，再载入磁盘版本。', 409);
    if (d.text !== text) put(path.join(this.dir(id), d.kind + '.md'), text);
    return hash(text);
  }
}
