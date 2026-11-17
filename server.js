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
const os = require('os');

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
    autoSaveMs: 4000,
    imageRepo: 'milkmoli/milkmoliimg',
    imageBranch: 'main',
    imageDir: 'blog',
    imageCdn: 'https://cdn.jsdelivr.net/gh/{repo}@{branch}/{path}',
    imageCompress: { enable: true, maxWidth: 2400, quality: 82 },
    thumbCdn: 'https://images.weserv.nl/?url={url}&w=420&h=315&fit=cover&output=webp&q=72',
    githubToken: '',
    themeConfig: 'node_modules/hexo-theme-redefine/_config.yml'
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
const MAX_BODY = 60 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return resolve({ __tooBig: true });
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
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
    // 部署器会吞掉 git commit 的失败（比如没配 user.email），这里兜底检查
    const ct = git(['-C', path.join(BLOG, '.deploy_git'), 'log', '-1', '--format=%ct']).out;
    const ageSec = ct ? Date.now() / 1000 - Number(ct) : 0;
    if (ct && ageSec > 600) {
      push('warn', '警告：部署仓库没有产生新提交，线上可能还是旧版本。检查 .deploy_git 的 user.name / user.email');
    }
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

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (config.githubToken) return config.githubToken;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.git-credentials'), 'utf8');
    const m = raw.match(/https:\/\/([^:\n]+):([^@\n]+)@github\.com/);
    if (m) return m[2];
  } catch (e) {}
  return '';
}

let sharpLib = null;
function getSharp() {
  if (sharpLib === null) {
    try { sharpLib = require('sharp'); } catch (e) { sharpLib = false; }
  }
  return sharpLib;
}

/* 上传前压缩：限制最大宽度 + 按格式重新编码，尽量不掉画质 */
async function compressImage(buffer, ext) {
  var cfg = config.imageCompress || {};
  if (cfg.enable === false) return { buffer: buffer, info: null };
  if (['gif', 'svg'].indexOf(ext) >= 0) return { buffer: buffer, info: null };
  var sharp = getSharp();
  if (!sharp) return { buffer: buffer, info: null };

  try {
    var img = sharp(buffer, { failOn: 'none' }).rotate();
    var meta = await img.metadata();
    var maxWidth = cfg.maxWidth || 2400;
    if (meta.width && meta.width > maxWidth) img = img.resize({ width: maxWidth, withoutEnlargement: true });
    var quality = cfg.quality || 82;

    if (ext === 'jpg' || ext === 'jpeg') img = img.jpeg({ quality: quality, mozjpeg: true, progressive: true });
    else if (ext === 'png') img = img.png({ compressionLevel: 9, quality: quality, effort: 7 });
    else if (ext === 'webp') img = img.webp({ quality: quality, effort: 5 });
    else return { buffer: buffer, info: null };

    var out = await img.toBuffer();
    if (out.length >= buffer.length) return { buffer: buffer, info: null };
    return {
      buffer: out,
      info: {
        before: buffer.length,
        after: out.length,
        width: meta.width,
        height: meta.height,
        resized: !!(meta.width && meta.width > maxWidth)
      }
    };
  } catch (e) {
    push('warn', '压缩失败，按原图上传：' + e.message);
    return { buffer: buffer, info: null };
  }
}

