#!/usr/bin/env node
// find-url - 从本地 Chromium 系浏览器书签/历史中检索 URL
// 用于定位公网搜索覆盖不到的目标（组织内部系统、SSO 后台、内网域名等）。
//
// 用法：
//   node find-url.mjs [关键词...] [--browser chrome|brave|vivaldi|edge|all] [--only bookmarks|history] [--limit N] [--since 1d|7h|YYYY-MM-DD]
//
//   <关键词>            空格分词、多词 AND，匹配 title + url；可省略
//   --browser <name>    浏览器：chrome / brave / vivaldi / edge / all；默认使用 .cdp-browser.json 中选择的浏览器，找不到则查全部
//   --only <source>     限定数据源（bookmarks / history），默认两者都查
//   --limit N           条数上限，默认 20；0 = 不限
//   --since <window>    时间窗（仅作用于历史）。1d / 7h / 30m 或 YYYY-MM-DD
//   --sort recent|visits  历史排序：按最近访问 / 按访问次数，默认 recent
//
// 示例：
//   node find-url.mjs 财务小智
//   node find-url.mjs agent skills
//   node find-url.mjs github --since 7d --only history
//   node find-url.mjs --since 7d --only history --sort visits   # 最近一周高频网站
//   node find-url.mjs --since 2d --only history --limit 0

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, '.cdp-browser.json');

// --- 参数解析 -----------------------------------------------------------
function parseArgs(argv) {
  const a = { keywords: [], browser: null, only: null, limit: 20, since: null, sort: 'recent' };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--browser')     a.browser = normalizeBrowserName(argv[++i]);
    else if (v === '--only')   a.only  = argv[++i];
    else if (v === '--limit')  a.limit = parseInt(argv[++i], 10);
    else if (v === '--since')  a.since = parseSince(argv[++i]);
    else if (v === '--sort')   a.sort  = argv[++i];
    else if (v === '-h' || v === '--help') { printUsage(); process.exit(0); }
    else if (v.startsWith('--')) die(`未知参数: ${v}`);
    else a.keywords.push(v);
  }
  if (a.only && !['bookmarks', 'history'].includes(a.only)) die(`--only 仅支持 bookmarks|history`);
  if (!['recent', 'visits'].includes(a.sort)) die(`--sort 仅支持 recent|visits`);
  if (Number.isNaN(a.limit) || a.limit < 0) die('--limit 需为非负整数');
  return a;
}

function parseSince(s) {
  if (!s) die('--since 需要值');
  const m = s.match(/^(\d+)([dhm])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const ms = { d: 86400000, h: 3600000, m: 60000 }[m[2]];
    return new Date(Date.now() - n * ms);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) die(`无效 --since 值: ${s}（用 1d / 7h / 30m / YYYY-MM-DD）`);
  return d;
}

function die(msg) { console.error(msg); process.exit(1); }
function printUsage() { console.error(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 19).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); }

// --- 浏览器用户数据目录（跨平台） ----------------------------------------
const BROWSER_ALIASES = new Map([
  ['chrome', 'Google Chrome'],
  ['googlechrome', 'Google Chrome'],
  ['google-chrome', 'Google Chrome'],
  ['google chrome', 'Google Chrome'],
  ['brave', 'Brave Browser'],
  ['bravebrowser', 'Brave Browser'],
  ['brave-browser', 'Brave Browser'],
  ['brave browser', 'Brave Browser'],
  ['vivaldi', 'Vivaldi'],
  ['edge', 'Microsoft Edge'],
  ['msedge', 'Microsoft Edge'],
  ['microsoftedge', 'Microsoft Edge'],
  ['microsoft-edge', 'Microsoft Edge'],
  ['microsoft edge', 'Microsoft Edge'],
  ['all', 'all'],
]);

function normalizeBrowserName(value) {
  if (!value) die('--browser 需要值');
  const raw = String(value).trim();
  const key = raw.toLowerCase().replace(/[\s_]+/g, ' ');
  const compact = key.replace(/[\s-]+/g, '');
  const normalized = BROWSER_ALIASES.get(key) || BROWSER_ALIASES.get(compact) || BROWSER_ALIASES.get(raw.toLowerCase());
  if (!normalized) die(`--browser 仅支持 chrome|brave|vivaldi|edge|all（收到: ${value}）`);
  return normalized;
}

function readConfiguredBrowser() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return config?.browser ? normalizeBrowserName(config.browser) : null;
  } catch {
    return null;
  }
}

