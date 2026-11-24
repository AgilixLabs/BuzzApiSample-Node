#!/usr/bin/env node
'use strict';

/**
 * Entry point for the Buzz API sample.
 *
 * If setup has not been completed (.env missing or the private key file not
 * readable), the interactive setup runs first.  Then the TypeScript sample is
 * built and run.
 *
 * The sample runs under a temporary application name (QUICK_START_NAME), so the
 * quick start works before you have named your application in src/sample.ts.  The
 * name is declared to tsc and defined at run time from files in a temporary
 * directory; src/sample.ts is never edited and dist/ holds no name.  Set your own
 * name in src/sample.ts before using the code anywhere else.
 *
 * Usage:
 *     node scripts/run-buzz-sample.js [--setup]
 *
 *     --setup   Force re-running setup even if already configured.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const common = require('./common');

// The User-Agent application name the quick start runs the sample under.
const QUICK_START_NAME = 'QuickStartSample/1.0';

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

  process.exit(runQuickStart(QUICK_START_NAME));
}

/**
 * Build the sample with YOUR_APPLICATION_NAME defined as `name` and, unless
 * `buildOnly`, run it.  The name lives only in a temporary directory: a declaration
 * for tsc, and a preload that sets it on globalThis for node.  Returns the exit code.
 * scripts/Test-BuzzSample.ps1 uses this too.
 */
function runQuickStart(name, { buildOnly = false } = {}) {
  const root = common.PROJECT_ROOT;
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    process.stderr.write('\nTypeScript is not installed.  Run npm install first.\n');
    return 1;
  }
  const slash = (p) => p.split(path.sep).join('/');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-quickstart-'));
  try {
    fs.writeFileSync(path.join(dir, 'name.d.ts'), 'declare const YOUR_APPLICATION_NAME: string;\n');
    fs.writeFileSync(path.join(dir, 'name.js'), `globalThis.YOUR_APPLICATION_NAME = ${JSON.stringify(name)};\n`);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      extends: slash(path.join(root, 'tsconfig.json')),
      // Paths resolve against this temporary tsconfig, so point them back at the project.
      compilerOptions: {
        outDir: slash(path.join(root, 'dist')),
        rootDir: slash(path.join(root, 'src')),
        typeRoots: [slash(path.join(root, 'node_modules', '@types'))],
      },
      include: [slash(path.join(root, 'src')) + '/**/*', slash(path.join(dir, 'name.d.ts'))],
    }));

    process.stdout.write('\n-- Building (tsc) ---------------------------------------\n');
    if (run(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')]) !== 0) {
      process.stderr.write('\nBuild failed.  Exiting.\n');
      return 1;
    }
    if (buildOnly) return 0;

    process.stdout.write('\n-- Running the sample ----------------------------------\n');
    return run(process.execPath, ['--require', path.join(dir, 'name.js'), path.join(root, 'dist', 'sample.js')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runQuickStart };

if (require.main === module) main();
