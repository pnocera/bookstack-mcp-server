/**
 * bookstack-mcp-docker — HTTP/OAuth gateway
 *
 * Wraps the local bookstack-mcp-server (stdio) as a remote MCP service
 * reachable via Streamable HTTP, secured with OAuth 2.0 / PKCE.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server  – OAuth metadata (RFC 8414)
 *   POST /oauth/register                          – Dynamic Client Registration (RFC 7591)
 *   GET  /oauth/authorize                         – Authorization page
 *   POST /oauth/authorize                         – Issue authorization code
 *   POST /oauth/token                             – Exchange code / refresh token
 *   ALL  /mcp                                     – MCP Streamable HTTP (auth required)
 */

import express from 'express';
import { randomBytes, createHash } from 'crypto';
import { spawn } from 'child_process';
import { SignJWT, jwtVerify } from 'jose';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ─── Config ───────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = process.env.STDIO_SERVER_PATH
  || join(__dirname, '..', 'dist', 'server.js');

const PORT = parseInt(process.env.MCP_PORT || '3100', 10);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

let jwtSecret;
if (process.env.JWT_SECRET) {
  jwtSecret = new TextEncoder().encode(process.env.JWT_SECRET);
} else {
  jwtSecret = new TextEncoder().encode(randomBytes(32).toString('hex'));
  console.warn('WARNING: JWT_SECRET not set – tokens will be invalidated on restart.');
}

const BOOKSTACK_BASE_URL = (process.env.BOOKSTACK_BASE_URL || '').replace(/\/$/, '');
const DEBUG = process.env.DEBUG === 'true';
const VERBOSE_RAW = (process.env.VERBOSE || '').trim().toLowerCase();
const VERBOSE = ['1', 'true', 'yes', 'on'].includes(VERBOSE_RAW);
const SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || String(30 * 60 * 1000), 10);

// ─── In-memory stores ─────────────────────────────────────────────────────────

const registeredClients = new Map(); // clientId → { redirectUris }
const pendingCodes      = new Map(); // code → { clientId, redirectUri, codeChallenge, codeChallengeMethod, expiresAt }
const mcpSessions       = new Map(); // sessionId → { transport, child, resetIdleTimer }
const stagingStore      = new Map(); // id → { buffer, mime, filename, expires }

const STAGING_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Clean up expired staging files every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of stagingStore) {
    if (entry.expires < now) stagingStore.delete(id);
  }
}, 60_000);

const ALLOWED_STAGING_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
  'image/webp', 'image/bmp', 'image/tiff', 'image/svg+xml',
]);

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── OAuth: Metadata (RFC 8414) ───────────────────────────────────────────────

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint:             `${BASE_URL}/oauth/authorize`,
    token_endpoint:                     `${BASE_URL}/oauth/token`,
    registration_endpoint:              `${BASE_URL}/oauth/register`,
    response_types_supported:           ['code'],
    grant_types_supported:              ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported:   ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

// ─── OAuth: Dynamic Client Registration (RFC 7591) ───────────────────────────

app.post('/oauth/register', (req, res) => {
  const clientId    = randomBytes(16).toString('hex');
  const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
  registeredClients.set(clientId, { redirectUris });

  res.status(201).json({
    client_id:                  clientId,
    redirect_uris:              redirectUris,
    grant_types:                ['authorization_code'],
    response_types:             ['code'],
    token_endpoint_auth_method: 'none',
  });
});

// ─── OAuth: Authorization page ────────────────────────────────────────────────

app.get('/oauth/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;

  if (response_type !== 'code') {
    return res.status(400).send('unsupported_response_type');
  }

  res.type('html').send(buildAuthorizePage({
    client_id, redirect_uri, state, code_challenge, code_challenge_method,
  }));
});

// ─── OAuth: Issue authorization code ─────────────────────────────────────────