function browserDataDirMap() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (os.platform()) {
    case 'darwin':
      return {
        'Google Chrome': path.join(home, 'Library/Application Support/Google/Chrome'),
        'Brave Browser': path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser'),
        'Vivaldi': path.join(home, 'Library/Application Support/Vivaldi'),
        'Microsoft Edge': path.join(home, 'Library/Application Support/Microsoft Edge'),
      };
    case 'linux':
      return {
        'Google Chrome': path.join(home, '.config/google-chrome'),
        'Brave Browser': path.join(home, '.config/BraveSoftware/Brave-Browser'),
        'Vivaldi': path.join(home, '.config/vivaldi'),
        'Microsoft Edge': path.join(home, '.config/microsoft-edge'),
      };
    case 'win32':
      return {
        'Google Chrome': path.join(localAppData, 'Google/Chrome/User Data'),
        'Brave Browser': path.join(localAppData, 'BraveSoftware/Brave-Browser/User Data'),
        'Vivaldi': path.join(localAppData, 'Vivaldi/User Data'),
        'Microsoft Edge': path.join(localAppData, 'Microsoft/Edge/User Data'),
      };
    default:
      return {};
  }
}

function existingBrowserDirs(requestedBrowser) {
  const dirs = browserDataDirMap();
  const existing = (names) => names
    .map(name => ({ browser: name, dir: dirs[name] }))
    .filter(x => x.dir && fs.existsSync(x.dir));

  if (requestedBrowser && requestedBrowser !== 'all') return existing([requestedBrowser]);
  if (requestedBrowser === 'all') return existing(Object.keys(dirs));

  const configured = readConfiguredBrowser();
  if (configured && configured !== 'all') {
    const configuredDirs = existing([configured]);
    if (configuredDirs.length) return configuredDirs;
  }

  return existing(Object.keys(dirs));
}

// --- Profile 枚举 -------------------------------------------------------
function listProfiles(dataDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'Local State'), 'utf-8'));
    const info = state?.profile?.info_cache || {};
    const list = Object.keys(info).map(dir => ({ dir, name: info[dir].name || dir }));
    if (list.length) return list;
  } catch { /* 回退 */ }
  return [{ dir: 'Default', name: 'Default' }];
}

// --- 书签检索 -----------------------------------------------------------
function searchBookmarks(browserName, profileDir, profileName, keywords) {
  const file = path.join(profileDir, 'Bookmarks');
  if (!fs.existsSync(file)) return [];
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
  if (!keywords.length) return [];  // 书签无时间维度，无关键词不返回

  const needles = keywords.map(k => k.toLowerCase());
  const out = [];
  function walk(node, trail) {
    if (!node) return;
    if (node.type === 'url') {
      const hay = `${node.name || ''} ${node.url || ''}`.toLowerCase();
      if (needles.every(n => hay.includes(n))) {
        out.push({ browser: browserName, profile: profileName, name: node.name || '', url: node.url || '', folder: trail.join(' / ') });
      }
    }
    if (Array.isArray(node.children)) {
      const sub = node.name ? [...trail, node.name] : trail;
      for (const c of node.children) walk(c, sub);
    }
  }
  for (const root of Object.values(data.roots || {})) walk(root, []);
  return out;
}

// --- 历史检索（SQLite 运行时锁定，需 copy 到 tmp） ------------------------
const WEBKIT_EPOCH_DIFF_US = 11644473600000000n;  // 1601→1970 微秒差

