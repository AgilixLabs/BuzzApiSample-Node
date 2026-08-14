'use strict';

/**
 * Shared helpers for the Buzz API sample setup/run/cleanup scripts.
 *
 * These talk to the Buzz API for one-time setup tasks (admin login, key
 * registration, account management). They use the legacy `login3` command only
 * to obtain a short-lived admin session token for setup — the sample
 * application itself never uses login3, only OAuth.
 *
 * Interactive prompts fall back to environment variables when set, so the
 * scripts can run unattended (useful for automated testing):
 *   BUZZ_SERVER_URL, BUZZ_ADMIN_USERNAME, BUZZ_ADMIN_PASSWORD, BUZZ_ADMIN_MFA
 *
 * Plain CommonJS using only Node built-ins (Node 22+ for global fetch).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const ENV_VARS = {
  serverUrl: 'BUZZ_SERVER_URL',
  contactInformation: 'BUZZ_CONTACT_INFORMATION',
  applicationInformation: 'BUZZ_APPLICATION_INFORMATION',
  oauthUserId: 'BUZZ_OAUTH_USER_ID',
  oauthKid: 'BUZZ_OAUTH_KID',
  privateKeyPath: 'BUZZ_PRIVATE_KEY_PATH',
};
const REQUIRED = ['serverUrl', 'oauthUserId', 'oauthKid', 'privateKeyPath'];

function envPath() {
  return path.join(PROJECT_ROOT, '.env');
}

// ── Console output ─────────────────────────────────────────────────────────────
function section(title) {
  process.stdout.write(`\n--- ${title} ${'-'.repeat(Math.max(0, 50 - title.length))}\n`);
}
function info(msg) { process.stdout.write(`  ${msg}\n`); }
function fail(msg) { process.stderr.write(`\nError: ${msg}\n`); process.exit(1); }

// ── Prompts (with environment-variable fallbacks) ──────────────────────────────
let rl = null;
function getRl() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
function closeRl() { if (rl) { rl.close(); rl = null; } }

/** Read a line from stdin. Resolves null on EOF. */
function readLine(promptText) {
  return new Promise((resolve) => {
    const r = getRl();
    let settled = false;
    const onClose = () => { if (!settled) { settled = true; resolve(null); } };
    r.once('close', onClose);
    r.question(promptText, (answer) => { settled = true; r.removeListener('close', onClose); resolve(answer); });
  });
}

async function promptRequired(label, defaultValue = '', env = null) {
  if (env && process.env[env]) return process.env[env];
  for (;;) {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    let value = await readLine(`${label}${suffix}: `);
    if (value === null) {
      if (defaultValue) return defaultValue;
      fail(`'${label}' is required but no value was provided${env ? ` (set ${env})` : ''}`);
    }
    value = value.trim() || defaultValue;
    if (value) return value;
    process.stdout.write('  (required)\n');
  }
}

async function promptOptional(label, env = null) {
  if (env && process.env[env]) return process.env[env];
  const value = await readLine(`${label} (optional, press Enter to skip): `);
  return value === null ? '' : value.trim();
}

/** Prompt for a password, masking keystrokes with '*'. Falls back to env var. */
function promptPassword(label, env = null) {
  if (env && process.env[env]) return Promise.resolve(process.env[env]);
  return new Promise((resolve) => {
    const r = getRl();
    const write = r.output.write.bind(r.output);
    const original = r._writeToOutput ? r._writeToOutput.bind(r) : null;
    r._writeToOutput = (str) => {
      if (str.includes(label) || str === '\n' || str === '\r\n' || str === '\r') write(str);
      else write('*');
    };
    r.question(`${label}: `, (answer) => {
      r._writeToOutput = original || ((s) => write(s));
      write('\n');
      resolve(answer);
    });
  });
}

