/**
 * Configuration for the Buzz API sample.
 *
 * Configuration is read from environment variables (12-factor style). For local
 * development the variables may be placed in a `.env` file in the project root;
 * {@link loadEnv} loads that file into `process.env` without overwriting
 * variables already set in the real environment.
 *
 * No third-party dependency is required — the `.env` parser is built in.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface BuzzConfig {
  serverUrl: string;
  contactInformation: string;
  applicationInformation: string;
  oauthUserId: string;
  oauthKid: string;
  privateKeyPath: string;
}

/** Logical field -> environment variable name. */
export const ENV_VARS: Record<keyof BuzzConfig, string> = {
  serverUrl: 'BUZZ_SERVER_URL',
  contactInformation: 'BUZZ_CONTACT_INFORMATION',
  applicationInformation: 'BUZZ_APPLICATION_INFORMATION',
  oauthUserId: 'BUZZ_OAUTH_USER_ID',
  oauthKid: 'BUZZ_OAUTH_KID',
  privateKeyPath: 'BUZZ_PRIVATE_KEY_PATH',
};

const REQUIRED: (keyof BuzzConfig)[] = ['serverUrl', 'oauthUserId', 'oauthKid', 'privateKeyPath'];

/** Path to the `.env` file in the project root (parent of the compiled dist/). */
export function defaultEnvPath(): string {
  return resolve(__dirname, '..', '.env');
}

/**
 * Load `KEY=VALUE` lines from a `.env` file into `process.env`.
 *
 * Existing environment variables are never overwritten, so the real environment
 * always wins. Returns true if a file was found and read.
 */
export function loadEnv(path: string = defaultEnvPath()): boolean {
  if (!existsSync(path)) return false;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
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

/**
 * Read configuration from the environment (optionally loading `.env` first).
 * Exits the process with a helpful message if required values are missing.
 */
export function readConfig(loadDotenv = true): BuzzConfig {
  if (loadDotenv) loadEnv();

  const config = {} as BuzzConfig;
  for (const field of Object.keys(ENV_VARS) as (keyof BuzzConfig)[]) {
    config[field] = process.env[ENV_VARS[field]] ?? '';
  }

  const missing = REQUIRED.filter((f) => !config[f]).map((f) => ENV_VARS[f]);
  if (missing.length > 0) {
    process.stderr.write(
      `Missing required configuration: ${missing.join(', ')}\n`
      + '  Run setup:  node scripts/run-buzz-sample.js\n'
      + '  or copy .env.example to .env and fill it in (see README.md).\n',
    );
    process.exit(1);
  }
  return config;
}
