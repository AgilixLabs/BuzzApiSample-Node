#!/usr/bin/env node
'use strict';

/**
 * Register an RSA public key with Buzz for OAuth 2.0 authentication.
 *
 * Usage:
 *     node scripts/register-buzz-oauth-key.js -s SERVER_URL -u USER_ID -k KID -p PUBLIC_KEY_PATH [-t TOKEN]
 *
 * The admin Bearer token is read (in order of preference) from:
 *     -t/--token,  the BUZZ_ADMIN_TOKEN environment variable,  or an interactive prompt.
 *
 * PUTting an existing kid REPLACES the key immediately — use a new kid to rotate.
 */

const fs = require('node:fs');
const path = require('node:path');
const common = require('./common');

async function main() {
  const args = process.argv.slice(2);
  let server = '';
  let token = '';
  let userId = '';
  let kid = '';
  let publicKeyPath = '';
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-s': case '--server': server = args[++i]; break;
      case '-t': case '--token': token = args[++i]; break;
      case '-u': case '--user-id': userId = args[++i]; break;
      case '-k': case '--kid': kid = args[++i]; break;
      case '-p': case '--public-key': publicKeyPath = args[++i]; break;
      case '-h': case '--help':
        console.log('Usage: node scripts/register-buzz-oauth-key.js -s URL -u USER_ID -k KID -p PUBLIC_KEY [-t TOKEN]');
        return;
      default: break;
    }
  }

  if (!server || !userId || !kid || !publicKeyPath) {
    process.stderr.write('Error: -s, -u, -k and -p are all required.\n');
    process.exitCode = 1;
    return;
  }
  server = server.replace(/\/+$/, '');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(kid)) {
    process.stderr.write('Error: invalid kid. Allowed: ASCII letters, digits, -, _, .  Max 128 chars.\n');
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(publicKeyPath)) {
    process.stderr.write(`Error: public key file not found: ${publicKeyPath}\n`);
    process.exitCode = 1;
    return;
  }
  const pem = fs.readFileSync(publicKeyPath, 'utf8');
  if (!pem.includes('BEGIN PUBLIC KEY')) {
    process.stderr.write("Error: file is not a SubjectPublicKeyInfo PEM ('-----BEGIN PUBLIC KEY-----').\n");
    process.exitCode = 1;
    return;
  }

  if (!token) {
    token = process.env.BUZZ_ADMIN_TOKEN || await common.promptPassword('Admin Bearer token');
    common.closeRl();
  }
  if (!token) {
    process.stderr.write('Error: admin token is required.\n');
    process.exitCode = 1;
    return;
  }

  console.log('Registering public key...');
  console.log(`  URL  : ${server}/api/users/${userId}/keys/${kid}`);
  console.log(`  Kid  : ${kid}`);
  console.log(`  File : ${path.resolve(publicKeyPath)}\n`);

  const [status, body] = await common.registerPublicKey(server, userId, kid, pem, token);
  reportStatus(status, body, userId, kid);
}

function reportStatus(status, body, userId, kid) {
  if (status === 204) {
    console.log('Public key registered successfully (HTTP 204).\n');
    console.log('Configure your application:');
    console.log(`  oauthUserId = ${userId}`);
    console.log(`  oauthKid    = ${kid}`);
    return;
  }
  if (status === 400) {
    process.stderr.write('Error: HTTP 400 Bad Request\n');
    process.stderr.write('  - Public key must be SPKI PEM and at least 2048 bits.\n');
    process.stderr.write(`  - Account ${userId} must have been created with type=applicationidentity.\n`);
  } else if (status === 401 || status === 403) {
    process.stderr.write(`Error: HTTP ${status} — admin token lacks Update User rights on account ${userId}.\n`);
  } else if (status === 404) {
    process.stderr.write('Error: HTTP 404 — server URL or user id not found.\n');
  } else {
    process.stderr.write(`Error: unexpected HTTP ${status}\n`);
  }
  if (body) process.stderr.write(`Response: ${body}\n`);
  process.exitCode = 1;
}

main();
