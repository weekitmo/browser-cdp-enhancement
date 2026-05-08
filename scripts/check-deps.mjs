#!/usr/bin/env node
// 环境检查 + 确保 CDP Proxy 就绪（跨平台，替代 check-deps.sh）

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 4567);
const CONFIG_FILE = path.join(ROOT, '.cdp-browser.json');

// --- 浏览器定义 ---

const BROWSERS = {
  'Google Chrome': {
    darwin: { app: 'Google Chrome', bin: null },
    linux: { app: null, bin: 'google-chrome' },
    win32: { app: null, bin: 'chrome.exe', paths: ['Google/Chrome/Application/chrome.exe'] },
  },
  'Brave Browser': {
    darwin: { app: 'Brave Browser', bin: null },
    linux: { app: null, bin: 'brave-browser' },
    win32: { app: null, bin: 'brave.exe', paths: ['BraveSoftware/Brave-Browser/Application/brave.exe'] },
  },
  'Vivaldi': {
    darwin: { app: 'Vivaldi', bin: null },
    linux: { app: null, bin: 'vivaldi' },
    win32: { app: null, bin: 'vivaldi.exe', paths: ['Vivaldi/Application/vivaldi.exe'] },
  },
  'Microsoft Edge': {
    darwin: { app: 'Microsoft Edge', bin: null },
    linux: { app: null, bin: 'microsoft-edge' },
    win32: { app: null, bin: 'msedge.exe', paths: ['Microsoft/Edge/Application/msedge.exe'] },
  },
};

// --- Node.js 版本检查 ---

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const version = `v${process.versions.node}`;
  if (major >= 22) {
    console.log(`node: ok (${version})`);
  } else {
    console.log(`node: warn (${version}, 建议升级到 22+)`);
  }
}

// --- TCP 端口探测 ---

function checkPort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// --- 浏览器检测 ---

