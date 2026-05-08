#!/usr/bin/env node
// CDP Proxy - 通过 HTTP API 操控用户日常 Chromium 系浏览器
// 要求：浏览器已开启 --remote-debugging-port
// Node.js 22+（使用原生 WebSocket）

import http from 'node:http';
import { URL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, '.cdp-browser.json');
const PORT = parseInt(process.env.CDP_PROXY_PORT || '4567');
let ws = null;
let cmdId = 0;
const pending = new Map(); // id -> {resolve, timer}
const sessions = new Map(); // targetId -> sessionId
const managedTabs = new Map(); // targetId -> { lastAccessed: number }
const TAB_IDLE_TIMEOUT = parseInt(process.env.CDP_TAB_IDLE_TIMEOUT || '900000'); // 15 min default
const CLEANUP_INTERVAL = 60000; // sweep every 60s

// --- Console 日志捕获 ---
const consoleLogs = new Map(); // sessionId -> { entries: [], enabled: bool }
const MAX_LOG_ENTRIES = 500;

// --- WebSocket 兼容层 ---
let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  // Node 22+ 原生 WebSocket（浏览器兼容 API）
  WS = globalThis.WebSocket;
} else {
  // 回退到 ws 模块
  try {
    WS = (await import('ws')).default;
  } catch {
    console.error('[CDP Proxy] 错误：Node.js 版本 < 22 且未安装 ws 模块');
    console.error('  解决方案：升级到 Node.js 22+ 或执行 npm install -g ws');
    process.exit(1);
  }
}

// --- 自动发现浏览器调试端口 ---
function readConfiguredBrowser() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return typeof config?.browser === 'string' ? config.browser : null;
  } catch {
    return null;
  }
}

