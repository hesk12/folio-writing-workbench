import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check } from './store.mjs';

const extensionSet = new Set(['.pdf', '.docx', '.md', '.txt']);
const maxBytes = 15 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function referenceTitle(value) {
  const title = typeof value === 'string' && value.trim();
  check(title && title.length <= 160, '请填写资料标题（最多 160 字）');
  return title;
}
function referenceText(value, emptyMessage) {
  const text = typeof value === 'string' && value.trim();
  check(text, emptyMessage, 422);
  check(text.length <= 1000000, '单份资料最多 100 万字符，请拆成多份。', 413);
  return text;
}
async function extract(ext, bytes) {
  if (ext === '.md' || ext === '.txt') {
    let text;
    try {
      const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch { check(false, '请将文本存为 UTF-8，或直接粘贴文字。'); }
    check(!text.includes('\0'), '请选择可读的文本文件。');
    return text;
  }
  const python = process.env.FOLIO_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  return new Promise((resolve, reject) => {
    const child = execFile(python, ['-I', '-X', 'utf8', fileURLToPath(new URL('./extract-reference.py', import.meta.url)), ext],
      { timeout: 45000, maxBuffer: 6 * 1024 * 1024, windowsHide: true }, (err, out) => {
        if (err) reject(Object.assign(new Error('未能提取正文。请检查文件是否损坏、加密或过长，也可以粘贴文字。'), { status: 422 }));
        else resolve(out);
      });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}
export class ReferenceLibrary {
  constructor(root) {
    this.root = path.join(root, '资料库');
    fs.mkdirSync(this.root, { recursive: true });
  }
  dir(id) {
    check(typeof id === 'string' && uuid.test(id), '资料不存在', 404);
    const dir = path.join(this.root, id);
    check(fs.existsSync(dir), '资料已移出资料库', 404);
    return dir;
  }
  list() {
    return fs.readdirSync(this.root).filter(n => uuid.test(n)).map(id => {
      const { text, ...info } = this.record(id);
      return info;
    }).sort((a,b) => b.created - a.created);
  }
  record(id) {
    return { revision: 'initial', ...JSON.parse(fs.readFileSync(path.join(this.dir(id), 'info.json'), 'utf8')) };
  }
  details(id) {
    const info = this.record(id);
    return { ...info, text: info.text ?? fs.readFileSync(path.join(this.dir(id), '正文.txt'), 'utf8') };
  }
  update({ ref, title, text, revision }) {
    title = referenceTitle(title);
    text = referenceText(text, '请填写资料正文。');
    const current = this.details(ref);
    if (current.title === title && current.text === text) return { revision: current.revision };
    check(revision === current.revision, '这份资料已在其他窗口更新。请先复制要保留的修改，再重新打开资料。', 409);
    const dir = this.dir(ref), next = randomUUID();
    const tmp = path.join(dir, '.edit-' + next);
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...current, title, text, characters: text.length, revision: next }));
      fs.renameSync(tmp, path.join(dir, 'info.json'));
    } finally { fs.rmSync(tmp, { force: true }); }
    return { revision: next };
  }
  async add(input) {
    const title = referenceTitle(input.title);
    let text = input.text, filename = '', ext = '', bytes;
    if (input.filename !== undefined) {
      filename = path.basename(String(input.filename)).slice(0, 240);
      ext = path.extname(filename).toLowerCase();
      check(extensionSet.has(ext), '支持 PDF、DOCX、Markdown 和 TXT。');
      check(typeof input.data === 'string' && input.data.length <= Math.ceil(maxBytes / 3) * 4, '单份文件最大 15 MB。');
      bytes = Buffer.from(input.data, 'base64');
      check(bytes.length && bytes.length <= maxBytes, '文件为空或超过 15 MB。');
      text = await extract(ext, bytes);
    }
    text = referenceText(text, '没有提取到文字。扫描件可先做 OCR，或直接粘贴正文。');
    const id = randomUUID(), stage = path.join(this.root, '.adding-' + id);
    const info = { id, title, filename, characters: text.length, created: Date.now() };
    fs.mkdirSync(stage);
    try {
      fs.writeFileSync(path.join(stage, 'info.json'), JSON.stringify(info));
      fs.writeFileSync(path.join(stage, '正文.txt'), text);
      if (bytes) fs.writeFileSync(path.join(stage, '原件' + ext), bytes);
      fs.renameSync(stage, path.join(this.root, id));
    } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
    return info;
  }
  remove(id) {
    const dir = this.dir(id);
    fs.renameSync(dir, path.join(this.root, '.removed-' + id));
  }
}
