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
const SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || String(30 * 60 * 1000), 10);

// ─── In-memory stores ─────────────────────────────────────────────────────────

const registeredClients = new Map(); // clientId → { redirectUris }
const pendingCodes      = new Map(); // code → { clientId, redirectUri, codeChallenge, codeChallengeMethod, expiresAt }
const mcpSessions       = new Map(); // sessionId → { transport, child, resetIdleTimer }

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
        transport.send(JSON.parse(line)).catch((e) => console.error('[relay→http]', e.message));
      } catch (e) {
        console.error('[stdout parse]', e.message, '| line:', line.slice(0, 120));
      }
    }
  });

  // ── HTTP transport → child stdin ──
  transport.onmessage = (msg) => {
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

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BookStack MCP Docker running on :${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Stdio server: ${STDIO_SERVER_PATH}`);
});
