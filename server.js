#!/usr/bin/env node
/**
 * Hexo Blog Console - local web app for writing / previewing / publishing a Hexo blog.
 * Zero runtime dependencies (uses the blog's own hexo + marked).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadConfig() {
  const defaults = {
    blogDir: '',
    port: 4180,
    siteUrl: '',
    defaultCover: '',
    postsDir: 'source/_posts',
    hexoBin: 'node_modules/hexo-cli/bin/hexo',
    previewPort: 4000,
    autoSaveMs: 4000
  };
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
    catch (e) { console.error('config.json 解析失败：' + e.message); }
  }
  const cfg = Object.assign({}, defaults, user);
  if (!cfg.blogDir && process.argv[2]) cfg.blogDir = process.argv[2];
  if (!cfg.blogDir) cfg.blogDir = path.resolve(ROOT, '..', '..');
  cfg.blogDir = path.resolve(cfg.blogDir);
  return cfg;
}

const config = loadConfig();
const BLOG = config.blogDir;
const POSTS_DIR = path.join(BLOG, config.postsDir);
const HEXO_CLI = path.join(BLOG, config.hexoBin);
const TRASH_DIR = path.join(BLOG, '_trash');
const PORT = Number(config.port) || 4180;
const HOST = '127.0.0.1';

let logs = [];
let seq = 0;
let previewProc = null;
let publish = { running: false, phase: 'idle', startedAt: 0 };
let lastDeploy = '';

function push(level, raw) {
  const clean = String(raw).replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '');
  for (const line of clean.split('\n')) {
    if (!line.trim()) continue;
    seq += 1;
    logs.push({ id: seq, t: Date.now(), level, text: line.slice(0, 500) });
  }
  if (logs.length > 1200) logs = logs.slice(-1200);
}

function runHexo(args) {
  return new Promise((resolve) => {
    push('cmd', '$ hexo ' + args.join(' '));
    const p = spawn(process.execPath, [HEXO_CLI, ...args], { cwd: BLOG, windowsHide: true, env: Object.assign({}, process.env, { FORCE_COLOR: '0' }) });
    p.stdout.on('data', (d) => push('out', d));
    p.stderr.on('data', (d) => push('out', d));
    p.on('error', (e) => { push('err', e.message); resolve(-1); });
    p.on('close', (code) => resolve(code));
  });
}

/* ---------------- git ---------------- */
function git(args) {
  try {
    const r = spawnSync('git', args, { cwd: BLOG, encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
  } catch (e) { return { ok: false, out: '', err: e.message }; }
}
function repoDir() { return path.join(BLOG, '.git'); }
function gitState() {
  if (!fs.existsSync(repoDir())) return { ready: false, dirty: false, last: '', files: 0 };
  const st = git(['status', '--porcelain']);
  const lines = st.out ? st.out.split('\n').filter(Boolean) : [];
  const last = git(['log', '-1', '--format=%h %s']);
  return { ready: true, dirty: lines.length > 0, last: last.out, files: lines.length };
}
function commitPaths(message, paths) {
  if (!fs.existsSync(repoDir())) return { ok: false, reason: 'no-repo' };
  if (paths && paths.length) git(['add', '--'].concat(paths)); else git(['add', '-A']);
  if (!git(['status', '--porcelain']).out) return { ok: true, reason: 'clean' };
  const c = git(['commit', '-m', message]);
  if (!c.ok) { push('err', 'git 提交失败：' + c.err); return { ok: false, reason: c.err }; }
  const hash = git(['rev-parse', '--short', 'HEAD']).out;
  push('ok', 'git ' + hash + ' · ' + message);
  if (git(['remote']).out) {
    const ps = spawn('git', ['push'], { cwd: BLOG, windowsHide: true });
    ps.stdout.on('data', (d) => push('out', d));
    ps.stderr.on('data', (d) => push('out', d));
    ps.on('close', (code) => {
      if (code === 0) push('ok', '已推送到远端仓库');
      else push('err', '推送失败（下次提交会重试）：检查网络或凭据');
    });
  }
  return { ok: true, reason: 'committed', hash: hash };
}

/* ---------------- markdown ---------------- */
function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text, raw: '' };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    data[kv[1]] = value;
  }
  return { data, body: text.slice(m[0].length), raw: m[1] };
}

