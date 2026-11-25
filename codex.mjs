import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function binary() {
  if (process.platform !== 'win32') return 'codex';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const npmBinary = path.join(process.env.APPDATA || '', 'npm/node_modules/@openai/codex/node_modules/@openai',
    'codex-win32-' + process.arch, 'vendor', arch + '-pc-windows-msvc/bin/codex.exe');
  return existsSync(npmBinary) ? npmBinary : 'codex.exe';
}
function run(args, cwd, input) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(?:OPENAI_|OPENROUTER_|CODEX_API_KEY$|CODEX_ACCESS_TOKEN$)/i.test(k)) delete env[k];
  }
  return new Promise((resolve, reject) => {
    const child = execFile(binary(), args, { cwd, env, windowsHide: true, timeout: 240000, maxBuffer: 4 * 1024 * 1024 },
      (err, out, stderr) => {
        if (!err) return resolve(out + '\n' + stderr);
        if (err.code === 'ENOENT') return reject(new Error('找不到 Codex CLI，请安装后用 ChatGPT 登录。'));
        if (/not logged in|unauthorized|login required|refresh token/i.test(stderr)) return reject(new Error('请在终端运行 codex login，用你的 ChatGPT 账号重新登录。'));
        if (/quota|usage limit|rate limit/i.test(stderr)) return reject(new Error('当前 ChatGPT 账号的 Codex 使用额度受限，请稍后重试。'));
        if (/model.*(?:not supported|not available|does not exist)/i.test(stderr)) return reject(new Error('当前 Codex 账号不支持所选模型，请在模型设置中选择可用型号并新开讨论。'));
        return reject(new Error('Codex CLI 调用失败，请检查本机 Codex 登录、网络和模型可用性。'));
      });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export async function subscriptionReply(config) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'folio-codex-'));
  try {
    const auth = await run(['login', 'status'], cwd);
    if (!/logged in using chatgpt/i.test(auth)) throw new Error('请用 codex login 登录 ChatGPT 订阅账号。');
    const model = config.model.replace(/^openai\//, '');
    const output = path.join(cwd, 'reply.txt');
    await run(['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
      '--disable', 'shell_tool', '--disable', 'multi_agent', '--disable', 'apps',
      '-c', config.web ? 'web_search="live"' : 'web_search="disabled"', '-c', 'forced_login_method="chatgpt"', '-c', 'approval_policy="never"',
      '-c', 'model_reasoning_effort=' + JSON.stringify(config.effort),
      '-c', 'developer_instructions=' + JSON.stringify(config.messages[0].content + '\n只回答当前文书问题，直接输出 JSON。'),
      '-m', model, '--output-last-message', output, '-'], cwd, config.messages[1].content);
    const raw = (await readFile(output, 'utf8')).trim();
    if (!raw) throw new Error('Codex 没有返回评阅结果，请重试。');
    let parsed;
    try { parsed = JSON.parse(raw.replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '')); } catch {}
    return typeof parsed?.comment === 'string' || Array.isArray(parsed?.read) ? parsed : { comment: raw, edits: [] };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