app.post('/oauth/authorize', async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, bookstack_token } = req.body;

  if (!redirect_uri) return res.status(400).send('missing redirect_uri');

  // Validate BookStack token live against the API
  if (!bookstack_token) {
    return res.type('html').send(buildAuthorizePage({
      client_id, redirect_uri, state, code_challenge, code_challenge_method,
      error: 'Please enter your BookStack API token.',
    }));
  }

  try {
    const apiUrl = BOOKSTACK_BASE_URL.replace(/\/api$/, '') + '/api/books?count=1';
    if (DEBUG) console.log(`[auth] validating token against ${apiUrl}`);
    const apiRes = await fetch(apiUrl, {
      headers: { Authorization: `Token ${bookstack_token}` },
    });
    if (DEBUG) console.log(`[auth] BookStack responded: ${apiRes.status}`);
    if (!apiRes.ok) {
      if (DEBUG) {
        const body = await apiRes.text().catch(() => '');
        console.error(`[auth] token rejected: ${apiRes.status} ${body.slice(0, 200)}`);
      }
      return res.type('html').send(buildAuthorizePage({
        client_id, redirect_uri, state, code_challenge, code_challenge_method,
        error: 'Invalid BookStack API token. Please check your token and try again.',
      }));
    }
  } catch (err) {
    if (DEBUG) console.error(`[auth] fetch error: ${err.message}`);
    return res.type('html').send(buildAuthorizePage({
      client_id, redirect_uri, state, code_challenge, code_challenge_method,
      error: 'Could not reach BookStack to validate the token. Please try again.',
    }));
  }

  const code      = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 600_000; // 10 minutes

  pendingCodes.set(code, {
    clientId:            client_id,
    redirectUri:         redirect_uri,
    codeChallenge:       code_challenge,
    codeChallengeMethod: code_challenge_method || 'S256',
    bookstackToken:      bookstack_token,
    expiresAt,
  });
  setTimeout(() => pendingCodes.delete(code), 600_000);

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);

  res.redirect(302, url.toString());
});

// ─── OAuth: Token endpoint ────────────────────────────────────────────────────

app.post('/oauth/token', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const { grant_type, code, code_verifier, refresh_token } = req.body;

  // ── authorization_code ──
  if (grant_type === 'authorization_code') {
    const stored = pendingCodes.get(code);
    if (!stored || stored.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    pendingCodes.delete(code);

    // Validate PKCE (S256)
    if (stored.codeChallenge) {
      if (!code_verifier) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
      }
      const computed = createHash('sha256').update(code_verifier).digest('base64url');
      if (computed !== stored.codeChallenge) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE mismatch' });
      }
    }

    const [accessToken, refreshToken] = await Promise.all([
      mintJwt({ sub: stored.clientId, type: 'access',  bst: stored.bookstackToken }, '1h'),
      mintJwt({ sub: stored.clientId, type: 'refresh', bst: stored.bookstackToken }, '30d'),
    ]);

    return res.json({
      access_token:  accessToken,
      token_type:    'bearer',
      expires_in:    3600,
      refresh_token: refreshToken,
    });
  }

  // ── refresh_token ──
  if (grant_type === 'refresh_token') {
    try {
      const { payload } = await jwtVerify(refresh_token, jwtSecret);
      if (payload.type !== 'refresh') throw new Error('wrong type');

      const accessToken = await mintJwt({ sub: payload.sub, type: 'access', bst: payload.bst }, '1h');
      return res.json({
        access_token:  accessToken,
        token_type:    'bearer',
        expires_in:    3600,
        refresh_token, // reuse the existing refresh token
      });
    } catch {
      return res.status(400).json({ error: 'invalid_grant' });
    }
  }

  res.status(400).json({ error: 'unsupported_grant_type' });
});

// ─── Auth middleware ──────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { payload } = await jwtVerify(auth.slice(7), jwtSecret);
    req.bookstackToken = payload.bst;
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

// ─── MCP: session factory ─────────────────────────────────────────────────────

function spawnChild(token) {
  return spawn(process.execPath, [STDIO_SERVER_PATH], {
    env: {
      PATH:                process.env.PATH,
      HOME:                process.env.HOME,
      BOOKSTACK_BASE_URL:  process.env.BOOKSTACK_BASE_URL || '',
      BOOKSTACK_API_TOKEN: token,
      LOG_LEVEL:           process.env.LOG_LEVEL || 'error',
      NODE_ENV:            process.env.NODE_ENV || 'production',
      MCP_TRANSPORT:       'stdio',
      BASE_URL:            BASE_URL,
      SERVER_INSTRUCTIONS: process.env.SERVER_INSTRUCTIONS || '',
      VERBOSE:             process.env.VERBOSE || '',
    },
    stdio: ['pipe', 'pipe', 'inherit'], // stderr → host stderr for debugging
  });
}