function setFrontMatter(text, fields) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const body = m ? text.slice(m[0].length) : text;
  const lines = m ? m[1].split(/\r?\n/) : [];
  const keys = Object.keys(fields);
  const seen = {};
  const out = [];
  for (const line of lines) {
    const kv = /^([A-Za-z_][\w-]*):/.exec(line);
    if (!kv || keys.indexOf(kv[1]) < 0) { out.push(line); continue; }
    seen[kv[1]] = true;
    const v = serialise(fields[kv[1]]);
    if (v !== null) out.push(kv[1] + ': ' + v);
  }
  for (const k of keys) {
    if (seen[k]) continue;
    const v = serialise(fields[k]);
    if (v !== null) out.push(k + ': ' + v);
  }
  return '---\n' + out.join('\n') + '\n---\n' + body;
}

function serialise(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) return v.length ? '[' + v.join(', ') + ']' : null;
  return String(v).trim();
}

function fmtList(v) {
  if (Array.isArray(v)) return v.join(', ');
  return v || '';
}
function toList(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

function buildPost(input) {
  const title = String(input.title || '').trim() || '无标题';
  const date = String(input.date || '').trim() || new Date().toISOString().slice(0, 10) + ' 00:00:00';
  const lines = ['---', 'title: ' + title, 'date: ' + date];
  const tags = toList(input.tags);
  const cats = toList(input.categories);
  if (tags.length) lines.push('tags: [' + tags.join(', ') + ']');
  if (cats.length) lines.push('categories: [' + cats.join(', ') + ']');
  if (input.cover) lines.push('cover: ' + input.cover);
  if (input.description) lines.push('description: ' + String(input.description).trim());
  lines.push('---', '', '# ' + title, '', '');
  return lines.join('\n');
}

function listPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  const items = [];
  for (const name of fs.readdirSync(POSTS_DIR)) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    const full = path.join(POSTS_DIR, name);
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
    const fm = parseFrontMatter(text);
    items.push({
      file: name,
      title: fm.data.title || name.replace(/\.md$/i, ''),
      date: fm.data.date || '',
      tags: fmtList(fm.data.tags),
      categories: fmtList(fm.data.categories),
      draft: name.startsWith('_'),
      chars: fm.body.replace(/\s/g, '').length,
      mtime: fs.statSync(full).mtimeMs
    });
  }
  return items.sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.mtime - a.mtime);
}

let markedLib = null;
function renderMarkdown(text) {
  if (markedLib === null) {
    try { const lib = require(path.join(BLOG, 'node_modules', 'marked')); markedLib = lib.marked || lib; }
    catch (e) { markedLib = false; }
  }
  if (!markedLib) return '<pre>' + String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
  return markedLib.parse(text);
}

/* ---------------- http ---------------- */
function send(res, code, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
  });
}
function postPath(file) {
  const name = path.basename(String(file || ''));
  if (!name.toLowerCase().endsWith('.md')) throw new Error('文件名不合法');
  return { name: name, full: path.join(POSTS_DIR, name) };
}

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

function stopPreview() {
  if (!previewProc) return;
  const pid = previewProc.pid;
  previewProc = null;
  try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch (e) {}
  push('info', '本地预览已停止');
}

async function startPreview() {
  if (previewProc) return true;
  const url = 'http://127.0.0.1:' + config.previewPort;
  push('cmd', '$ hexo server -p ' + config.previewPort);
  previewProc = spawn(process.execPath, [HEXO_CLI, 'server', '-p', String(config.previewPort)], { cwd: BLOG, windowsHide: true });
  previewProc.stdout.on('data', (d) => push('out', d));
  previewProc.stderr.on('data', (d) => push('out', d));
  previewProc.on('exit', () => { previewProc = null; });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    if (await ping(url + '/')) {
      spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true });
      return true;
    }
    if (!previewProc) return false;
  }
  return false;
}

function deployHint() {
  const recent = logs.slice(-45).map((l) => l.text).join('\n');
  if (/SSL certificate problem/i.test(recent)) return '：TLS 证书校验失败。执行 git config --global http.sslBackend schannel 后重试';
  if (/RPC failed|Connection was reset|Send failure|hung up unexpectedly/i.test(recent)) return '：大文件推送被中途重置。建议把 deploy 的 repo 改成 SSH（git@github.com:...），或精简站点体积';
  if (/Authentication failed|403 Forbidden|could not read Username|could not read Password/i.test(recent)) return '：GitHub 凭据失效。检查 git credential，或改用 SSH 部署';
  if (/ssh:|Permission denied \(publickey\)/i.test(recent)) return '：SSH 认证失败。确认 ssh -T git@github.com 能通，且公钥已加到 GitHub';
  if (!fs.existsSync(path.join(BLOG, 'node_modules', 'hexo-deployer-git'))) return '：没有安装 hexo-deployer-git，执行 npm i hexo-deployer-git';
  return '，请查看下方日志定位原因';
}

