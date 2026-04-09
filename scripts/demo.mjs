#!/usr/bin/env node
/**
 * scripts/demo.mjs — End-to-end demo of the MCP proxy server.
 *
 * Starts a local server, runs the full MCP protocol flow against three real
 * public APIs, then replays the auth scenarios.
 *
 * Usage:
 *   node scripts/demo.mjs          # default port 3001
 *   PORT=4000 node scripts/demo.mjs
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = process.env.PORT ?? '3001';
const BASE = `http://localhost:${PORT}/mcp`;

// ── ANSI colour helpers ───────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

const bold = (s) => `${C.bold}${s}${C.reset}`;
const dim = (s) => `${C.dim}${s}${C.reset}`;
const green = (s) => `${C.green}${s}${C.reset}`;
const red = (s) => `${C.red}${s}${C.reset}`;
const yellow = (s) => `${C.yellow}${s}${C.reset}`;

const ok = (s) => console.log(`  ${green('✓')} ${s}`);
const fail = (s) => { console.log(`  ${red('✗')} ${s}`); process.exitCode = 1; };
const info = (s) => console.log(`  ${yellow('→')} ${s}`);

function section(title) {
  console.log('');
  console.log(`${C.bold}${C.cyan}${'━'.repeat(52)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${'━'.repeat(52)}${C.reset}`);
}

// ── Server lifecycle ──────────────────────────────────────────────────────────
let serverProc = null;

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    serverProc = spawn('npx', ['tsx', 'src/local.ts'], {
      cwd: ROOT,
      env: { ...process.env, PORT, MCP_CONFIG_PATH: 'config/demo.yaml', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        console.log(`  ${dim('[server] ' + line.trim())}`);
        if (line.includes('Local server running')) resolve();
      }
    });

    serverProc.stderr.on('data', (chunk) => {
      const txt = chunk.toString().trim();
      if (txt) console.error(`  ${red('[server err]')} ${txt}`);
    });

    serverProc.on('error', reject);
    setTimeout(() => reject(new Error('Server did not start within 10 s')), 10_000);
  });
}

function stopServer() {
  return new Promise((done) => {
    if (!serverProc) return done();
    serverProc.once('exit', done);
    serverProc.kill('SIGTERM');
    setTimeout(done, 2_000); // force-resolve after 2 s
  });
}

// ── MCP / HTTP helpers ────────────────────────────────────────────────────────
async function rawPost(body, headers = {}) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

function parseSse(text) {
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (!line) throw new Error(`No SSE data line in:\n${text}`);
  return JSON.parse(line.slice(6));
}

async function mcpCall(id, method, params = {}, headers = {}) {
  const { status, text } = await rawPost({ jsonrpc: '2.0', id, method, params }, headers);
  if (status !== 200) return { _httpStatus: status, _body: text };
  return parseSse(text);
}

async function mcpNotify(method, params = {}, headers = {}) {
  const { status } = await rawPost({ jsonrpc: '2.0', method, params }, headers);
  return status;
}

function toolResultJson(rpc) {
  if (rpc._httpStatus) return null;
  const text = rpc?.result?.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// ── Main demo ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log(bold('  MCP Proxy — End-to-End Demo'));
  console.log(dim(`  config: config/demo.yaml   port: ${PORT}`));

  // ── Step 1: Start server (no auth) ───────────────────────────────────────
  section('1 · Server startup  (auth disabled)');
  await startServer();
  ok(`Listening on port ${bold(PORT)}`);

  // ── Step 2: MCP handshake ─────────────────────────────────────────────────
  section('2 · MCP handshake');

  const initRpc = await mcpCall(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'demo-script', version: '1.0' },
  });
  ok(`initialize       server: ${bold(initRpc.result.serverInfo.name)}  protocol: ${initRpc.result.protocolVersion}`);

  const notifHttp = await mcpNotify('notifications/initialized', {});
  ok(`notifications/initialized  → HTTP ${bold(notifHttp)}`);

  // ── Step 3: tools/list ───────────────────────────────────────────────────
  section('3 · tools/list');

  const listRpc = await mcpCall(2, 'tools/list', {});
  const tools = listRpc.result.tools;
  ok(`${bold(tools.length)} tools registered:`);
  for (const t of tools) {
    info(`${bold(t.name.padEnd(14))}  ${t.description}`);
  }

  // ── Step 4: get_weather ──────────────────────────────────────────────────
  section('4 · tools/call  get_weather  (open-meteo.com)');
  info('GET https://api.open-meteo.com/v1/forecast?latitude=43.70&longitude=7.26&current_weather=true');

  const weatherRpc = await mcpCall(3, 'tools/call', {
    name: 'get_weather',
    arguments: { latitude: 43.70, longitude: 7.26 },
  });
  const weather = toolResultJson(weatherRpc);
  if (weather && !weatherRpc.result?.isError) {
    ok(`temperature: ${bold(weather.temperature + ' °C')}   windspeed: ${weather.windspeed} km/h   is_day: ${weather.is_day}   weathercode: ${weather.weathercode}`);
  } else {
    fail('get_weather failed: ' + JSON.stringify(weather ?? weatherRpc));
  }

  // ── Step 5: get_gender ───────────────────────────────────────────────────
  section('5 · tools/call  get_gender  (genderize.io)');
  info('GET https://api.genderize.io/?name=dana');

  const genderRpc = await mcpCall(4, 'tools/call', {
    name: 'get_gender',
    arguments: { name: 'dana' },
  });
  const gender = toolResultJson(genderRpc);
  if (gender && !genderRpc.result?.isError) {
    ok(`name: ${bold(gender.name)}   gender: ${bold(gender.gender)}   probability: ${bold((gender.probability * 100).toFixed(0) + '%')}`);
  } else {
    fail('get_gender failed: ' + JSON.stringify(gender ?? genderRpc));
  }

  // ── Step 6: create_post ──────────────────────────────────────────────────
  section('6 · tools/call  create_post  (jsonplaceholder.typicode.com)');
  info('POST https://jsonplaceholder.typicode.com/posts  { title, body, userId: 1 }');

  const postRpc = await mcpCall(5, 'tools/call', {
    name: 'create_post',
    arguments: {
      title: 'My First API Post',
      body: 'This is a test post using a keyless API.',
      user_id: 1,
    },
  });
  const post = toolResultJson(postRpc);
  if (post && !postRpc.result?.isError) {
    ok(`id: ${bold(post.id)}   title: "${post.title}"   userId: ${post.userId}`);
  } else {
    fail('create_post failed: ' + JSON.stringify(post ?? postRpc));
  }

  // ── Step 7: Proxy auth ───────────────────────────────────────────────────
  section('7 · Proxy authentication  (PROXY_API_KEY=demo-key-123)');

  await stopServer();
  await startServer({ PROXY_API_KEY: 'demo-key-123' });
  ok(`Server restarted with ${bold('PROXY_API_KEY')} set`);

  const cases = [
    { label: 'No key          ', headers: {},                                     expectStatus: 401 },
    { label: 'Wrong key       ', headers: { Authorization: 'Bearer wrong-key' },  expectStatus: 401 },
    { label: 'Bearer <key>    ', headers: { Authorization: 'Bearer demo-key-123' }, expectStatus: 200 },
    { label: 'X-Api-Key: <key>', headers: { 'X-Api-Key': 'demo-key-123' },          expectStatus: 200 },
  ];

  for (const { label, headers, expectStatus } of cases) {
    const { status } = await rawPost({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }, headers);
    const statusStr = expectStatus === 401 ? red(status) : green(status);
    const verdict = status === expectStatus ? green('✓') : red('✗');
    console.log(`  ${verdict} ${label}  HTTP ${statusStr}`);
    if (status !== expectStatus) process.exitCode = 1;
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  section('Done');
  if (process.exitCode) {
    fail('Some steps failed — see above');
  } else {
    ok(green('All demo steps completed successfully'));
  }
  console.log('');

  await stopServer();
}

main().catch(async (err) => {
  console.error(`\n${red('Demo failed:')} ${err.message}`);
  await stopServer();
  process.exit(1);
});