function browserActivePortEntries() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  const platform = os.platform();

  if (platform === 'darwin') {
    return [
      { browser: 'Google Chrome', file: path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort') },
      { browser: 'Google Chrome Canary', file: path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort') },
      { browser: 'Chromium', file: path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort') },
      { browser: 'Brave Browser', file: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort') },
      { browser: 'Vivaldi', file: path.join(home, 'Library/Application Support/Vivaldi/DevToolsActivePort') },
      { browser: 'Microsoft Edge', file: path.join(home, 'Library/Application Support/Microsoft Edge/DevToolsActivePort') },
    ];
  }
  if (platform === 'linux') {
    return [
      { browser: 'Google Chrome', file: path.join(home, '.config/google-chrome/DevToolsActivePort') },
      { browser: 'Chromium', file: path.join(home, '.config/chromium/DevToolsActivePort') },
      { browser: 'Brave Browser', file: path.join(home, '.config/BraveSoftware/Brave-Browser/DevToolsActivePort') },
      { browser: 'Vivaldi', file: path.join(home, '.config/vivaldi/DevToolsActivePort') },
      { browser: 'Microsoft Edge', file: path.join(home, '.config/microsoft-edge/DevToolsActivePort') },
    ];
  }
  if (platform === 'win32') {
    return [
      { browser: 'Google Chrome', file: path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort') },
      { browser: 'Chromium', file: path.join(localAppData, 'Chromium/User Data/DevToolsActivePort') },
      { browser: 'Brave Browser', file: path.join(localAppData, 'BraveSoftware/Brave-Browser/User Data/DevToolsActivePort') },
      { browser: 'Vivaldi', file: path.join(localAppData, 'Vivaldi/User Data/DevToolsActivePort') },
      { browser: 'Microsoft Edge', file: path.join(localAppData, 'Microsoft/Edge/User Data/DevToolsActivePort') },
    ];
  }
  return [];
}

function orderedActivePortEntries() {
  const configured = readConfiguredBrowser();
  const entries = browserActivePortEntries();
  if (!configured) return { preferred: [], rest: entries };
  return {
    preferred: entries.filter(e => e.browser === configured),
    rest: entries.filter(e => e.browser !== configured),
  };
}

async function browserVersion(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.webSocketDebuggerUrl) return null;
    return data;
  } catch {
    return null;
  }
}

async function candidateFromPort(port, source, staleWsPath = null) {
  if (!(port > 0 && port < 65536)) return null;
  if (!await checkPort(port)) return null;
  const version = await browserVersion(port);
  if (!version) return null;
  return {
    port,
    source,
    staleWsPath,
    browser: version.Browser || 'unknown',
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
  };
}

async function discoverChromePort() {
  // 1. 先尝试配置浏览器自己的 DevToolsActivePort。
  // 2. 若配置浏览器没有写 ActivePort（Vivaldi 常见），先扫描常用端口。
  // 3. 最后才看其他浏览器的 ActivePort，且始终以 /json/version 的当前 WebSocket URL 为准。
  const { preferred, rest } = orderedActivePortEntries();
  const tryEntries = async (entries) => {
    for (const entry of entries) {
      try {
        const content = fs.readFileSync(entry.file, 'utf-8').trim();
        const lines = content.split(/\r?\n/).filter(Boolean);
        const port = parseInt(lines[0], 10);
        const candidate = await candidateFromPort(port, `${entry.browser} DevToolsActivePort`, lines[1] || null);
        if (candidate) {
          console.log(`[CDP Proxy] 从 ${entry.browser} DevToolsActivePort 发现端口: ${candidate.port}，当前浏览器: ${candidate.browser}`);
          return candidate;
        }
      } catch { /* 文件不存在或不可读，继续 */ }
    }
    return null;
  };

  const preferredCandidate = await tryEntries(preferred);
  if (preferredCandidate) return preferredCandidate;

  const commonPorts = [9222, 9229, 9333];
  for (const port of commonPorts) {
    const candidate = await candidateFromPort(port, `port scan ${port}`);
    if (candidate) {
      console.log(`[CDP Proxy] 扫描发现浏览器调试端口: ${candidate.port}，当前浏览器: ${candidate.browser}`);
      return candidate;
    }
  }

  return await tryEntries(rest);
}

// 用 TCP 探测端口是否监听——避免 WebSocket 连接触发 浏览器安全弹窗
// （WebSocket 探测会被 Chrome 视为调试连接，弹出授权对话框）
function checkPort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// --- WebSocket 连接管理 ---
let chromePort = null;
let chromeWebSocketUrl = null;

let connectingPromise = null;
async function connect() {
  if (ws && (ws.readyState === WS.OPEN || ws.readyState === 1)) return;
  if (connectingPromise) return connectingPromise;  // 复用进行中的连接

  if (!chromePort) {
    const discovered = await discoverChromePort();
    if (!discovered) {
      throw new Error(
        '未发现已开启远程调试的浏览器。请确保以下任一浏览器已打开：\n' +
        '  Chrome:  在地址栏访问 chrome://inspect/#remote-debugging 并勾选 Allow remote debugging\n' +
        '  Brave:   在地址栏访问 chrome://inspect/#remote-debugging 并勾选 Allow remote debugging\n' +
        '  Vivaldi: 在地址栏访问 vivaldi://inspect/#remote-debugging 并勾选 Allow remote debugging\n' +
        '  Edge:    在地址栏访问 edge://inspect/#remote-debugging 并勾选 Allow remote debugging\n' +
        '  或用命令行启动: <browser> --remote-debugging-port=9222'
      );
    }
    chromePort = discovered.port;
    chromeWebSocketUrl = discovered.webSocketDebuggerUrl;
  }

  const wsUrl = chromeWebSocketUrl;
  if (!wsUrl) throw new Error('无法获取浏览器 WebSocket URL');

  return connectingPromise = new Promise((resolve, reject) => {
    ws = new WS(wsUrl);

    const onOpen = () => {
      cleanup();
      connectingPromise = null;
      console.log(`[CDP Proxy] 已连接浏览器 (端口 ${chromePort})`);
      resolve();
    };
    const onError = (e) => {
      cleanup();
      connectingPromise = null;
      ws = null;
      chromePort = null;
      chromeWebSocketUrl = null;
      const msg = e.message || e.error?.message || '连接失败';
      console.error('[CDP Proxy] 连接错误:', msg, '（端口缓存已清除，下次将重新发现）');
      reject(new Error(msg));
    };
    const onClose = () => {
      console.log('[CDP Proxy] 连接断开');
      ws = null;
      chromePort = null; // 重置端口缓存，下次连接重新发现
      chromeWebSocketUrl = null;
      sessions.clear();
      managedTabs.clear();
      consoleLogs.clear();
    };
    const onMessage = (evt) => {
      const data = typeof evt === 'string' ? evt : (evt.data || evt);
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString());

      if (msg.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = msg.params;
        sessions.set(targetInfo.targetId, sessionId);
      }
      // 捕获 Console 日志事件
      if (msg.method === 'Runtime.consoleAPICalled') {
        const { type, args, timestamp, stackTrace } = msg.params;
        const sessionId = msg.sessionId;
        if (sessionId && consoleLogs.has(sessionId)) {
          const log = consoleLogs.get(sessionId);
          const text = args.map(a => a.value ?? a.description ?? a.type ?? '').join(' ');
          const stack = stackTrace?.callFrames?.map(f => `at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber}:${f.columnNumber})`).join('\n') || '';
          log.entries.push({ type, text, args: args.map(a => a.value ?? a.description ?? ''), timestamp, stack });
          if (log.entries.length > MAX_LOG_ENTRIES) log.entries.splice(0, log.entries.length - MAX_LOG_ENTRIES);
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const { exceptionDetails, timestamp } = msg.params;
        const sessionId = msg.sessionId;
        if (sessionId && consoleLogs.has(sessionId)) {
          const log = consoleLogs.get(sessionId);
          const text = exceptionDetails.text || '';
          const desc = exceptionDetails.exception?.description || '';
          const stack = exceptionDetails.stackTrace?.callFrames?.map(f => `at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber}:${f.columnNumber})`).join('\n') || '';
          log.entries.push({ type: 'error', text: desc || text, args: [desc || text], timestamp: timestamp || Date.now(), stack });
          if (log.entries.length > MAX_LOG_ENTRIES) log.entries.splice(0, log.entries.length - MAX_LOG_ENTRIES);
        }
      }
      // 拦截页面对 浏览器调试端口的探测请求（反风控）
      if (msg.method === 'Fetch.requestPaused') {
        const { requestId, sessionId: sid } = msg.params;
        sendCDP('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sid).catch(() => {});
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    };

    function cleanup() {
      ws.removeEventListener?.('open', onOpen);
      ws.removeEventListener?.('error', onError);
    }

    // 兼容 Node 原生 WebSocket 和 ws 模块的事件 API
    if (ws.on) {
      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.on('message', onMessage);
    } else {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
      ws.addEventListener('message', onMessage);
    }
  });
}

function sendCDP(method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) {
      return reject(new Error('WebSocket 未连接'));
    }
    const id = ++cmdId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP 命令超时: ' + method));
    }, 30000);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify(msg));
  });
}