async function confirm(label, defaultYes = false) {
  const value = await readLine(`${label} ${defaultYes ? '[Y/n]' : '[y/N]'} `);
  if (value === null || !value.trim()) return defaultYes;
  return value.trim().toLowerCase().startsWith('y');
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
async function buzzHttp(method, url, body, headers) {
  let resp;
  try {
    resp = await fetch(url, { method, headers, body });
  } catch (e) {
    process.stderr.write(`  request error for ${url}: ${e.message}\n`);
    return { status: 0, data: null, raw: '' };
  }
  const raw = await resp.text();
  let data = null;
  if (raw) { try { data = JSON.parse(raw); } catch { /* not JSON */ } }
  return { status: resp.status, data, raw };
}

// Session tokens travel in an Authorization: Bearer header on both /cmd/* and /api/*
// endpoints.  A _token query parameter is also accepted by /cmd/*, but a credential in
// a URL is recorded by server and proxy access logs.
// Buzz returns XML unless JSON is requested via Accept.
function authHeaders(token, extra = {}) {
  return { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

async function buzzPost(server, cmd, body, token = null) {
  const r = await buzzHttp('POST', `${server}/cmd/${cmd}`, JSON.stringify(body),
    authHeaders(token, { 'Content-Type': 'application/json' }));
  return r.data;
}

async function buzzGet(server, cmd, params = {}, token = null) {
  const qs = new URLSearchParams(params).toString();
  const r = await buzzHttp('GET', `${server}/cmd/${cmd}${qs ? `?${qs}` : ''}`, undefined,
    authHeaders(token));
  return r.data;
}

async function registerPublicKey(server, userId, kid, publicKeyPem, token) {
  const url = `${server}/api/users/${userId}/keys/${kid}`;
  const r = await buzzHttp('PUT', url, publicKeyPem,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-pem-file' });
  return [r.status, r.raw];
}

async function deletePublicKey(server, userId, kid, token) {
  const url = `${server}/api/users/${userId}/keys/${kid}`;
  const r = await buzzHttp('DELETE', url, undefined, { Authorization: `Bearer ${token}` });
  return [r.status, r.raw];
}

function responseCode(resp) {
  if (!resp || typeof resp !== 'object') return '';
  if (resp.response && typeof resp.response === 'object' && resp.response.code != null) return String(resp.response.code);
  return resp.code != null ? String(resp.code) : '';
}
function responseMessage(resp) {
  const inner = (resp && resp.response && typeof resp.response === 'object') ? resp.response : (resp || {});
  return inner.message != null ? String(inner.message) : '';
}

// The per-entity result of a multi-object command (CreateUsers2, DeleteUsers).  Those
// commands report each entity's outcome under response.responses.response, while the
// OUTER code is OK whenever the request was merely well formed.  A per-entity
// AccessDenied therefore arrives inside an "OK" envelope, so the outer code alone
// cannot tell you whether the entity was actually created or deleted.
function itemResult(resp) {
  const inner = (resp && resp.response && typeof resp.response === 'object') ? resp.response : resp;
  if (!inner || typeof inner !== 'object') return {};
  let node = inner.responses && typeof inner.responses === 'object' ? inner.responses.response : null;
  if (Array.isArray(node)) node = node.length ? node[0] : null;
  if (!node || typeof node !== 'object') return {};
  return {
    code: node.code != null ? String(node.code) : '',
    message: node.message != null ? String(node.message) : '',
    userid: node.user && node.user.userid != null ? String(node.user.userid) : '',
  };
}

// The short-lived token login3 returns alongside SecondFactorRequired.  Observed shape:
// response.token, duplicated at response.body.token.  There is no "user" node on that
// response, so response.user.token (where the session token lives on a *successful*
// login) does not exist yet.  remembermfa.token is deliberately ignored: it remembers a
// device and cannot complete this login.
function secondFactorToken(resp) {
  const inner = (resp && resp.response && typeof resp.response === 'object') ? resp.response : resp;
  if (!inner || typeof inner !== 'object') return '';
  for (const c of [inner.user?.token, inner.token, inner.body?.token]) {
    if (typeof c === 'string' && c) return c;
  }
  return '';
}

// ── Admin login (login3, with optional MFA) ─────────────────────────────────────
async function adminLogin(server) {
  for (;;) {
    const username = await readAdminUsername();
    const password = await promptPassword('Admin password', 'BUZZ_ADMIN_PASSWORD');

    process.stdout.write('Logging in...');
    let resp = await buzzPost(server, 'login3', { request: { cmd: 'login3', username, password } });
    let code = responseCode(resp);

    // Multi-factor authentication.  login3 answers SecondFactorRequired when the
    // password was correct but the account has MFA configured, and returns a
    // short-lived token that is presented in an Authorization: Bearer header to
    // secondfactorauthenticate, which returns the real session token.  Putting the
    // token in the request body instead is ignored and answers AccessDenied userId='-1'.
    //   https://api.agilixbuzz.com/docs/entry/Command/Login3.md
    //   https://api.agilixbuzz.com/docs/entry/Command/SecondFactorAuthenticate.md
    if (code === 'SecondFactorConfigurationNowRequired') {
      process.stdout.write('\n  This account must configure multi-factor authentication before it can\n');
      process.stdout.write('  be used.  Complete MFA setup in Buzz, then re-run this script.\n');
      if (process.env.BUZZ_ADMIN_PASSWORD) fail('Admin account requires multi-factor authentication setup.');
      process.stdout.write('  Press Ctrl+C to abort.\n\n');
      continue;
    }

    if (code === 'SecondFactorRequired') {
      process.stdout.write(' multi-factor authentication required.\n');
      const mfaToken = secondFactorToken(resp);
      if (!mfaToken) {
        process.stdout.write('\n  Buzz asked for a second factor but no token could be found in its reply.\n');
        if (process.env.BUZZ_ADMIN_PASSWORD) fail('No second-factor token was returned.');
        process.stdout.write('  Press Ctrl+C to abort.\n\n');
        continue;
      }
      const otp = await promptRequired('One-time code from your authenticator app or email', '', 'BUZZ_ADMIN_MFA');
      resp = await buzzPost(server, 'secondfactorauthenticate',
        { request: { cmd: 'secondfactorauthenticate', otp } }, mfaToken);
      code = responseCode(resp);
    }

    if (code !== 'OK') {
      const msg = responseMessage(resp);
      process.stdout.write(`\n  Login failed (code: ${code})${msg ? `: ${msg}` : ''}\n`);
      if (process.env.BUZZ_ADMIN_PASSWORD) fail('Login failed with credentials from environment variables.');
      process.stdout.write('  Please check your credentials and try again.  Press Ctrl+C to abort.\n\n');
      continue;
    }

    const token = resp?.response?.user?.token || resp?.user?.token || '';
    if (!token) {
      process.stdout.write('\n  Login succeeded but no token was returned.  Press Ctrl+C to abort.\n\n');
      continue;
    }
    process.stdout.write(' OK\n');
    return token;
  }
}

async function readAdminUsername() {
  if (process.env.BUZZ_ADMIN_USERNAME) return process.env.BUZZ_ADMIN_USERNAME;
  for (;;) {
    const value = await readLine('Admin username (userspace/username, e.g. myschool/admin): ');
    if (value !== null && /^[^/]+\/[^/]+$/.test(value.trim())) return value.trim();
    process.stdout.write('  Username must be in userspace/username format.\n');
  }
}

// ── RSA key generation ──────────────────────────────────────────────────────────
function generateKeyPair(outDir, bits, overwrite = false) {
  if (bits < 2048) throw new Error('Key size must be at least 2048 bits (Buzz minimum).');
  fs.mkdirSync(outDir, { recursive: true });
  const privPath = path.resolve(outDir, 'private_key.pem');
  const pubPath = path.resolve(outDir, 'public_key.pem');
  if (!overwrite && (fs.existsSync(privPath) || fs.existsSync(pubPath))) {
    throw new Error(`Key file(s) already exist in ${outDir}.`);
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'pem' },       // SubjectPublicKeyInfo — what Buzz expects
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey);
  try { fs.chmodSync(privPath, 0o600); } catch { /* best effort on non-POSIX */ }
  return [privPath, pubPath];
}

// ── Configuration (.env) ────────────────────────────────────────────────────────
function writeEnv(config, filePath = envPath()) {
  const lines = ['# Buzz API sample configuration — generated by setup.  Do not commit this file.', ''];
  for (const [field, varName] of Object.entries(ENV_VARS)) {
    lines.push(`${varName}=${config[field] ?? ''}`);
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

function loadEnv(filePath = envPath()) {
  if (!fs.existsSync(filePath)) return false;
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
  return true;
}

module.exports = {
  PROJECT_ROOT, ENV_VARS, REQUIRED, envPath,
  section, info, fail,
  readLine, promptRequired, promptOptional, promptPassword, confirm, closeRl,
  buzzPost, buzzGet, registerPublicKey, deletePublicKey, responseCode, responseMessage,
  itemResult, secondFactorToken,
  adminLogin, generateKeyPair, writeEnv, loadEnv,
};
