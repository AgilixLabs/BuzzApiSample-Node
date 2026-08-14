#!/usr/bin/env node
'use strict';

/**
 * Generate an RSA key pair for Buzz OAuth 2.0 authentication.
 *
 * Usage:
 *     node scripts/new-buzz-oauth-key.js [--out DIR] [--bits N] [--force]
 *
 * Outputs:
 *     private_key.pem  — RSA private key  (keep secret; never commit to source control)
 *     public_key.pem   — RSA public key   (register with register-buzz-oauth-key.js)
 *
 * Uses Node's built-in crypto.  No external OpenSSL needed.
 */

const common = require('./common');

async function main() {
  const args = process.argv.slice(2);
  let outDir = '.';
  let bits = 2048;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-o': case '--out': outDir = args[++i]; break;
      case '-b': case '--bits': bits = parseInt(args[++i], 10); break;
      case '-f': case '--force': force = true; break;
      case '-h': case '--help':
        console.log('Usage: node scripts/new-buzz-oauth-key.js [--out DIR] [--bits N] [--force]');
        return;
      default: break;
    }
  }

  const fs = require('node:fs');
  const path = require('node:path');
  if (!force && fs.existsSync(path.join(outDir, 'private_key.pem'))) {
    const ok = await common.confirm('Key files already exist and will be overwritten.  Continue?');
    common.closeRl();
    if (!ok) { console.log('Aborted.'); return; }
    force = true;
  }

  try {
    const [privPath, pubPath] = common.generateKeyPair(outDir, bits, force);
    console.log(`\nRSA key pair generated (${bits} bits):`);
    console.log(`  Private key : ${privPath}`);
    console.log(`  Public key  : ${pubPath}\n`);
    console.log('Next step: register the public key with Buzz.');
    console.log('  node scripts/register-buzz-oauth-key.js -s https://backgroundapi.agilixbuzz.com -u <userid> -k <kid> -p public_key.pem\n');
    console.log('IMPORTANT: Never commit private_key.pem to source control.');
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exitCode = 1;
  }
}

main();
