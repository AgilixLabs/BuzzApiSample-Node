#!/usr/bin/env node
'use strict';

/**
 * Remove all artifacts created by setup-buzz-oauth.js.
 *
 *   1. Read .env to find the OAuth account details.
 *   2. Log in as a Buzz admin (supports MFA).
 *   3. Delete the registered OAuth public key from Buzz.
 *   4. Delete the Application Identity account from Buzz.
 *   5. Delete the local key files and the .env file.
 *
 * Usage:
 *     node scripts/cleanup-buzz-sample.js [--yes]
 *
 *     --yes   Skip the confirmation prompt (useful for automated cleanup).
 */

const fs = require('node:fs');
const path = require('node:path');
const common = require('./common');

async function cleanupMain() {
  const yes = process.argv.includes('--yes') || process.argv.includes('-y');

  const envFile = common.envPath();
  if (!fs.existsSync(envFile)) {
    console.log('.env not found — nothing to clean up.');
    return;
  }
  common.loadEnv(envFile);

  const server = (process.env[common.ENV_VARS.serverUrl] || '').replace(/\/+$/, '');
  const oauthUserId = process.env[common.ENV_VARS.oauthUserId] || '';
  const oauthKid = process.env[common.ENV_VARS.oauthKid] || '';
  const privateKeyPath = process.env[common.ENV_VARS.privateKeyPath] || '';

  if (!server || !oauthUserId) {
    process.stderr.write('.env is missing required fields (server url, oauth user id).\n');
    process.exit(1);
  }

  console.log('\n========================================================');
  console.log('  Buzz API Sample - Cleanup');
  console.log('========================================================\n');
  console.log('This will:');
  console.log(`  * Delete OAuth public key (kid: ${oauthKid}) from Buzz`);
  console.log(`  * Delete Application Identity account (userid: ${oauthUserId}) from Buzz`);
  if (privateKeyPath) console.log(`  * Delete local key files near: ${privateKeyPath}`);
  console.log('  * Delete .env');
  if (!yes && !(await common.confirm('\nThis action is irreversible.  Continue?'))) {
    console.log('Aborted.');
    return;
  }

  console.log('\n-- Admin login -----------------------------------------');
  const adminToken = await common.adminLogin(server);

  if (oauthKid) {
    console.log(`\n-- Deleting OAuth key (kid: ${oauthKid}) ----------------`);
    const [status] = await common.deletePublicKey(server, oauthUserId, oauthKid, adminToken);
    if (status === 200 || status === 204) console.log(`OAuth key deleted (HTTP ${status}).`);
    else if (status === 404) console.log('OAuth key not found (already deleted or never registered).');
    else process.stderr.write(`Warning: HTTP ${status} deleting key. Continuing.\n`);
  }

  console.log(`\n-- Deleting Application Identity account (userid: ${oauthUserId}) --`);
  const resp = await common.buzzPost(server, 'deleteusers', { requests: { user: [{ userid: oauthUserId }] } }, adminToken);
  // The per-user outcome is authoritative.  The OUTER code is OK whenever the request
  // was merely well formed, so checking it first would report success for a delete that
  // was actually denied or whose target did not exist.
  const item = common.itemResult(resp);
  const delCode = item.code || common.responseCode(resp);
  const detail = item.message ? ` - ${item.message}` : '';
  if (delCode === 'OK') console.log('Application Identity account deleted.');
  else process.stderr.write(`Warning: delete returned code "${delCode}"${detail}. Continuing.\n`);

  console.log('\n-- Removing local files --------------------------------');
  const keyDir = privateKeyPath ? path.dirname(privateKeyPath) : common.PROJECT_ROOT;
  for (const name of ['private_key.pem', 'public_key.pem']) removeFile(path.join(keyDir, name));
  if (privateKeyPath) removeFile(privateKeyPath);
  removeFile(envFile);

  console.log('\n========================================================');
  console.log('  Cleanup complete.  Environment is back to a clean state.');
  console.log('========================================================\n');
}

function removeFile(p) {
  if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
    try { fs.unlinkSync(p); console.log(`Removed: ${p}`); }
    catch (e) { process.stderr.write(`Warning: could not remove ${p}: ${e.message}\n`); }
  }
}

cleanupMain().then(() => common.closeRl()).catch((e) => {
  process.stderr.write(`\nError: ${e.message}\n`);
  process.exit(1);
});