async function doPublish() {
  publish = { running: true, phase: 'commit', startedAt: Date.now() };
  try {
    const snap = commitPaths('publish: 站点更新 ' + new Date().toLocaleString('zh-CN'), null);
    if (snap.reason === 'no-repo') push('info', '源码仓库未初始化，跳过 git 提交');
    publish.phase = 'clean';
    if (await runHexo(['clean']) !== 0) throw new Error('clean 失败');
    publish.phase = 'generate';
    if (await runHexo(['generate']) !== 0) throw new Error('generate 失败');
    if (!fs.existsSync(path.join(BLOG, 'public', 'index.html'))) throw new Error('构建产物缺失');
    publish.phase = 'deploy';
    if (!fs.existsSync(path.join(BLOG, '.deploy_git', '.git'))) {
      push('warn', '警告：.deploy_git 不存在，本次会把整站全量上传（本站约 270MB），容易中途失败');
    }
    if (await runHexo(['deploy']) !== 0) throw new Error('deploy 失败' + deployHint());
    publish.phase = 'done';
    lastDeploy = new Date().toLocaleString('zh-CN');
    push('ok', '上线完成' + (config.siteUrl ? '：' + config.siteUrl : ''));
  } catch (e) {
    publish.phase = 'error';
    push('err', '发布中断：' + e.message);
  } finally {
    publish.running = false;
    setTimeout(() => { publish.phase = 'idle'; }, 6000);
  }
}