function detectInstalledBrowsers() {
  const platform = os.platform();
  const found = [];

  for (const [name, defs] of Object.entries(BROWSERS)) {
    const def = defs[platform];
    if (!def) continue;

    if (platform === 'darwin' && def.app) {
      const appPath = `/Applications/${def.app}.app`;
      if (fs.existsSync(appPath)) {
        found.push({ name, path: appPath });
      }
    } else if (platform === 'linux' && def.bin) {
      try {
        const binPath = execSync(`which ${def.bin} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (binPath) {
          found.push({ name, path: binPath });
        }
      } catch { /* not found */ }
    } else if (platform === 'win32' && def.paths) {
      const localAppData = process.env.LOCALAPPDATA || '';
      const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
      const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      for (const rel of def.paths) {
        for (const base of [localAppData, programFiles, programFilesX86]) {
          const fullPath = path.join(base, rel);
          if (fs.existsSync(fullPath)) {
            found.push({ name, path: fullPath });
            break;
          }
        }
      }
    }
  }

  return found;
}

function buildLaunchCmd(browserName) {
  const platform = os.platform();
  const args = ['--remote-debugging-port=9222', '--remote-allow-origins=*'];

  if (platform === 'darwin') {
    return { cmd: 'open', args: ['-a', browserName, '--args', ...args] };
  } else {
    const def = BROWSERS[browserName]?.[platform];
    const bin = def?.bin || browserName.toLowerCase().replace(/\s+/g, '-');
    return { cmd: bin, args };
  }
}

// --- 配置读写 ---

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(browserName) {
  const launch = buildLaunchCmd(browserName);
  const config = {
    browser: browserName,
    platform: os.platform(),
    launchCmd: launch.cmd,
    launchArgs: launch.args,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  return config;
}

// --- 启动浏览器 ---

function launchBrowser(config) {
  const child = spawn(config.launchCmd, config.launchArgs || [], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`browser: launching ${config.browser}...`);
}

// --- DevToolsActivePort 检测（按配置浏览器优先，并用 /json/version 校验） ---
function activePortEntries() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (os.platform()) {
    case 'darwin':
      return [
        { browser: 'Google Chrome', file: path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort') },
        { browser: 'Google Chrome Canary', file: path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort') },
        { browser: 'Chromium', file: path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort') },
        { browser: 'Brave Browser', file: path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort') },
        { browser: 'Vivaldi', file: path.join(home, 'Library/Application Support/Vivaldi/DevToolsActivePort') },
        { browser: 'Microsoft Edge', file: path.join(home, 'Library/Application Support/Microsoft Edge/DevToolsActivePort') },
      ];
    case 'linux':
      return [
        { browser: 'Google Chrome', file: path.join(home, '.config/google-chrome/DevToolsActivePort') },
        { browser: 'Chromium', file: path.join(home, '.config/chromium/DevToolsActivePort') },
        { browser: 'Brave Browser', file: path.join(home, '.config/BraveSoftware/Brave-Browser/DevToolsActivePort') },
        { browser: 'Vivaldi', file: path.join(home, '.config/vivaldi/DevToolsActivePort') },
        { browser: 'Microsoft Edge', file: path.join(home, '.config/microsoft-edge/DevToolsActivePort') },
      ];
    case 'win32':
      return [
        { browser: 'Google Chrome', file: path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort') },
        { browser: 'Chromium', file: path.join(localAppData, 'Chromium/User Data/DevToolsActivePort') },
        { browser: 'Brave Browser', file: path.join(localAppData, 'BraveSoftware/Brave-Browser/User Data/DevToolsActivePort') },
        { browser: 'Vivaldi', file: path.join(localAppData, 'Vivaldi/User Data/DevToolsActivePort') },
        { browser: 'Microsoft Edge', file: path.join(localAppData, 'Microsoft/Edge/User Data/DevToolsActivePort') },
      ];
    default:
      return [];
  }
}

function orderedActivePortEntries() {
  const configured = readConfig()?.browser || null;
  const entries = activePortEntries();
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
    return data?.webSocketDebuggerUrl ? data : null;
  } catch {
    return null;
  }
}

async function validDebugPort(port) {
  if (!(port > 0 && port < 65536)) return null;
  if (!await checkPort(port)) return null;
  return await browserVersion(port) ? port : null;
}

async function detectChromePort() {
  const { preferred, rest } = orderedActivePortEntries();
  const tryEntries = async (entries) => {
    for (const entry of entries) {
      try {
        const lines = fs.readFileSync(entry.file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
        const port = parseInt(lines[0], 10);
        const valid = await validDebugPort(port);
        if (valid) return valid;
      } catch (_) {}
    }
    return null;
  };

  const preferredPort = await tryEntries(preferred);
  if (preferredPort) return preferredPort;

  for (const port of [9222, 9229, 9333]) {
    const valid = await validDebugPort(port);
    if (valid) return valid;
  }

  return await tryEntries(rest);
}

// --- CDP Proxy 启动与等待 ---

function httpGetJson(url, timeoutMs = 3000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then(async (res) => {
      try { return JSON.parse(await res.text()); } catch { return null; }
    })
    .catch(() => null);
}

function startProxyDetached() {
  const logFile = path.join(os.tmpdir(), 'cdp-proxy.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);
}

async function ensureProxy() {
  const targetsUrl = `http://127.0.0.1:${PROXY_PORT}/targets`;

  // /targets 返回 JSON 数组即 ready
  const targets = await httpGetJson(targetsUrl);
  if (Array.isArray(targets)) {
    console.log('proxy: ready');
    return true;
  }

  // 未运行或未连接，启动并等待
  console.log('proxy: connecting...');
  startProxyDetached();

  // 等 proxy 进程就绪
  await new Promise((r) => setTimeout(r, 2000));

  for (let i = 1; i <= 15; i++) {
    const result = await httpGetJson(targetsUrl, 8000);
    if (Array.isArray(result)) {
      console.log('proxy: ready');
      return true;
    }
    if (i === 1) {
      console.log('⚠️  等待浏览器连接中...');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('❌ 连接超时，请检查浏览器调试设置');
  console.log(`  日志：${path.join(os.tmpdir(), 'cdp-proxy.log')}`);
  return false;
}

// --- CLI 参数处理 ---

const args = process.argv.slice(2);

// --detect: 输出已安装浏览器 JSON 列表
if (args.includes('--detect')) {
  const browsers = detectInstalledBrowsers();
  console.log(JSON.stringify(browsers, null, 2));
  process.exit(0);
}

// --launch <browser>: 启动指定浏览器并连接
const launchIdx = args.indexOf('--launch');
if (launchIdx !== -1) {
  const browserName = args[launchIdx + 1];
  if (!browserName) {
    console.error('❌ --launch 需要指定浏览器名称');
    process.exit(1);
  }
  const config = writeConfig(browserName);
  launchBrowser(config);
  // 等待浏览器启动并开启调试端口
  console.log('browser: waiting for debug port...');
  let port = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    port = await detectChromePort();
    if (port) break;
  }
  if (!port) {
    console.log('❌ 浏览器启动超时，未检测到调试端口');
    process.exit(1);
  }
  console.log(`chrome: ok (port ${port})`);
  const proxyOk = await ensureProxy();
  process.exit(proxyOk ? 0 : 1);
}

// --- main ---

async function main() {
  checkNode();

  const chromePort = await detectChromePort();
  if (chromePort) {
    console.log(`chrome: ok (port ${chromePort})`);
    const proxyOk = await ensureProxy();
    if (!proxyOk) process.exit(1);
    printSitePatterns();
    return;
  }

  // 没有检测到调试端口 — 尝试自动启动
  const config = readConfig();
  if (config) {
    launchBrowser(config);
    console.log('browser: waiting for debug port...');
    let port = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      port = await detectChromePort();
      if (port) break;
    }
    if (port) {
      console.log(`chrome: ok (port ${port})`);
      const proxyOk = await ensureProxy();
      if (!proxyOk) process.exit(1);
      printSitePatterns();
      return;
    }
    console.log('⚠️  保存的浏览器配置启动失败，需要重新选择');
  }

  // 无配置或启动失败 — 输出可用浏览器供 agent 引导用户选择
  const installed = detectInstalledBrowsers();
  if (installed.length === 0) {
    console.log('❌ 未检测到已安装的 Chromium 系浏览器（Chrome / Brave / Vivaldi / Edge）');
    process.exit(1);
  }

  console.log('status: no_browser');
  console.log('installed: ' + JSON.stringify(installed.map(b => b.name)));
  console.log('hint: 请使用 --launch "<浏览器名>" 启动，或让 agent 引导用户选择');
  process.exit(2);
}

function printSitePatterns() {
  const patternsDir = path.join(ROOT, 'references', 'site-experience');
  try {
    const sites = fs.readdirSync(patternsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
    if (sites.length) {
      console.log(`\nsite-experience: ${sites.join(', ')}`);
    }
  } catch {}
}

await main();
