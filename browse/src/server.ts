/**
 * gstack browse server — persistent Chromium daemon
 *
 * Architecture:
 *   Bun.serve HTTP on localhost → routes commands to Playwright
 *   Console/network/dialog buffers: CircularBuffer in-memory + async disk flush
 *   Chromium crash → server EXITS with clear error (CLI auto-restarts)
 *   Auto-shutdown after BROWSE_IDLE_TIMEOUT (default 30 min)
 */

import { BrowserManager } from './browser-manager';
import { handleReadCommand } from './read-commands';
import { handleWriteCommand } from './write-commands';
import { handleMetaCommand } from './meta-commands';
import { handleCookiePickerRoute } from './cookie-picker-routes';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Auth (inline) ─────────────────────────────────────────────
const AUTH_TOKEN = crypto.randomUUID();
const PORT_OFFSET = 45600;
const BROWSE_PORT = process.env.CONDUCTOR_PORT
  ? parseInt(process.env.CONDUCTOR_PORT, 10) - PORT_OFFSET
  : parseInt(process.env.BROWSE_PORT || '0', 10); // 0 = auto-scan
const INSTANCE_SUFFIX = BROWSE_PORT ? `-${BROWSE_PORT}` : '';
const STATE_FILE = process.env.BROWSE_STATE_FILE || `/tmp/browse-server${INSTANCE_SUFFIX}.json`;
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSE_IDLE_TIMEOUT || '1800000', 10); // 30 min

function validateAuth(req: Request): boolean {
  const header = req.headers.get('authorization');
  return header === `Bearer ${AUTH_TOKEN}`;
}

// ─── Buffer (from buffers.ts) ────────────────────────────────────
import { consoleBuffer, networkBuffer, dialogBuffer, addConsoleEntry, addNetworkEntry, addDialogEntry, type LogEntry, type NetworkEntry, type DialogEntry } from './buffers';
export { consoleBuffer, networkBuffer, dialogBuffer, addConsoleEntry, addNetworkEntry, addDialogEntry, type LogEntry, type NetworkEntry, type DialogEntry };

const CONSOLE_LOG_PATH = `/tmp/browse-console${INSTANCE_SUFFIX}.log`;
const NETWORK_LOG_PATH = `/tmp/browse-network${INSTANCE_SUFFIX}.log`;
const DIALOG_LOG_PATH = `/tmp/browse-dialog${INSTANCE_SUFFIX}.log`;
let lastConsoleFlushed = 0;
let lastNetworkFlushed = 0;
let lastDialogFlushed = 0;
let flushInProgress = false;