function searchHistory(browserName, profileDir, profileName, keywords, since, limit, sort) {
  const src = path.join(profileDir, 'History');
  if (!fs.existsSync(src)) return [];
  const safeBrowser = browserName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const tmp = path.join(os.tmpdir(), `browser-history-${safeBrowser}-${process.pid}-${Date.now()}.sqlite`);
  try {
    fs.copyFileSync(src, tmp);
    const conds = ['last_visit_time > 0'];
    for (const kw of keywords) {
      const esc = kw.toLowerCase().replace(/'/g, "''");
      conds.push(`LOWER(title || ' ' || url) LIKE '%${esc}%'`);
    }
    if (since) {
      const webkitUs = BigInt(since.getTime()) * 1000n + WEBKIT_EPOCH_DIFF_US;
      conds.push(`last_visit_time >= ${webkitUs}`);
    }
    const limitClause = limit === 0 ? -1 : limit;
    const orderBy = sort === 'visits'
      ? 'visit_count DESC, last_visit_time DESC'
      : 'last_visit_time DESC';
    const sql = `SELECT title, url,
      datetime((last_visit_time - 11644473600000000)/1000000, 'unixepoch', 'localtime') AS visit,
      visit_count
      FROM urls WHERE ${conds.join(' AND ')}
      ORDER BY ${orderBy} LIMIT ${limitClause};`;

    const raw = execFileSync('sqlite3', ['-separator', '\t', tmp, sql], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const [title, url, visit, visit_count] = line.split('\t');
      return { browser: browserName, profile: profileName, title, url, visit, visit_count: parseInt(visit_count, 10) };
    });
  } catch (e) {
    if (e.code === 'ENOENT') die('未找到 sqlite3 命令。macOS/Linux 通常自带；Windows 可用 `winget install sqlite.sqlite` 或从 https://sqlite.org/download.html 下载后加入 PATH。');
    return [];
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// --- 输出格式化 ---------------------------------------------------------
// 用 `|` 作字段分隔符；字段内含 `|` 的替换成 `│`（全宽竖线）避免歧义
const clean = s => String(s ?? '').replaceAll('|', '│').trim();

function scopeLabel(item, showScope) {
  if (!showScope) return null;
  return `@${clean(item.browser)}/${clean(item.profile)}`;
}

function printBookmarks(items, showScope) {
  console.log(`[书签] ${items.length} 条`);
  for (const b of items) {
    const segs = [clean(b.name) || '(无标题)', clean(b.url)];
    if (b.folder) segs.push(clean(b.folder));
    const scope = scopeLabel(b, showScope);
    if (scope) segs.push(scope);
    console.log('  ' + segs.join(' | '));
  }
}

function printHistory(items, showScope, sortLabel) {
  console.log(`[历史] ${items.length} 条（${sortLabel}）`);
  for (const h of items) {
    const segs = [clean(h.title) || '(无标题)', clean(h.url), h.visit];
    if (h.visit_count > 1) segs.push(`visits=${h.visit_count}`);
    const scope = scopeLabel(h, showScope);
    if (scope) segs.push(scope);
    console.log('  ' + segs.join(' | '));
  }
}

// --- main ---------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));

const browserDirs = existingBrowserDirs(args.browser);
if (!browserDirs.length) {
  const target = args.browser && args.browser !== 'all' ? args.browser : 'Chrome / Brave / Vivaldi / Edge';
  die(`未找到 ${target} 用户数据目录`);
}

const doBookmarks = args.only !== 'history';
const doHistory   = args.only !== 'bookmarks';

const bookmarks = [];
const history = [];
for (const browserDir of browserDirs) {
  const profiles = listProfiles(browserDir.dir);
  for (const p of profiles) {
    const pDir = path.join(browserDir.dir, p.dir);
    if (!fs.existsSync(pDir)) continue;
    if (doBookmarks) bookmarks.push(...searchBookmarks(browserDir.browser, pDir, p.name, args.keywords));
    if (doHistory)   history.push(...searchHistory(browserDir.browser, pDir, p.name, args.keywords, args.since, args.limit === 0 ? 0 : args.limit * 2, args.sort));
  }
}

// 历史跨 profile 合并后按指定 sort 重排 + 切顶
if (args.sort === 'visits') {
  history.sort((a, b) => (b.visit_count || 0) - (a.visit_count || 0) || (b.visit || '').localeCompare(a.visit || ''));
} else {
  history.sort((a, b) => (b.visit || '').localeCompare(a.visit || ''));
}
const bookmarksOut = args.limit === 0 ? bookmarks : bookmarks.slice(0, args.limit);
const historyOut   = args.limit === 0 ? history   : history.slice(0, args.limit);

// 仅当结果真的横跨多个浏览器/profile 时，才输出 @browser/profile 标注（空 profile 不算）
const seenScopes = new Set([...bookmarksOut, ...historyOut].map(x => `${x.browser}/${x.profile}`));
const showScope = seenScopes.size > 1;

const sortLabel = args.sort === 'visits' ? '按访问次数' : '按最近访问';
if (doBookmarks) printBookmarks(bookmarksOut, showScope);
if (doBookmarks && doHistory) console.log();
if (doHistory)   printHistory(historyOut, showScope, sortLabel);

if (!args.keywords.length && doBookmarks && !doHistory) {
  console.error('\n提示：书签无时间维度，无关键词查询无意义。加关键词或切换 --only history。');
}