// 已启用端口拦截的 session 集合（避免重复启用）
const portGuardedSessions = new Set();

async function ensureSession(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const resp = await sendCDP('Target.attachToTarget', { targetId, flatten: true });
  if (resp.result?.sessionId) {
    const sid = resp.result.sessionId;
    sessions.set(targetId, sid);
    // 启用调试端口探测拦截
    await enablePortGuard(sid);
    return sid;
  }
  throw new Error('attach 失败: ' + JSON.stringify(resp.error));
}

// 拦截页面对 浏览器调试端口的探测（反风控）
// 只拦截 127.0.0.1:{chromePort} 的请求，不影响其他任何本地服务
async function enablePortGuard(sessionId) {
  if (!chromePort || portGuardedSessions.has(sessionId)) return;
  try {
    await sendCDP('Fetch.enable', {
      patterns: [
        { urlPattern: `http://127.0.0.1:${chromePort}/*`, requestStage: 'Request' },
        { urlPattern: `http://localhost:${chromePort}/*`, requestStage: 'Request' },
      ]
    }, sessionId);
    portGuardedSessions.add(sessionId);
  } catch { /* Fetch 域启用失败不影响主流程 */ }
}

// --- Console 日志管理 ---
async function enableConsole(sessionId) {
  await sendCDP('Runtime.enable', {}, sessionId);
  consoleLogs.set(sessionId, { entries: [], enabled: true });
}

// --- Accessibility Tree 辅助 ---
function axValue(field) {
  return field && typeof field === 'object' && 'value' in field ? field.value : field;
}