async function flushBuffers() {
  if (flushInProgress) return; // Guard against concurrent flush
  flushInProgress = true;

  try {
    // Console buffer
    const newConsoleCount = consoleBuffer.totalAdded - lastConsoleFlushed;
    if (newConsoleCount > 0) {
      const entries = consoleBuffer.last(Math.min(newConsoleCount, consoleBuffer.length));
      const lines = entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
      ).join('\n') + '\n';
      const existing = fs.existsSync(CONSOLE_LOG_PATH) ? fs.readFileSync(CONSOLE_LOG_PATH, 'utf-8') : '';
      fs.writeFileSync(CONSOLE_LOG_PATH, existing + lines);
      lastConsoleFlushed = consoleBuffer.totalAdded;
    }

    // Network buffer
    const newNetworkCount = networkBuffer.totalAdded - lastNetworkFlushed;
    if (newNetworkCount > 0) {
      const entries = networkBuffer.last(Math.min(newNetworkCount, networkBuffer.length));
      const lines = entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] ${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
      ).join('\n') + '\n';
      const existingNet = fs.existsSync(NETWORK_LOG_PATH) ? fs.readFileSync(NETWORK_LOG_PATH, 'utf-8') : '';
      fs.writeFileSync(NETWORK_LOG_PATH, existingNet + lines);
      lastNetworkFlushed = networkBuffer.totalAdded;
    }

    // Dialog buffer
    const newDialogCount = dialogBuffer.totalAdded - lastDialogFlushed;
    if (newDialogCount > 0) {
      const entries = dialogBuffer.last(Math.min(newDialogCount, dialogBuffer.length));
      const lines = entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.type}] "${e.message}" → ${e.action}${e.response ? ` "${e.response}"` : ''}`
      ).join('\n') + '\n';
      const existingDlg = fs.existsSync(DIALOG_LOG_PATH) ? fs.readFileSync(DIALOG_LOG_PATH, 'utf-8') : '';
      fs.writeFileSync(DIALOG_LOG_PATH, existingDlg + lines);
      lastDialogFlushed = dialogBuffer.totalAdded;
    }
  } catch {
    // Flush failures are non-fatal — buffers are in memory
  } finally {
    flushInProgress = false;
  }
}

// Flush every 1 second
const flushInterval = setInterval(flushBuffers, 1000);

// ─── Idle Timer ────────────────────────────────────────────────
let lastActivity = Date.now();

function resetIdleTimer() {
  lastActivity = Date.now();
}

const idleCheckInterval = setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    console.log(`[browse] Idle for ${IDLE_TIMEOUT_MS / 1000}s, shutting down`);
    shutdown();
  }
}, 60_000);

// ─── Command Sets (exported for chain command) ──────────────────
export const READ_COMMANDS = new Set([
  'text', 'html', 'links', 'forms', 'accessibility',
  'js', 'eval', 'css', 'attrs',
  'console', 'network', 'cookies', 'storage', 'perf',
  'dialog', 'is',
]);

export const WRITE_COMMANDS = new Set([
  'goto', 'back', 'forward', 'reload',
  'click', 'fill', 'select', 'hover', 'type', 'press', 'scroll', 'wait',
  'viewport', 'cookie', 'cookie-import', 'cookie-import-browser', 'header', 'useragent',
  'upload', 'dialog-accept', 'dialog-dismiss',
]);

export const META_COMMANDS = new Set([
  'tabs', 'tab', 'newtab', 'closetab',
  'status', 'stop', 'restart',
  'screenshot', 'pdf', 'responsive',
  'chain', 'diff',
  'url', 'snapshot',
]);

// ─── Server ────────────────────────────────────────────────────
const browserManager = new BrowserManager();
let isShuttingDown = false;

// Check if a port is available
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port, '127.0.0.1');
  });
}

// Find port: deterministic from CONDUCTOR_PORT, or scan range
async function findPort(): Promise<number> {
  // Deterministic port from CONDUCTOR_PORT (e.g., 55040 - 45600 = 9440)
  if (BROWSE_PORT) {
    if (await isPortAvailable(BROWSE_PORT)) return BROWSE_PORT;
    throw new Error(`[browse] Port ${BROWSE_PORT} (from CONDUCTOR_PORT ${process.env.CONDUCTOR_PORT}) is in use`);
  }

  // Fallback: scan range
  const start = parseInt(process.env.BROWSE_PORT_START || '9400', 10);
  for (let port = start; port < start + 10; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`[browse] No available port in range ${start}-${start + 9}`);
}

/**
 * Translate Playwright errors into actionable messages for AI agents.
 */
function wrapError(err: any): string {
  const msg = err.message || String(err);
  // Timeout errors
  if (err.name === 'TimeoutError' || msg.includes('Timeout') || msg.includes('timeout')) {
    if (msg.includes('locator.click') || msg.includes('locator.fill') || msg.includes('locator.hover')) {
      return `Element not found or not interactable within timeout. Check your selector or run 'snapshot' for fresh refs.`;
    }
    if (msg.includes('page.goto') || msg.includes('Navigation')) {
      return `Page navigation timed out. The URL may be unreachable or the page may be loading slowly.`;
    }
    return `Operation timed out: ${msg.split('\n')[0]}`;
  }
  // Multiple elements matched
  if (msg.includes('resolved to') && msg.includes('elements')) {
    return `Selector matched multiple elements. Be more specific or use @refs from 'snapshot'.`;
  }
  // Pass through other errors
  return msg;
}

async function handleCommand(body: any): Promise<Response> {
  const { command, args = [] } = body;

  if (!command) {
    return new Response(JSON.stringify({ error: 'Missing "command" field' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    let result: string;

    if (READ_COMMANDS.has(command)) {
      result = await handleReadCommand(command, args, browserManager);
    } else if (WRITE_COMMANDS.has(command)) {
      result = await handleWriteCommand(command, args, browserManager);
    } else if (META_COMMANDS.has(command)) {
      result = await handleMetaCommand(command, args, browserManager, shutdown);
    } else {
      return new Response(JSON.stringify({
        error: `Unknown command: ${command}`,
        hint: `Available commands: ${[...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS].sort().join(', ')}`,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(result, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: wrapError(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('[browse] Shutting down...');
  clearInterval(flushInterval);
  clearInterval(idleCheckInterval);
  await flushBuffers(); // Final flush (async now)

  await browserManager.close();

  // Clean up state file
  try { fs.unlinkSync(STATE_FILE); } catch {}

  process.exit(0);
}

// Handle signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Start ─────────────────────────────────────────────────────
async function start() {
  // Clear old log files
  try { fs.unlinkSync(CONSOLE_LOG_PATH); } catch {}
  try { fs.unlinkSync(NETWORK_LOG_PATH); } catch {}
  try { fs.unlinkSync(DIALOG_LOG_PATH); } catch {}

  const port = await findPort();

  // Launch browser
  await browserManager.launch();

  const startTime = Date.now();

  // Helper: read full request body
  function readBody(nodeReq: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      nodeReq.on('data', (chunk: Buffer) => chunks.push(chunk));
      nodeReq.on('end', () => resolve(Buffer.concat(chunks).toString()));
      nodeReq.on('error', reject);
    });
  }

  // Helper: convert Node req to Web API Request
  function toWebRequest(nodeReq: http.IncomingMessage, url: URL, body?: string): Request {
    const headers = new Headers();
    for (const [key, value] of Object.entries(nodeReq.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    return new Request(url.toString(), {
      method: nodeReq.method,
      headers,
      body: nodeReq.method === 'POST' ? body : undefined,
    });
  }

  // Helper: send Web API Response to Node res
  async function sendResponse(nodeRes: http.ServerResponse, response: Response) {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    nodeRes.writeHead(response.status, headers);
    nodeRes.end(await response.text());
  }

  const server = http.createServer(async (nodeReq, nodeRes) => {
    resetIdleTimer();

    const url = new URL(nodeReq.url!, `http://127.0.0.1:${port}`);

    // Read body for POST
    const body = nodeReq.method === 'POST' ? await readBody(nodeReq) : undefined;

    // Cookie picker routes — no auth required (localhost-only)
    if (url.pathname.startsWith('/cookie-picker')) {
      const webReq = toWebRequest(nodeReq, url, body);
      const response = await handleCookiePickerRoute(url, webReq, browserManager);
      return sendResponse(nodeRes, response);
    }

    // Health check — no auth required (now async)
    if (url.pathname === '/health') {
      const healthy = await browserManager.isHealthy();
      const response = new Response(JSON.stringify({
        status: healthy ? 'healthy' : 'unhealthy',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        tabs: browserManager.getTabCount(),
        currentUrl: browserManager.getCurrentUrl(),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      return sendResponse(nodeRes, response);
    }

    // All other endpoints require auth
    const authHeader = nodeReq.headers['authorization'];
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      const response = new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
      return sendResponse(nodeRes, response);
    }

    if (url.pathname === '/command' && nodeReq.method === 'POST') {
      const parsed = JSON.parse(body || '{}');
      const response = await handleCommand(parsed);
      return sendResponse(nodeRes, response);
    }

    const response = new Response('Not found', { status: 404 });
    return sendResponse(nodeRes, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });

  // Write state file
  const state = {
    pid: process.pid,
    port,
    token: AUTH_TOKEN,
    startedAt: new Date().toISOString(),
    serverPath: path.resolve(__dirname, 'server.ts'),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

  browserManager.serverPort = port;
  console.log(`[browse] Server running on http://127.0.0.1:${port} (PID: ${process.pid})`);
  console.log(`[browse] State file: ${STATE_FILE}`);
  console.log(`[browse] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
}

start().catch((err) => {
  console.error(`[browse] Failed to start: ${err.message}`);
  process.exit(1);
});