async function uploadImage(name, base64) {
  const token = githubToken();
  if (!token) throw new Error('没有可用的 GitHub token（配置 githubToken 或登录过 git）');
  const ext = (path.extname(name) || '.png').toLowerCase().replace('.', '');
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].indexOf(ext) < 0) throw new Error('不支持的图片格式：' + ext);
  const raw = Buffer.from(base64, 'base64');
  const compressed = await compressImage(raw, ext);
  const payload = compressed.buffer;
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const base = path.basename(name, path.extname(name)).replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 40) || 'image';
  const file = base + '-' + Date.now().toString(36) + '.' + ext;
  const rel = [config.imageDir || 'blog', String(now.getFullYear()), month, file].filter(Boolean).join('/');
  const res = await fetch('https://api.github.com/repos/' + config.imageRepo + '/contents/' + rel, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + token,
      'User-Agent': 'hexo-blog-console',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: 'upload: ' + rel, content: payload.toString('base64'), branch: config.imageBranch || 'main' })
  });
  if (!res.ok) throw new Error('GitHub 上传失败：' + res.status + ' ' + (await res.text()).slice(0, 160));
  const cdn = (config.imageCdn || '').replace('{repo}', config.imageRepo).replace('{branch}', config.imageBranch || 'main').replace('{path}', rel);
  if (compressed.info) {
    push('ok', '已压缩 ' + Math.round(compressed.info.before / 1024) + 'KB → ' + Math.round(compressed.info.after / 1024) + 'KB');
  }
  push('ok', '已上传 ' + rel);
  imageCache.at = 0;
  return { url: cdn, path: rel, compress: compressed.info };
}

function cdnUrl(rel) {
  return (config.imageCdn || '').replace('{repo}', config.imageRepo).replace('{branch}', config.imageBranch || 'main').replace('{path}', rel);
}

var imageCache = { at: 0, items: [] };

async function listImages(force) {
  if (!force && Date.now() - imageCache.at < 120000) return imageCache.items;
  const token = githubToken();
  if (!token) throw new Error('没有可用的 GitHub token');
  const branch = config.imageBranch || 'main';
  const res = await fetch('https://api.github.com/repos/' + config.imageRepo + '/git/trees/' + branch + '?recursive=1', {
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'hexo-blog-console', Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) throw new Error('读取图床失败：' + res.status);
  const data = await res.json();
  const items = (data.tree || [])
    .filter(function (n) {
      return n.type === 'blob' && /\.(png|jpe?g|gif|webp|svg)$/i.test(n.path);
    })
    .map(function (n) {
      var full = cdnUrl(n.path);
      var thumb = config.thumbCdn
        ? config.thumbCdn.replace('{url}', encodeURIComponent(full)).replace('{raw}', full)
        : full;
      return { path: n.path, size: n.size || 0, url: full, thumb: thumb, name: n.path.split('/').pop() };
    })
    .sort(function (a, b) { return a.path < b.path ? 1 : -1; });
  imageCache = { at: Date.now(), items: items };
  return items;
}

async function deleteImage(rel) {
  const token = githubToken();
  if (!token) throw new Error('没有可用的 GitHub token');
  const api = 'https://api.github.com/repos/' + config.imageRepo + '/contents/' + rel;
  const info = await fetch(api + '?ref=' + (config.imageBranch || 'main'), {
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'hexo-blog-console', Accept: 'application/vnd.github+json' }
  });
  if (!info.ok) throw new Error('找不到图片：' + info.status);
  const meta = await info.json();
  const del = await fetch(api, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'hexo-blog-console', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'delete: ' + rel, sha: meta.sha, branch: config.imageBranch || 'main' })
  });
  if (!del.ok) throw new Error('删除失败：' + del.status);
  imageCache.at = 0;
  return true;
}

/* ---------- 页面（source 下的独立 md）---------- */
function pagePath(rel) {
  var clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!/^[^/]+(\/[^/]+)*\/index\.md$/.test(clean)) throw new Error('页面路径不合法');
  if (clean.indexOf('_posts/') === 0) throw new Error('这是文章，不是页面');
  return path.join(BLOG, 'source', clean);
}

function listPages() {
  var base = path.join(BLOG, 'source');
  var out = [];
  (function walk(dir, prefix) {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.forEach(function (e) {
      if (e.name === '_posts' || e.name === 'js' || e.name.startsWith('.')) return;
      var full = path.join(dir, e.name);
      var rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.name === 'index.md') {
        var text = fs.readFileSync(full, 'utf8');
        var fm = parseFrontMatter(text);
        out.push({
          path: rel,
          title: fm.data.title || rel.replace('/index.md', ''),
          type: fm.data.type || fm.data.layout || '',
          chars: fm.body.replace(/\s/g, '').length
        });
      }
    });
  })(base, '');
  return out.sort(function (a, b) { return a.path.localeCompare(b.path); });
}