const routes = {
  'GET /api/health': (req, res) => send(res, 200, { ok: true }),
  'GET /api/config': (req, res) => send(res, 200, { blogDir: BLOG, siteUrl: config.siteUrl, previewPort: config.previewPort, autoSaveMs: config.autoSaveMs, defaultCover: config.defaultCover }),
  'GET /api/state': (req, res) => send(res, 200, { preview: !!previewProc, publish: publish, lastDeploy: lastDeploy, seq: seq, git: gitState() }),
  'GET /api/posts': (req, res) => send(res, 200, { posts: listPosts() }),
  'GET /api/post': (req, res, url) => {
    const p = postPath(url.searchParams.get('file'));
    if (!fs.existsSync(p.full)) return send(res, 404, { error: '文件不存在' });
    const content = fs.readFileSync(p.full, 'utf8');
    const fm = parseFrontMatter(content);
    send(res, 200, {
      file: p.name,
      content: content,
      meta: {
        title: fm.data.title || '',
        date: fm.data.date || '',
        tags: fmtList(fm.data.tags),
        categories: fmtList(fm.data.categories),
        description: fm.data.description || '',
        cover: fm.data.cover || ''
      }
    });
  },
  'GET /api/log': (req, res, url) => {
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    send(res, 200, { lines: logs.filter((l) => l.id > since), seq: seq });
  },
  'POST /api/new': async (req, res) => {
    const input = await readBody(req);
    const title = String(input.title || '').trim();
    if (!title) return send(res, 400, { error: '缺少标题' });
    const base = safeName(input.slug || title).replace(/^_+/, '') || 'untitled';
    let name = (input.draft ? '_' : '') + base + '.md';
    let i = 2;
    while (fs.existsSync(path.join(POSTS_DIR, name))) { name = (input.draft ? '_' : '') + base + '-' + i + '.md'; i += 1; }
    fs.mkdirSync(POSTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(POSTS_DIR, name), buildPost(Object.assign({}, input, { title: title })), 'utf8');
    const commit = commitPaths('post: 新建《' + name + '》', [path.join(config.postsDir, name)]);
    push('ok', '新建文章 ' + name);
    send(res, 200, { file: name, git: commit });
  },
  'POST /api/save': async (req, res) => {
    const input = await readBody(req);
    const p = postPath(input.file);
    if (fs.existsSync(p.full)) fs.copyFileSync(p.full, p.full + '.bak');
    fs.writeFileSync(p.full, String(input.content || ''), 'utf8');
    const commit = input.commit === false ? { ok: true, reason: 'skipped' } : commitPaths('post: 更新《' + p.name + '》', [path.join(config.postsDir, p.name)]);
    if (commit.hash) push('ok', '已保存并提交 ' + p.name);
    send(res, 200, { ok: true, file: p.name, git: commit, state: gitState() });
  },
  'POST /api/meta': async (req, res) => {
    const input = await readBody(req);
    const p = postPath(input.file);
    if (!fs.existsSync(p.full)) return send(res, 404, { error: '文件不存在' });
    const text = fs.readFileSync(p.full, 'utf8');
    const fields = input.fields || {};
    const next = setFrontMatter(text, {
      title: fields.title,
      date: fields.date,
      tags: toList(fields.tags),
      categories: toList(fields.categories),
      description: fields.description,
      cover: fields.cover
    });
    fs.copyFileSync(p.full, p.full + '.bak');
    fs.writeFileSync(p.full, next, 'utf8');
    const commit = commitPaths('post: 修改《' + p.name + '》的元信息', [path.join(config.postsDir, p.name)]);
    send(res, 200, { ok: true, file: p.name, git: commit, content: next, state: gitState() });
  },
  'POST /api/rename': async (req, res) => {
    const input = await readBody(req);
    const p = postPath(input.file);
    const target = safeName(input.name || '').replace(/\.md$/i, '');
    if (!target) return send(res, 400, { error: '新文件名不能为空' });
    const nextName = target + '.md';
    if (nextName === p.name) return send(res, 200, { ok: true, file: p.name });
    if (fs.existsSync(path.join(POSTS_DIR, nextName))) return send(res, 409, { error: '同名文件已存在' });
    fs.renameSync(p.full, path.join(POSTS_DIR, nextName));
    commitPaths('post: 重命名《' + p.name + '》→《' + nextName + '》', [config.postsDir]);
    send(res, 200, { ok: true, file: nextName, state: gitState() });
  },
  'POST /api/delete': async (req, res) => {
    const input = await readBody(req);
    const p = postPath(input.file);
    if (!fs.existsSync(p.full)) return send(res, 404, { error: '文件不存在' });
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(p.full, path.join(TRASH_DIR, stamp + '-' + p.name));
    commitPaths('post: 删除《' + p.name + '》（已移入 _trash）', [config.postsDir]);
    push('ok', '已移入 _trash：' + p.name);
    send(res, 200, { ok: true, state: gitState() });
  },
  'POST /api/render': async (req, res) => {
    const input = await readBody(req);
    const fm = parseFrontMatter(String(input.text || ''));
    let html = '';
    try { html = renderMarkdown(fm.body); } catch (e) { html = '<p>渲染失败：' + e.message + '</p>'; }
    send(res, 200, { html: html, chars: fm.body.replace(/\s/g, '').length });
  },
  'POST /api/publish': (req, res) => {
    if (publish.running) return send(res, 409, { error: '正在发布中' });
    doPublish();
    send(res, 200, { ok: true });
  },
  'POST /api/preview': async (req, res) => {
    const ok = await startPreview();
    send(res, ok ? 200 : 500, { ok: ok, url: 'http://127.0.0.1:' + config.previewPort });
  },
  'POST /api/stop-preview': (req, res) => { stopPreview(); send(res, 200, { ok: true }); },
  'POST /api/git-init': (req, res) => {
    if (!fs.existsSync(repoDir())) {
      const ignore = ['node_modules/', 'public/', '.deploy*/', 'db.json', '*.log', '*.bak', '.vscode/', '.DS_Store', '_backup-*/', '_trash/'];
      fs.writeFileSync(path.join(BLOG, '.gitignore'), ignore.join('\n') + '\n', 'utf8');
      git(['init', '-b', 'main']);
      push('ok', '已初始化源码仓库（main）');
    }
    const r = commitPaths('chore: 同步站点内容 ' + new Date().toLocaleString('zh-CN'), null);
    send(res, 200, Object.assign({ ok: true }, r, { state: gitState() }));
  },
  'POST /api/shutdown': (req, res) => { stopPreview(); send(res, 200, { ok: true }); setTimeout(() => process.exit(0), 200); }
};

const UI = path.join(ROOT, 'ui.html');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST + ':' + PORT);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200, fs.readFileSync(UI, 'utf8'));
  }
  const handler = routes[req.method + ' ' + url.pathname];
  if (!handler) return send(res, 404, { error: 'not found' });
  try { await handler(req, res, url); } catch (e) { send(res, 500, { error: e.message }); }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error('控制台已在运行：http://' + HOST + ':' + PORT); process.exit(0); }
  console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  try { fs.writeFileSync(path.join(ROOT, '.port'), String(PORT), 'utf8'); } catch (e) {}
  const last = spawnSync('git', ['log', '-1', '--format=%cd'], { cwd: path.join(BLOG, '.deploy_git'), encoding: 'utf8' });
  if (last.status === 0 && last.stdout.trim()) lastDeploy = new Date(last.stdout.trim()).toLocaleString('zh-CN');
  push('info', '控制台就绪 http://' + HOST + ':' + PORT);
  push('info', '博客目录 ' + BLOG);
  console.log('Blog console: http://' + HOST + ':' + PORT + '  ->  ' + BLOG);
});
