// Sign-in with OpenID Connect (Authentik at auth.stackgen.run in the Civo deployment).
// Off unless OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and SESSION_SECRET are set (local dev stays open).
//
//   /auth/login?next=/monitor   → the identity provider (authorization code flow with PKCE)
//   /auth/callback              → back here; the session is a signed cookie (no server-side store)
//   /auth/logout                → clears the cookie
//   /auth/pair?t=…&next=/eye…   → a phone scanning a signed-in monitor's QR code becomes signed in as that person,
//                                 without typing a password on the phone (the pass lasts 15 minutes)
//
// Everything else (pages, the WebSocket, speech clips) needs a session; see server.js.

import crypto from 'node:crypto';

const ISSUER = (process.env.OIDC_ISSUER ?? '').replace(/\/?$/, '/');
const CLIENT_ID = process.env.OIDC_CLIENT_ID;
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET;
const SECRET = process.env.SESSION_SECRET;
const PUBLIC_URL = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');   // e.g. https://9000.stackgen.run

export const enabled = !!(process.env.OIDC_ISSUER && CLIENT_ID && CLIENT_SECRET && SECRET);

const SESSION = 'hal9000_session', FLOW = 'hal9000_oidc';
const SESSION_S = 12 * 3600;          // a monitor signs in again after 12 hours
const EYE_SESSION_S = 30 * 24 * 3600; // a paired eye stays signed in for 30 days
const PAIR_S = 15 * 60;

// ---- signed tokens: base64url(json).base64url(hmac) ----
const b64 = buf => Buffer.from(buf).toString('base64url');
const mac = data => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
function sign(payload) {
  const data = b64(JSON.stringify(payload));
  return `${data}.${mac(data)}`;
}
function verify(token) {
  const [data, sig] = String(token ?? '').split('.');
  if (!data || !sig) return null;
  const want = mac(data);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString());
    return p.exp && p.exp * 1000 > Date.now() ? p : null;
  } catch { return null; }
}
const now = () => Math.floor(Date.now() / 1000);

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, maxAge, secure) {
  const prev = [].concat(res.getHeader('Set-Cookie') ?? []);
  prev.push(`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  res.setHeader('Set-Cookie', prev);
}

// Machine access (evaluations, checks after a deploy): AUTOMATION_TOKEN, sent as "Authorization: Bearer <token>".
// It acts as the identity "automation", never as a person; rotate it by replacing the value in the Secret.
const AUTOMATION = process.env.AUTOMATION_TOKEN && process.env.AUTOMATION_TOKEN.length >= 32 ? Buffer.from(process.env.AUTOMATION_TOKEN) : null;
function automation(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!AUTOMATION || !m) return null;
  const got = Buffer.from(m[1]);
  return got.length === AUTOMATION.length && crypto.timingSafeEqual(got, AUTOMATION) ? { sub: 'automation', name: 'automation', automation: true } : null;
}

// The signed-in person for a request (page, WebSocket upgrade), or null. With auth off, everyone is "local".
export function user(req) {
  if (!enabled) return { sub: 'local', name: 'local' };
  const s = verify(cookies(req)[SESSION]);
  return s?.kind === 'session' ? s : automation(req);
}

// A pairing pass for the eye QR code, made for a signed-in monitor.
export function pairToken(u) {
  if (!enabled || !u) return null;
  return sign({ kind: 'pair', sub: u.sub, name: u.name, email: u.email, exp: now() + PAIR_S });
}

// Where requests come back to: PUBLIC_URL when set, else the request's own origin.
function origin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = req.headers['x-forwarded-proto'] ?? (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}
const safeNext = n => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

let meta;
async function discovery() {
  meta ??= await fetch(`${ISSUER}.well-known/openid-configuration`).then(r => {
    if (!r.ok) throw new Error(`OIDC discovery HTTP ${r.status}`);
    return r.json();
  });
  return meta;
}

function redirect(res, to) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
}

// Handles /auth/*; returns true when it answered the request.
export async function handle(req, res, url) {
  if (!url.pathname.startsWith('/auth/')) return false;
  if (!enabled) { redirect(res, safeNext(url.searchParams.get('next'))); return true; }
  const secure = origin(req).startsWith('https:');
  try {
    if (url.pathname === '/auth/login') {
      const m = await discovery();
      const state = b64(crypto.randomBytes(16)), verifier = b64(crypto.randomBytes(32));
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      setCookie(res, FLOW, sign({ kind: 'flow', state, verifier, next: safeNext(url.searchParams.get('next')), exp: now() + 600 }), 600, secure);
      const q = new URLSearchParams({
        response_type: 'code', client_id: CLIENT_ID, redirect_uri: `${origin(req)}/auth/callback`,
        scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256',
      });
      redirect(res, `${m.authorization_endpoint}?${q}`);
      return true;
    }

    if (url.pathname === '/auth/callback') {
      const flow = verify(cookies(req)[FLOW]);
      if (!flow || flow.kind !== 'flow' || flow.state !== url.searchParams.get('state')) throw new Error('sign-in expired or state mismatch');
      if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error'));
      const m = await discovery();
      const tokenRes = await fetch(m.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}` },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: `${origin(req)}/auth/callback`, code_verifier: flow.verifier }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange HTTP ${tokenRes.status}`);
      const tokens = await tokenRes.json();
      // Claims straight from the provider's userinfo endpoint (over TLS with the fresh access token), so the
      // ID token's signature needn't be checked here.
      const info = await fetch(m.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } }).then(r => r.json());
      if (!info.sub) throw new Error('no subject in userinfo');
      setCookie(res, SESSION, sign({ kind: 'session', sub: info.sub, name: info.name || info.preferred_username || info.email, email: info.email, exp: now() + SESSION_S }), SESSION_S, secure);
      setCookie(res, FLOW, '', 0, secure);
      console.log(`AUTH signed in ${info.email ?? info.sub}`);
      redirect(res, flow.next);
      return true;
    }

    if (url.pathname === '/auth/pair') {
      const p = verify(url.searchParams.get('t'));
      if (!p || p.kind !== 'pair') { redirect(res, `/auth/login?next=${encodeURIComponent(safeNext(url.searchParams.get('next')))}`); return true; }
      setCookie(res, SESSION, sign({ kind: 'session', sub: p.sub, name: p.name, email: p.email, device: 'eye', exp: now() + EYE_SESSION_S }), EYE_SESSION_S, secure);
      console.log(`AUTH paired an eye for ${p.email ?? p.sub}`);
      redirect(res, safeNext(url.searchParams.get('next')));
      return true;
    }

    if (url.pathname === '/auth/logout') {
      setCookie(res, SESSION, '', 0, secure);
      const m = await discovery().catch(() => null);
      redirect(res, m?.end_session_endpoint ?? '/');
      return true;
    }

    if (url.pathname === '/auth/me') {
      const u = user(req);
      res.writeHead(u ? 200 : 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(u ? { name: u.name, email: u.email } : {}));
      return true;
    }
  } catch (err) {
    console.error(`AUTH ${url.pathname}: ${err.message}`);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Sign-in failed: ${err.message}\n\nTry again: /auth/login`);
    return true;
  }
  res.writeHead(404); res.end();
  return true;
}

// Paths anyone may load: the sign-in flow itself, health checks, and what the browser needs to install the app.
const PUBLIC = [/^\/auth\//, /^\/healthz$/, /^\/manifest\.webmanifest$/, /^\/icons\//, /^\/sw\.js$/];
export const isPublic = path => PUBLIC.some(re => re.test(path));