/* ---------- 设置（主题 _config.yml）---------- */
function themeConfigPath() { return path.join(BLOG, config.themeConfig); }

function loadThemeConfig() {
  var yaml = require(path.join(BLOG, 'node_modules', 'js-yaml'));
  var file = themeConfigPath();
  var text = fs.readFileSync(file, 'utf8');
  return { yaml: yaml, text: text, data: yaml.load(text) };
}

function dumpString(v) {
  var s = String(v == null ? '' : v);
  return JSON.stringify(s);
}

function dumpLinks(links, indent) {
  var pad = ' '.repeat(indent);
  var out = pad + 'links:\n';
  Object.keys(links).forEach(function (k) {
    var item = links[k] || {};
    out += pad + '  ' + k + ':\n';
    out += pad + '    path: ' + dumpString(item.path || '/') + '\n';
    if (item.icon) out += pad + '    icon: ' + dumpString(item.icon) + '\n';
  });
  return out.replace(/\n$/, '');
}

function replaceKeyBlock(text, keys, blockText) {
  var lines = text.split('\n');
  var from = 0, parentIndent = -1, startIdx = -1, keyIndent = -1;
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    var found = -1, foundIndent = -1;
    for (var i = from; i < lines.length; i++) {
      var m = /^(\s*)([^\s#][^:]*?):(\s|$)/.exec(lines[i]);
      if (!m) continue;
      var ind = m[1].length;
      if (k === 0 && ind !== 0) continue;
      if (k > 0 && ind <= parentIndent) break;
      if (m[2] === key) { found = i; foundIndent = ind; break; }
    }
    if (found < 0) return null;
    from = found + 1; parentIndent = foundIndent; startIdx = found; keyIndent = foundIndent;
  }
  var endIdx = lines.length;
  for (var j = startIdx + 1; j < lines.length; j++) {
    var line = lines[j];
    if (!line.trim()) continue;
    var ind2 = line.match(/^\s*/)[0].length;
    if (ind2 <= keyIndent) { endIdx = j; break; }
  }
  var before = lines.slice(0, startIdx).join('\n');
  var after = lines.slice(endIdx).join('\n');
  return before + (before ? '\n' : '') + blockText + '\n' + after;
}

function normalizeLinks(obj) {
  var out = {};
  Object.keys(obj || {}).forEach(function (k) {
    var v = obj[k] || {};
    if (v.path) out[k] = { path: String(v.path), icon: v.icon ? String(v.icon) : '' };
  });
  return out;
}

function backupFile(full) {
  try {
    if (!fs.existsSync(full)) return;
    var dir = path.join(BLOG, '_backups');
    fs.mkdirSync(dir, { recursive: true });
    var stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(full, path.join(dir, path.basename(full) + '.' + stamp + '.bak'));
  } catch (e) { push('warn', '备份失败：' + e.message); }
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
    backupFile(p.full);
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
    backupFile(p.full);
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
  'GET /api/images': async (req, res, url) => {
    try {
      const items = await listImages(url.searchParams.get('refresh') === '1');
      send(res, 200, { items: items, total: items.length, repo: config.imageRepo, dir: '' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  },
  'POST /api/images/delete': async (req, res) => {
    const input = await readBody(req);
    if (!input.path) return send(res, 400, { error: '缺少图片路径' });
    try {
      await deleteImage(String(input.path));
      send(res, 200, { ok: true });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  },
  'GET /api/pages': (req, res) => {
    try { send(res, 200, { pages: listPages() }); }
    catch (e) { send(res, 500, { error: e.message }); }
  },
  'GET /api/page': (req, res, url) => {
    try {
      var p = pagePath(url.searchParams.get('path'));
      if (!fs.existsSync(p)) return send(res, 404, { error: '页面不存在' });
      send(res, 200, { path: url.searchParams.get('path'), content: fs.readFileSync(p, 'utf8') });
    } catch (e) { send(res, 400, { error: e.message }); }
  },
  'POST /api/page/save': async (req, res) => {
    const input = await readBody(req);
    try {
      var rel = String(input.path || '');
      var p = pagePath(rel);
      backupFile(p);
      fs.writeFileSync(p, String(input.content || ''), 'utf8');
      var commit = commitPaths('page: 更新 ' + rel, [path.join('source', rel)]);
      push('ok', '页面已保存 ' + rel);
      send(res, 200, { ok: true, git: commit });
    } catch (e) { send(res, 400, { error: e.message }); }
  },
  'GET /api/settings': (req, res) => {
    try {
      var loaded = loadThemeConfig();
      var data = loaded.data || {};
      var nav = (data.navbar && data.navbar.links) || {};
      var side = (data.home && data.home.sidebar) || {};
      send(res, 200, {
        navbarLinks: nav,
        sidebarLinks: side.links || {},
        announcement: side.announcement || '',
        footer: (data.footer && data.footer.customize) || '',
        file: config.themeConfig
      });
    } catch (e) { send(res, 500, { error: e.message }); }
  },
  'POST /api/settings': async (req, res) => {
    const input = await readBody(req);
    try {
      var loaded = loadThemeConfig();
      var text = loaded.text;
      var yaml = loaded.yaml;

      if (input.navbarLinks) {
        var block = dumpLinks(normalizeLinks(input.navbarLinks), 2);
        text = replaceKeyBlock(text, ['navbar', 'links'], block);
        if (!text) throw new Error('找不到 navbar.links 配置块');
      }
      if (input.sidebarLinks) {
        var block2 = dumpLinks(normalizeLinks(input.sidebarLinks), 4);
        text = replaceKeyBlock(text, ['home', 'sidebar', 'links'], block2);
        if (!text) throw new Error('找不到 home.sidebar.links 配置块');
      }
      if (typeof input.announcement === 'string') {
        var ann = input.announcement.trim();
        var line = '    announcement: ' + (ann ? dumpString(ann) : '') + ' # Announcement text';
        text = text.replace(/^\s*announcement:.*$/m, line);
      }
      if (typeof input.footer === 'string') {
        var f = input.footer.trim();
        text = text.replace(/^(\s*customize:).*$/m, '$1' + (f ? ' ' + dumpString(f) : ''));
      }

      // 校验：必须能解析，且三个值写进去了
      var parsed = yaml.load(text);
      if (!parsed || !parsed.navbar || !parsed.home) throw new Error('生成结果无法解析，已放弃写入');
      if (input.navbarLinks && !parsed.navbar.links) throw new Error('顶栏链接写入失败');
      if (input.sidebarLinks && !(parsed.home.sidebar && parsed.home.sidebar.links)) throw new Error('侧栏链接写入失败');

      var file = themeConfigPath();
      fs.copyFileSync(file, file + '.bak');
      fs.writeFileSync(file, text, 'utf8');
      // 主题配置在 node_modules 里不进 git，同步一份到仓库根目录并提交
      var backup = path.join(BLOG, 'theme-config.yml');
      fs.copyFileSync(file, backup);
      var commit = commitPaths('config: 更新主题配置', ['theme-config.yml']);
      push('ok', '主题配置已更新');
      send(res, 200, { ok: true, git: commit });
    } catch (e) { send(res, 500, { error: e.message }); }
  },
  'POST /api/upload': async (req, res) => {
    const input = await readBody(req);
    if (input.__tooBig) return send(res, 413, { error: '图片超过 45MB，请先压缩后再传' });
    if (!input.data) return send(res, 400, { error: '缺少图片数据' });
    try {
      const r = await uploadImage(String(input.name || 'image.png'), String(input.data));
      send(res, 200, { ok: true, url: r.url, path: r.path, compress: r.compress });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
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