/**
 * Send MCP initialize/initialized to a freshly spawned child so it is ready
 * to handle tool calls without a full client-driven handshake.
 * Used when transparently rebuilding a lost session.
 */
function preInitChild(child) {
  return new Promise((resolve, reject) => {
    const initMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: '__preinit__',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bookstack-mcp-proxy', version: '1.0.0' },
      },
    }) + '\n';

    let buf = '';
    const timer = setTimeout(() => {
      child.stdout.removeListener('data', onData);
      reject(new Error('pre-init timeout (5 s)'));
    }, 5000);

    function onData(chunk) {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === '__preinit__') {
            clearTimeout(timer);
            child.stdout.removeListener('data', onData);
            if (msg.error) {
              reject(new Error(`pre-init error: ${msg.error.message}`));
            } else {
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
              resolve();
            }
            return;
          }
        } catch { /* ignore non-JSON lines */ }
      }
    }

    child.stdout.on('data', onData);
    child.stdin.write(initMsg);
  });
}

async function newMcpSession(token, { reconnect = false } = {}) {
  const child = spawnChild(token);

  if (reconnect) {
    try {
      await preInitChild(child);
    } catch (err) {
      child.kill();
      throw err;
    }
  }

  let sessionId = null;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      sessionId = randomBytes(16).toString('hex');
      return sessionId;
    },
    onsessioninitialized: (id) => {
      mcpSessions.set(id, session);
      console.log(`[mcp] session initialized: ${id}`);
    },
  });

  // ── idle timeout ──
  let idleTimer = null;
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log(`[mcp] session idle for ${SESSION_IDLE_TIMEOUT_MS / 60000} min, killing session=${sessionId}`);
      child.kill();
    }, SESSION_IDLE_TIMEOUT_MS);
  }
  resetIdleTimer();

  const session = { transport, child, resetIdleTimer, getSessionId: () => sessionId, setSessionId: (id) => { sessionId = id; } };

  // ── child stdout → HTTP transport (line-delimited JSON) ──
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete trailing line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (VERBOSE) console.log('[VERBOSE] [relay→http]', JSON.stringify(msg, null, 2));
        transport.send(msg).catch((e) => console.error('[relay→http]', e.message));
      } catch (e) {
        console.error('[stdout parse]', e.message, '| line:', line.slice(0, 120));
      }
    }
  });

  // ── HTTP transport → child stdin ──
  transport.onmessage = (msg) => {
    if (VERBOSE) console.log('[VERBOSE] [relay→child]', JSON.stringify(msg, null, 2));
    child.stdin.write(JSON.stringify(msg) + '\n');
  };

  // ── cleanup ──
  child.on('exit', (code, signal) => {
    console.log(`[mcp] child exited (code=${code}, signal=${signal}) session=${sessionId}`);
    if (idleTimer) clearTimeout(idleTimer);
    if (sessionId) mcpSessions.delete(sessionId);
    transport.close().catch(() => {});
  });

  transport.onclose = () => {
    console.log(`[mcp] transport closed, session=${sessionId}`);
    if (idleTimer) clearTimeout(idleTimer);
    if (sessionId) mcpSessions.delete(sessionId);
    child.kill();
  };

  return session;
}

// ─── Image upload portal ──────────────────────────────────────────────────────

app.get('/upload', (_req, res) => {
  res.type('html').send(buildUploadPage());
});