function axProperties(node) {
  const out = {};
  for (const prop of node.properties || []) {
    out[prop.name] = axValue(prop.value);
  }
  return out;
}

function axSummary(node) {
  return {
    axNodeId: node.nodeId,
    backendDOMNodeId: node.backendDOMNodeId,
    role: axValue(node.role) || '',
    name: axValue(node.name) || '',
    description: axValue(node.description) || '',
    value: axValue(node.value),
    properties: axProperties(node),
  };
}

function matchesText(actual, expected, exact) {
  if (expected == null || expected === '') return true;
  const a = String(actual || '').toLowerCase();
  const e = String(expected).toLowerCase();
  return exact ? a === e : a.includes(e);
}

function parseBool(value) {
  return value === true || value === '1' || value === 'true' || value === 'yes';
}

async function findAXNodes(sessionId, criteria = {}) {
  await sendCDP('Accessibility.enable', {}, sessionId);
  const resp = await sendCDP('Accessibility.getFullAXTree', {}, sessionId);
  const nodes = resp.result?.nodes || [];
  const role = criteria.role || '';
  const name = criteria.name || '';
  const exact = parseBool(criteria.exact);
  const props = criteria.properties || {};

  return nodes
    .map(axSummary)
    .filter(node => {
      if (!matchesText(node.role, role, true)) return false;
      if (!matchesText(node.name, name, exact)) return false;
      for (const [key, expected] of Object.entries(props)) {
        if (!matchesText(node.properties?.[key], expected, true)) return false;
      }
      return true;
    });
}

function boxCenter(model) {
  const quad = model?.content || model?.border || model?.padding || [];
  if (quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    x: xs.reduce((sum, n) => sum + n, 0) / xs.length,
    y: ys.reduce((sum, n) => sum + n, 0) / ys.length,
  };
}

async function clickAXNode(sessionId, node) {
  if (!node.backendDOMNodeId) {
    throw new Error(`AX 节点缺少 backendDOMNodeId，无法映射到 DOM: ${node.role} ${node.name}`);
  }
  await sendCDP('DOM.enable', {}, sessionId);
  try {
    await sendCDP('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendDOMNodeId }, sessionId);
  } catch { /* 某些节点/浏览器版本可能不支持，继续尝试取 box */ }
  const box = await sendCDP('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId }, sessionId);
  const center = boxCenter(box.result?.model);
  if (!center) throw new Error(`无法获取 AX 节点坐标: ${node.role} ${node.name}`);
  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1
  }, sessionId);
  await sendCDP('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: center.x, y: center.y, button: 'left', clickCount: 1
  }, sessionId);
  return center;
}

// --- 闲置 Tab 自动清理 ---
function touchTab(targetId) {
  const entry = managedTabs.get(targetId);
  if (entry) entry.lastAccessed = Date.now();
}

async function cleanupIdleTabs() {
  if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) return;
  const now = Date.now();
  for (const [targetId, info] of managedTabs) {
    if (now - info.lastAccessed < TAB_IDLE_TIMEOUT) continue;
    try { await sendCDP('Target.closeTarget', { targetId }); } catch { /* tab may already be closed */ }
    sessions.delete(targetId);
    managedTabs.delete(targetId);
    console.log(`[CDP Proxy] Auto-closed idle tab: ${targetId}`);
  }
}

async function closeAllManagedTabs() {
  if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) return;
  const targets = [...managedTabs.keys()];
  for (const targetId of targets) {
    try { await sendCDP('Target.closeTarget', { targetId }); } catch { /* ignore */ }
    sessions.delete(targetId);
    managedTabs.delete(targetId);
  }
  if (targets.length) console.log(`[CDP Proxy] Shutdown: closed ${targets.length} managed tab(s)`);
}

// --- 等待页面加载 ---
async function waitForLoad(sessionId, timeoutMs = 15000) {
  // 启用 Page 域
  await sendCDP('Page.enable', {}, sessionId);

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(checkInterval);
      resolve(result);
    };

    const timer = setTimeout(() => done('timeout'), timeoutMs);
    const checkInterval = setInterval(async () => {
      try {
        const resp = await sendCDP('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        }, sessionId);
        if (resp.result?.result?.value === 'complete') {
          done('complete');
        }
      } catch { /* 忽略 */ }
    }, 500);
  });
}

