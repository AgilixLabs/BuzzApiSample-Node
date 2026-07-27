#!/usr/bin/env node
'use strict';

/**
 * Interactive guided setup for Buzz OAuth 2.0 authentication.
 *
 *   1. Prompt for the Buzz server URL.
 *   2. Log in as a Buzz administrator (supports MFA) to perform setup.
 *   3. Create (or reuse) an Application Identity account.
 *   4. Generate an RSA key pair (private key stored as a PEM file).
 *   5. Register the public key with Buzz.
 *   6. Write the .env configuration file so `npm run sample` works.
 *
 * Usage:
 *     node scripts/setup-buzz-oauth.js [--server URL] [--bits N] [--key-dir DIR]
 *
 * Every prompt falls back to an environment variable (BUZZ_* — see common.js)
 * so the whole flow can run unattended.
 */

const fs = require('node:fs');
const common = require('./common');

async function setupMain() {
  const args = process.argv.slice(2);
  let serverArg = '';
  let bitsArg = 0;
  let keyDir = common.PROJECT_ROOT;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-s': case '--server': serverArg = args[++i]; break;
      case '-b': case '--bits': bitsArg = parseInt(args[++i], 10); break;
      case '--key-dir': keyDir = args[++i]; break;
      default: break;
    }
  }

  console.log('\n==========================================================');
  console.log('  Buzz OAuth 2.0 Application Setup (Node)');
  console.log('==========================================================');

  common.section('Step 1: Buzz Server URL');
  const server = (serverArg
    || await common.promptRequired('Buzz API server URL (e.g. https://api.agilixbuzz.com)', '', 'BUZZ_SERVER_URL'))
    .replace(/\/+$/, '');
  console.log(`  Server: ${server}`);

  common.section('Step 2: Admin Login');
  console.log('Log in as a Buzz administrator to perform the one-time setup.');
  console.log('This session is used only during setup and is not stored anywhere.\n');
  const adminToken = await common.adminLogin(server);

  common.section('Step 3: Application Information');
  console.log('Included in the User-Agent header so Agilix support can identify your integration.\n');
  const contact = await common.promptRequired('Your contact info (name, email, or URL)', '', 'BUZZ_CONTACT_INFORMATION');
  const appName = await common.promptRequired('Application name (e.g. SisSync)', '', 'BUZZ_APPLICATION_INFORMATION');

  common.section('Step 4: Application Identity Account');
  console.log('This Buzz user represents your application.  It authenticates via OAuth only.\n');
  const oauthUserId = await getOrCreateAccount(server, adminToken);

  common.section('Step 5: RSA Key Generation');
  let bits = bitsArg;
  if (!bits) {
    const envBits = parseInt(process.env.BUZZ_SETUP_KEY_BITS || '0', 10);
    bits = envBits > 0 ? envBits : parseInt(await common.promptRequired('RSA key size in bits', '2048'), 10);
  }
  const kid = process.env.BUZZ_SETUP_KID || await common.promptRequired('Key id (kid) for this key', defaultKid());
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(kid)) {
    common.fail(`Invalid kid '${kid}'. Allowed: ASCII letters, digits, -, _, .  Max 128 chars.`);
  }
  common.info(`Kid : ${kid}`);
  const [privPath, pubPath] = common.generateKeyPair(keyDir, bits, true);
  console.log(`  Private key: ${privPath}`);

  common.section('Step 6: Registering Public Key with Buzz');
  common.info(`PUT ${server}/api/users/${oauthUserId}/keys/${kid}`);
  const [status, body] = await common.registerPublicKey(server, oauthUserId, kid, fs.readFileSync(pubPath, 'utf8'), adminToken);
  if (status === 204) {
    console.log(' 204 OK');
  } else {
    common.fail(`Key registration returned HTTP ${status}. ${body}`);
  }

  common.section('Step 7: Writing Configuration');
  const envFile = common.writeEnv({
    serverUrl: server,
    contactInformation: contact,
    applicationInformation: appName,
    oauthUserId,
    oauthKid: kid,
    privateKeyPath: privPath,
  });
  console.log(`  Written: ${envFile}`);

  console.log('\n==========================================================');
  console.log('  Setup complete!');
  console.log('==========================================================');
  console.log(`OAuth User ID : ${oauthUserId}`);
  console.log(`Key ID (kid)  : ${kid}`);
  console.log(`Private key   : ${privPath}`);
  console.log(`Config file   : ${envFile}`);
  console.log('\nTo test:  npm run build && npm run sample\n');
}