app.post('/staging/upload',
  express.raw({ type: '*/*', limit: '52428800' }), // 50 MB
  (req, res) => {
    const mime = (req.headers['x-mime-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const filename = (req.headers['x-filename'] || 'image').toString().replace(/[^\w\-_.]/g, '_').slice(0, 255) || 'image';

    if (!ALLOWED_STAGING_MIMES.has(mime)) {
      return res.status(415).json({ error: `Unsupported MIME type: ${mime}` });
    }

    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ error: 'Empty or invalid body' });
    }
    if (buffer.length > 52_428_800) {
      return res.status(413).json({ error: 'File too large (max 50 MB)' });
    }

    const id = randomBytes(16).toString('hex');
    stagingStore.set(id, { buffer, mime, filename, expires: Date.now() + STAGING_TTL_MS });

    const url = `${BASE_URL}/staging/${id}`;
    res.json({ url, expires_in: STAGING_TTL_MS / 1000, filename });
  }
);

app.get('/staging/:id', (req, res) => {
  const entry = stagingStore.get(req.params.id);
  if (!entry || entry.expires < Date.now()) {
    stagingStore.delete(req.params.id);
    return res.status(404).json({ error: 'Not found or expired' });
  }
  res.setHeader('Content-Type', entry.mime);
  res.setHeader('Content-Disposition', `inline; filename="${entry.filename}"`);
  res.send(entry.buffer);
});

// ─── MCP endpoint ─────────────────────────────────────────────────────────────