// --- 读取 POST body ---
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// --- HTTP API ---
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);
  if (q.target) touchTab(q.target);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // /health 不需要连接 Chrome
    if (pathname === '/health') {
      const connected = ws && (ws.readyState === WS.OPEN || ws.readyState === 1);
      res.end(JSON.stringify({ status: 'ok', connected, sessions: sessions.size, managedTabs: managedTabs.size, chromePort }));
      return;
    }

    await connect();

    // GET /targets - 列出所有页面
    if (pathname === '/targets') {
      const resp = await sendCDP('Target.getTargets');
      const pages = resp.result.targetInfos.filter(t => t.type === 'page');
      res.end(JSON.stringify(pages, null, 2));
    }

    // GET /new?url=xxx - 创建新后台 tab
    else if (pathname === '/new') {
      const targetUrl = q.url || 'about:blank';
      const resp = await sendCDP('Target.createTarget', { url: targetUrl, background: true });
      const targetId = resp.result.targetId;
      managedTabs.set(targetId, { lastAccessed: Date.now() });

      // 等待页面加载
      if (targetUrl !== 'about:blank') {
        try {
          const sid = await ensureSession(targetId);
          await waitForLoad(sid);
        } catch { /* 非致命，继续 */ }
      }

      res.end(JSON.stringify({ targetId }));
    }

    // GET /close?target=xxx - 关闭 tab
    else if (pathname === '/close') {
      const sid = sessions.get(q.target);
      const resp = await sendCDP('Target.closeTarget', { targetId: q.target });
      if (sid) consoleLogs.delete(sid);
      sessions.delete(q.target);
      managedTabs.delete(q.target);
      res.end(JSON.stringify(resp.result));
    }

    // GET /navigate?target=xxx&url=yyy - 导航（自动等待加载）
    else if (pathname === '/navigate') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Page.navigate', { url: q.url }, sid);

      // 等待页面加载完成
      await waitForLoad(sid);

      res.end(JSON.stringify(resp.result));
    }

    // GET /back?target=xxx - 后退
    else if (pathname === '/back') {
      const sid = await ensureSession(q.target);
      await sendCDP('Runtime.evaluate', { expression: 'history.back()' }, sid);
      await waitForLoad(sid);
      res.end(JSON.stringify({ ok: true }));
    }

    // POST /eval?target=xxx - 执行 JS
    else if (pathname === '/eval') {
      const sid = await ensureSession(q.target);
      const body = await readBody(req);
      const expr = body || q.expr || 'document.title';
      const resp = await sendCDP('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value !== undefined) {
        res.end(JSON.stringify({ value: resp.result.result.value }));
      } else if (resp.result?.exceptionDetails) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: resp.result.exceptionDetails.text }));
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /click?target=xxx - 点击（body 为 CSS 选择器）
    // POST /click?target=xxx — JS 层面点击（简单快速，覆盖大多数场景）
    else if (pathname === '/click') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value) {
        const val = resp.result.result.value;
        if (val.error) {
          res.statusCode = 400;
          res.end(JSON.stringify(val));
        } else {
          res.end(JSON.stringify(val));
        }
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /clickAt?target=xxx — CDP 浏览器级真实鼠标点击（算用户手势，能触发文件对话框、绕过反自动化检测）
    else if (pathname === '/clickAt') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const coordResp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      const coord = coordResp.result?.result?.value;
      if (!coord || coord.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(coord || coordResp.result));
        return;
      }
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      res.end(JSON.stringify({ clicked: true, x: coord.x, y: coord.y, tag: coord.tag, text: coord.text }));
    }

    // GET /ax?target=xxx&role=button&name=提交&exact=1 - 查询 Accessibility Tree
    else if (pathname === '/ax') {
      const sid = await ensureSession(q.target);
      const nodes = await findAXNodes(sid, {
        role: q.role,
        name: q.name,
        exact: q.exact,
      });
      const limit = parseInt(q.limit || '50', 10);
      const out = Number.isFinite(limit) && limit > 0 ? nodes.slice(0, limit) : nodes;
      res.end(JSON.stringify({ nodes: out, count: nodes.length }, null, 2));
    }

    // POST /clickAX?target=xxx - body: JSON { "role": "button", "name": "提交", "exact": true }
    // 基于 Accessibility Tree 定位，再用 DOM backendNodeId 映射成真实坐标点击。
    else if (pathname === '/clickAX') {
      const sid = await ensureSession(q.target);
      const raw = await readBody(req);
      let body = {};
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'POST body 需要 JSON，如 {"role":"button","name":"提交"}' }));
          return;
        }
      }
      const criteria = {
        role: body.role ?? q.role,
        name: body.name ?? q.name,
        exact: body.exact ?? q.exact,
        properties: body.properties || {},
      };
      if (!criteria.role && !criteria.name) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 role 或 name 作为 AX 查询条件' }));
        return;
      }
      const nodes = await findAXNodes(sid, criteria);
      if (!nodes.length) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: '未找到匹配的 AX 节点', criteria }));
        return;
      }
      const index = Number(body.index ?? q.index ?? 0);
      const node = nodes[index];
      if (!node) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: `index 超出范围: ${index}`, count: nodes.length }));
        return;
      }
      const center = await clickAXNode(sid, node);
      res.end(JSON.stringify({ clicked: true, x: center.x, y: center.y, node, matchCount: nodes.length }));
    }

    // POST /setFiles?target=xxx — 给 file input 设置本地文件（绕过文件对话框）
    // body: JSON { "selector": "input[type=file]", "files": ["/path/to/file1.png", "/path/to/file2.png"] }
    else if (pathname === '/setFiles') {
      const sid = await ensureSession(q.target);
      const body = JSON.parse(await readBody(req));
      if (!body.selector || !body.files) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 selector 和 files 字段' }));
        return;
      }
      // 获取 DOM 节点
      await sendCDP('DOM.enable', {}, sid);
      const doc = await sendCDP('DOM.getDocument', {}, sid);
      const node = await sendCDP('DOM.querySelector', {
        nodeId: doc.result.root.nodeId,
        selector: body.selector
      }, sid);
      if (!node.result?.nodeId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '未找到元素: ' + body.selector }));
        return;
      }
      // 设置文件
      await sendCDP('DOM.setFileInputFiles', {
        nodeId: node.result.nodeId,
        files: body.files
      }, sid);
      res.end(JSON.stringify({ success: true, files: body.files.length }));
    }

    // GET /scroll?target=xxx&y=3000 - 滚动
    else if (pathname === '/scroll') {
      const sid = await ensureSession(q.target);
      const y = parseInt(q.y || '3000');
      const direction = q.direction || 'down'; // down | up | top | bottom
      let js;
      if (direction === 'top') {
        js = 'window.scrollTo(0, 0); "scrolled to top"';
      } else if (direction === 'bottom') {
        js = 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"';
      } else if (direction === 'up') {
        js = `window.scrollBy(0, -${Math.abs(y)}); "scrolled up ${Math.abs(y)}px"`;
      } else {
        js = `window.scrollBy(0, ${Math.abs(y)}); "scrolled down ${Math.abs(y)}px"`;
      }
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
      }, sid);
      // 等待懒加载触发
      await new Promise(r => setTimeout(r, 800));
      res.end(JSON.stringify({ value: resp.result?.result?.value }));
    }

    // GET /screenshot?target=xxx&file=/tmp/x.png - 截图
    else if (pathname === '/screenshot') {
      const sid = await ensureSession(q.target);
      const format = q.format || 'png';
      const resp = await sendCDP('Page.captureScreenshot', {
        format,
        quality: format === 'jpeg' ? 80 : undefined,
      }, sid);
      if (q.file) {
        fs.writeFileSync(q.file, Buffer.from(resp.result.data, 'base64'));
        res.end(JSON.stringify({ saved: q.file }));
      } else {
        res.setHeader('Content-Type', 'image/' + format);
        res.end(Buffer.from(resp.result.data, 'base64'));
      }
    }

    // GET /info?target=xxx - 获取页面信息
    else if (pathname === '/info') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})',
        returnByValue: true,
      }, sid);
      res.end(resp.result?.result?.value || '{}');
    }

    // GET /console/enable?target=xxx - 开启 console 日志捕获
    else if (pathname === '/console/enable') {
      const sid = await ensureSession(q.target);
      await enableConsole(sid);
      res.end(JSON.stringify({ ok: true, sessionId: sid }));
    }

    // GET /console?target=xxx&level=error&limit=50&clear=1 - 获取 console 日志
    else if (pathname === '/console') {
      const sid = await ensureSession(q.target);
      if (!consoleLogs.has(sid)) {
        res.end(JSON.stringify({ entries: [], count: 0, hint: '未开启日志捕获，请先调用 /console/enable' }));
        return;
      }
      const log = consoleLogs.get(sid);
      let entries = [...log.entries];
      // level 过滤
      if (q.level) {
        const levels = q.level.split(',').map(s => s.trim().toLowerCase());
        entries = entries.filter(e => levels.includes(e.type.toLowerCase()));
      }
      // limit
      if (q.limit) {
        const n = parseInt(q.limit);
        if (n > 0 && n < entries.length) entries = entries.slice(-n);
      }
      // clear
      if (q.clear === '1' || q.clear === 'true') {
        log.entries = [];
      }
      res.end(JSON.stringify({ entries, count: entries.length }));
    }

    // GET /console/clear?target=xxx - 清空日志缓冲区
    else if (pathname === '/console/clear') {
      const sid = await ensureSession(q.target);
      if (consoleLogs.has(sid)) {
        consoleLogs.get(sid).entries = [];
      }
      res.end(JSON.stringify({ ok: true }));
    }

    else {
      res.statusCode = 404;
      res.end(JSON.stringify({
        error: '未知端点',
        endpoints: {
          '/health': 'GET - 健康检查',
          '/targets': 'GET - 列出所有页面 tab',
          '/new?url=': 'GET - 创建新后台 tab（自动等待加载）',
          '/close?target=': 'GET - 关闭 tab',
          '/navigate?target=&url=': 'GET - 导航（自动等待加载）',
          '/back?target=': 'GET - 后退',
          '/info?target=': 'GET - 页面标题/URL/状态',
          '/eval?target=': 'POST body=JS表达式 - 执行 JS',
          '/click?target=': 'POST body=CSS选择器 - 点击元素',
          '/ax?target=&role=&name=': 'GET - 查询 Accessibility Tree 节点',
          '/clickAX?target=': 'POST body=JSON - 按 AX role/name 定位并真实点击',
          '/scroll?target=&y=&direction=': 'GET - 滚动页面',
          '/screenshot?target=&file=': 'GET - 截图',
          '/console/enable?target=': 'GET - 开启 console 日志捕获',
          '/console?target=&level=&limit=&clear=': 'GET - 获取 console 日志',
          '/console/clear?target=': 'GET - 清空日志缓冲区',
        },
      }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

// 检查端口是否被占用
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  // 检查是否已有 proxy 在运行
  const available = await checkPortAvailable(PORT);
  if (!available) {
    // 验证已有实例是否健康
    try {
      const ok = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 2000 }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(d.includes('"ok"')));
        }).on('error', () => resolve(false));
      });
      if (ok) {
        console.log(`[CDP Proxy] 已有实例运行在端口 ${PORT}，退出`);
        process.exit(0);
      }
    } catch { /* 端口占用但非 proxy，继续报错 */ }
    console.error(`[CDP Proxy] 端口 ${PORT} 已被占用`);
    process.exit(1);
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[CDP Proxy] 运行在 http://localhost:${PORT}`);
    // 启动时尝试连接 浏览器（非阻塞）
    connect().catch(e => console.error('[CDP Proxy] 初始连接失败:', e.message, '（将在首次请求时重试）'));
  });

  // 定时清理闲置 tab
  const cleanupTimer = setInterval(cleanupIdleTabs, CLEANUP_INTERVAL);
  cleanupTimer.unref();

  const shutdown = async (sig) => {
    console.log(`[CDP Proxy] ${sig}, cleaning up...`);
    clearInterval(cleanupTimer);
    await closeAllManagedTabs();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 防止未捕获异常导致进程崩溃
process.on('uncaughtException', (e) => {
  console.error('[CDP Proxy] 未捕获异常:', e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('[CDP Proxy] 未处理拒绝:', e?.message || e);
});

main();
