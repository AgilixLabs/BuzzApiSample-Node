#!/usr/bin/env node
'use strict';

/**
 * Entry point for the Buzz API sample.
 *
 * If setup has not been completed (.env missing or the private key file not
 * readable), the interactive setup runs first.  Then the TypeScript sample is
 * built (if needed) and run.
 *
 * Usage:
 *     node scripts/run-buzz-sample.js [--setup]
 *
 *     --setup   Force re-running setup even if already configured.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const common = require('./common');

function setupComplete() {
  common.loadEnv();
  for (const field of common.REQUIRED) {
    if (!process.env[common.ENV_VARS[field]]) return false;
  }
  const keyPath = process.env[common.ENV_VARS.privateKeyPath];
  return Boolean(keyPath) && fs.existsSync(keyPath);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: common.PROJECT_ROOT });
  return r.status ?? 1;
}

function main() {
  const force = process.argv.includes('--setup');

  if (force || !setupComplete()) {
    process.stdout.write(force
      ? '\n-- Running setup ---------------------------------------\n\n'
      : '\n-- Setup not complete - starting interactive setup -----\n\n');
    const rc = run(process.execPath, [path.join(__dirname, 'setup-buzz-oauth.js')]);
    if (rc !== 0) {
      process.stderr.write('\nSetup did not complete.  Exiting.\n');
      process.exit(1);
    }
  }

  // Build the TypeScript sample if the compiled output is missing.
  if (!fs.existsSync(path.join(common.PROJECT_ROOT, 'dist', 'sample.js'))) {
    process.stdout.write('\n-- Building (tsc) ---------------------------------------\n');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const rc = run(npm, ['run', 'build']);
    if (rc !== 0) {
      process.stderr.write('\nBuild failed.  Exiting.\n');
      process.exit(1);
    }
  }

  process.stdout.write('\n-- Running the sample ----------------------------------\n');
  process.exit(run(process.execPath, [path.join(common.PROJECT_ROOT, 'dist', 'sample.js')]));
}

main();