app.all('/mcp', requireAuth, async (req, res) => {
  try {
    const sid = req.headers['mcp-session-id'];

    if (sid) {
      let session = mcpSessions.get(sid);

      if (!session) {
        // Session was lost (idle timeout, server restart, child crash).
        // Transparently rebuild: pre-initialize the child with the MCP
        // handshake so it can handle tool calls immediately.
        console.log(`[mcp] stale session ${sid}, rebuilding transparently`);
        try {
          session = await newMcpSession(req.bookstackToken, { reconnect: true });
        } catch (err) {
          console.error('[mcp] session rebuild failed:', err.message);
          return res.status(503).json({ error: 'session_rebuild_failed', message: err.message });
        }
        // The SDK transport only sets _initialized=true when it processes an
        // initialize message through handleRequest. We bypass that by forcing
        // the internal state directly, reusing the incoming (stale) session ID
        // so validateSession() accepts the request without a new handshake.
        const wt = session.transport._webStandardTransport;
        wt._initialized = true;
        wt.sessionId = sid;
        session.setSessionId(sid); // keep closure in sync for cleanup handlers
        mcpSessions.set(sid, session);
        console.log(`[mcp] rebuilt session registered as: ${sid}`);
      }

      session.resetIdleTimer();
      await session.transport.handleRequest(req, res, req.body);
    } else if (req.method === 'POST') {
      // First request — no session ID yet; create a new session.
      // Claude.ai sends initialize first for fresh connections; the transport
      // handles registration via onsessioninitialized automatically.
      const session = await newMcpSession(req.bookstackToken);
      await session.transport.handleRequest(req, res, req.body);
    } else {
      res.status(400).json({ error: 'missing_session_id' });
    }
  } catch (err) {
    console.error('[mcp] handler error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function mintJwt(payload, expiresIn) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(jwtSecret);
}

/** Escape HTML special characters to prevent XSS in the authorize page. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

function buildAuthorizePage({ client_id, redirect_uri, state, code_challenge, code_challenge_method, error }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BookStack MCP — Authorize</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 2rem;
      width: 100%;
      max-width: 360px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
    }
    .logo {
      width: 44px; height: 44px;
      background: #2563eb;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 1.25rem;
    }
    h1 { font-size: 1.1rem; font-weight: 600; color: #0f172a; margin-bottom: 0.5rem; }
    p  { font-size: 0.875rem; color: #64748b; line-height: 1.6; margin-bottom: 1.25rem; }
    p strong { color: #0f172a; }
    label { display: block; font-size: 0.8rem; font-weight: 500; color: #374151; margin-bottom: 0.35rem; }
    input[type="password"] {
      width: 100%;
      padding: 0.65rem 0.75rem;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 0.95rem;
      margin-bottom: 1rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="password"]:focus { border-color: #2563eb; }
    .error { font-size: 0.8rem; color: #dc2626; margin-bottom: 0.75rem; }
    button {
      width: 100%;
      padding: 0.75rem;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <!-- Book icon -->
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
           stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
      </svg>
    </div>
    <h1>Authorize BookStack MCP</h1>
    <p><strong>Claude.ai</strong> is requesting access to your BookStack knowledge base via the MCP protocol.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id"             value="${esc(client_id)}">
      <input type="hidden" name="redirect_uri"          value="${esc(redirect_uri)}">
      <input type="hidden" name="state"                 value="${esc(state)}">
      <input type="hidden" name="code_challenge"        value="${esc(code_challenge)}">
      <input type="hidden" name="code_challenge_method" value="${esc(code_challenge_method)}">
      <label for="bookstack_token">BookStack API Token</label>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
      <input type="password" id="bookstack_token" name="bookstack_token"
             placeholder="tokenid:tokensecret" autofocus autocomplete="off">
      <p style="font-size:0.78rem;color:#94a3b8;margin-top:-0.5rem;margin-bottom:1rem;">
        Find your token in BookStack under <strong>Settings → API Tokens</strong>.
      </p>
      <button type="submit">Allow Access</button>
    </form>
  </div>
</body>
</html>`;
}

function buildUploadPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BookStack MCP — Image Upload</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 2rem;
      width: 100%;
      max-width: 480px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .logo {
      width: 44px; height: 44px;
      background: #2563eb;
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      margin-bottom: 1.25rem;
    }
    h1 { font-size: 1.1rem; font-weight: 600; color: #0f172a; margin-bottom: 0.4rem; }
    .subtitle { font-size: 0.875rem; color: #64748b; margin-bottom: 1.5rem; }
    .drop-zone {
      border: 2px dashed #cbd5e1;
      border-radius: 10px;
      padding: 2.5rem 1.5rem;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      margin-bottom: 1rem;
      position: relative;
    }
    .drop-zone.drag-over { border-color: #2563eb; background: #eff6ff; }
    .drop-zone.has-image { border-color: #22c55e; background: #f0fdf4; padding: 1rem; }
    .drop-zone input[type=file] {
      position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
    }
    .drop-icon { font-size: 2.5rem; margin-bottom: 0.75rem; }
    .drop-text { font-size: 0.9rem; color: #64748b; }
    .drop-text strong { color: #2563eb; }
    .preview {
      max-width: 100%; max-height: 200px;
      border-radius: 6px;
      display: block; margin: 0 auto 0.5rem;
      object-fit: contain;
    }
    .preview-name { font-size: 0.8rem; color: #64748b; text-align: center; }
    button.upload-btn {
      width: 100%; padding: 0.75rem;
      background: #2563eb; color: #fff;
      border: none; border-radius: 8px;
      font-size: 0.95rem; font-weight: 500;
      cursor: pointer; transition: background 0.15s;
      margin-bottom: 1rem;
    }
    button.upload-btn:hover { background: #1d4ed8; }
    button.upload-btn:disabled { background: #94a3b8; cursor: not-allowed; }
    .result { display: none; }
    .result.visible { display: block; }
    .result-label { font-size: 0.8rem; font-weight: 500; color: #374151; margin-bottom: 0.35rem; }
    .url-row { display: flex; gap: 0.5rem; }
    .url-input {
      flex: 1; padding: 0.6rem 0.75rem;
      border: 1px solid #d1d5db; border-radius: 8px;
      font-size: 0.85rem; font-family: monospace;
      background: #f8fafc; color: #0f172a;
      outline: none;
    }
    .copy-btn {
      padding: 0.6rem 0.85rem;
      background: #f1f5f9; border: 1px solid #d1d5db;
      border-radius: 8px; cursor: pointer;
      font-size: 0.85rem; white-space: nowrap;
      transition: background 0.15s;
    }
    .copy-btn:hover { background: #e2e8f0; }
    .copy-btn.copied { background: #dcfce7; border-color: #86efac; color: #15803d; }
    .expires { font-size: 0.78rem; color: #94a3b8; margin-top: 0.5rem; }
    .error-msg { font-size: 0.85rem; color: #dc2626; margin-bottom: 0.75rem; display: none; }
    .hint {
      font-size: 0.78rem; color: #94a3b8; text-align: center; margin-top: 1rem;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
           stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>
      </svg>
    </div>
    <h1>Upload Image for BookStack</h1>
    <p class="subtitle">Drag &amp; drop, click to browse, or paste with <kbd>Ctrl+V</kbd></p>

    <div class="drop-zone" id="dropZone">
      <input type="file" id="fileInput" accept="image/*">
      <div id="dropContent">
        <div class="drop-icon">🖼️</div>
        <div class="drop-text">Drop image here or <strong>click to browse</strong></div>
      </div>
    </div>

    <div class="error-msg" id="errorMsg"></div>

    <button class="upload-btn" id="uploadBtn" disabled>Upload Image</button>

    <div class="result" id="result">
      <div class="result-label">Temporary URL (valid 10 minutes)</div>
      <div class="url-row">
        <input class="url-input" id="urlOutput" readonly>
        <button class="copy-btn" id="copyBtn">Copy</button>
      </div>
      <div class="expires" id="expiresText"></div>
    </div>

    <p class="hint">Pass the URL to Claude as the <code>image</code> parameter in <code>bookstack_images_create</code>.</p>
  </div>

  <script>
    const dropZone   = document.getElementById('dropZone');
    const dropContent = document.getElementById('dropContent');
    const fileInput  = document.getElementById('fileInput');
    const uploadBtn  = document.getElementById('uploadBtn');
    const errorMsg   = document.getElementById('errorMsg');
    const result     = document.getElementById('result');
    const urlOutput  = document.getElementById('urlOutput');
    const copyBtn    = document.getElementById('copyBtn');
    const expiresText = document.getElementById('expiresText');

    let selectedFile = null;

    function showError(msg) {
      errorMsg.textContent = msg;
      errorMsg.style.display = 'block';
    }
    function hideError() { errorMsg.style.display = 'none'; }

    function setFile(file) {
      if (!file || !file.type.startsWith('image/')) {
        showError('Please select an image file.');
        return;
      }
      hideError();
      selectedFile = file;
      uploadBtn.disabled = false;

      const reader = new FileReader();
      reader.onload = e => {
        dropZone.classList.add('has-image');
        dropContent.innerHTML =
          '<img class="preview" src="' + e.target.result + '">' +
          '<div class="preview-name">' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)</div>';
      };
      reader.readAsDataURL(file);
    }

    // File input change
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) setFile(fileInput.files[0]);
    });

    // Drag & drop
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) setFile(file);
    });

    // Ctrl+V paste anywhere
    document.addEventListener('paste', e => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          setFile(item.getAsFile());
          break;
        }
      }
    });

    // Upload
    uploadBtn.addEventListener('click', async () => {
      if (!selectedFile) return;
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Uploading…';
      hideError();
      result.classList.remove('visible');

      try {
        const res = await fetch('/staging/upload', {
          method: 'POST',
          headers: {
            'Content-Type': selectedFile.type,
            'X-Mime-Type': selectedFile.type,
            'X-Filename': selectedFile.name,
          },
          body: selectedFile,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || 'Upload failed');
        }

        const data = await res.json();
        urlOutput.value = data.url;
        result.classList.add('visible');

        const expiresAt = new Date(Date.now() + data.expires_in * 1000);
        expiresText.textContent = 'Expires at ' + expiresAt.toLocaleTimeString();

        uploadBtn.textContent = 'Upload Another';
        uploadBtn.disabled = false;
      } catch (err) {
        showError(err.message || 'Upload failed. Please try again.');
        uploadBtn.textContent = 'Upload Image';
        uploadBtn.disabled = false;
      }
    });

    // Copy URL
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(urlOutput.value).then(() => {
        copyBtn.textContent = '✓ Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 2000);
      });
    });
  </script>
</body>
</html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BookStack MCP Docker running on :${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Stdio server: ${STDIO_SERVER_PATH}`);
  const instr = process.env.SERVER_INSTRUCTIONS || '';
  if (instr) {
    console.log(`[mcp] SERVER_INSTRUCTIONS set (${instr.length} chars):\n${instr}`);
  } else if (DEBUG) {
    console.log('[mcp] SERVER_INSTRUCTIONS not set — initialize response omits "instructions"');
  }
  if (VERBOSE) {
    console.log('[mcp] VERBOSE=enabled — full request/response JSON logged at relay and child level');
  }
});