async function getOrCreateAccount(server, adminToken) {
  const createEnv = process.env.BUZZ_SETUP_CREATE_NEW;
  const doCreate = createEnv != null
    ? createEnv.toLowerCase().startsWith('y')
    : await common.confirm('Create a new Application Identity account?', true);

  if (!doCreate) {
    return common.promptRequired('Existing Application Identity account userid', '', 'BUZZ_SETUP_OAUTH_USER_ID');
  }

  let targetDomain = process.env.BUZZ_SETUP_DOMAINID || '';
  if (!targetDomain) {
    process.stdout.write('Fetching available domains...');
    const domains = await listDomains(server, adminToken);
    if (domains.length > 0) {
      process.stdout.write(' done\n\n');
      domains.forEach((d, i) => {
        process.stdout.write(`  ${String(i + 1).padStart(2)}. ${d[1].padEnd(30)} (id: ${d[0]})\n`);
      });
      const choice = await common.promptRequired('\nEnter domain number or type the domainid directly');
      const n = parseInt(choice, 10);
      targetDomain = (/^\d+$/.test(choice) && n >= 1 && n <= domains.length) ? domains[n - 1][0] : choice;
    } else {
      process.stdout.write(' (could not fetch domains)\n\n');
      targetDomain = await common.promptRequired('Domain id for the new account (e.g. //myschool or a numeric id)');
    }
  }

  const username = await common.promptRequired('Username for the account (e.g. sis-sync)', '', 'BUZZ_SETUP_APP_USERNAME');
  const firstname = await common.promptRequired('First name (e.g. SIS)', '', 'BUZZ_SETUP_APP_FIRSTNAME');
  const lastname = await common.promptRequired('Last name (e.g. Sync)', '', 'BUZZ_SETUP_APP_LASTNAME');
  const email = await common.promptOptional('Email address', 'BUZZ_SETUP_APP_EMAIL');

  const user = { domainid: targetDomain, type: 'applicationidentity', username, firstname, lastname };
  if (email) user.email = email;

  process.stdout.write(`\nCreating Application Identity account '${username}'...`);
  const resp = await common.buzzPost(server, 'createusers2', { requests: { user: [user] } }, adminToken);
  if (common.responseCode(resp) !== 'OK') {
    common.fail(`CreateUsers2 failed (code: ${common.responseCode(resp)}).  Response: ${JSON.stringify(resp)}`);
  }
  const userId = extractCreatedUserId(resp);
  if (!userId) common.fail(`CreateUsers2 succeeded but returned no userid.  Response: ${JSON.stringify(resp)}`);
  process.stdout.write(` OK (userid: ${userId})\n`);
  return userId;
}

async function listDomains(server, token) {
  const resp = await common.buzzGet(server, 'getdomains', {}, token);
  if (common.responseCode(resp) !== 'OK') return [];
  let domains = resp?.response?.domains?.domain ?? [];
  if (!Array.isArray(domains)) domains = [domains];
  return domains
    .filter((d) => d && typeof d === 'object')
    .map((d) => [String(d.id ?? d.domainid ?? ''), String(d.name ?? '')]);
}

function extractCreatedUserId(resp) {
  const r = (resp && resp.response) ? resp.response : (resp || {});
  let inner = r?.responses?.response ?? {};
  if (Array.isArray(inner)) inner = inner[0] || {};
  const user = (inner && typeof inner === 'object') ? (inner.user || {}) : {};
  return String(user.userid ?? user.id ?? '');
}

function defaultKid() {
  const now = new Date();
  return `${now.getUTCFullYear()}-q${Math.floor(now.getUTCMonth() / 3) + 1}`;
}

if (require.main === module) {
  setupMain().then(() => common.closeRl()).catch((e) => {
    process.stderr.write(`\nError: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { setupMain };
