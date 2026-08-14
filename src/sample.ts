/**
 * Buzz API OAuth 2.0 sample — read-only demo.
 *
 * Demonstrates read-only access to the Buzz API:
 *   1. Configuring BuzzApiClient with OAuth credentials.
 *   2. Calling getuser2 to verify authentication and discover the home domain.
 *   3. Calling getdomain2 to read domain details.
 *
 * The sample is intentionally read-only — it can be run repeatedly without
 * modifying any data in the target domain.
 *
 * Quickest start:  node scripts/run-buzz-sample.js
 */

import { BuzzApiClient, type Logger } from './buzzApiClient';
import { readConfig } from './config';

async function main(): Promise<void> {
  const config = readConfig();
  const userAgent = `BuzzApiClient/1.0.0 (Node; ${config.applicationInformation}; ${config.contactInformation})`;

  // Show info/warn/error; suppress debug (request/response tracing) for a clean demo.
  const logger: Logger = (level, message) => {
    if (level === 'debug') return;
    process.stdout.write(`${level.toUpperCase()}: ${message}\n`);
  };

  const client = BuzzApiClient.fromPemFile(
    config.serverUrl,
    userAgent,
    config.oauthUserId,
    config.oauthKid,
    config.privateKeyPath,
    { logger },
  );

  await runSample(client, logger);
}

async function runSample(client: BuzzApiClient, log: Logger): Promise<void> {
  console.log();
  console.log('========================================================');
  console.log('  Buzz API OAuth 2.0 Sample - Read-Only Demo (Node)');
  console.log('========================================================');
  console.log();

  // getuser2: verify authentication and discover the home domain.
  console.log('-- getuser2 (verify authentication) --------------------');
  const userNode = client.verifyResponse(await client.jsonRequest('GET', 'getuser2'));
  const user = userNode.user ?? {};

  // This server returns the identifier as "id"; older servers use "userid".
  // The User schema names this "id".  ("userid" is the CreateUsers2 *response*
  // field for a newly created user - a different command, not an alias here.)
  const userId = user.id;
  log('info', `Authenticated as user ${user.username} ("${user.firstname} ${user.lastname}", userid: ${userId})`);
  const domainId = user.domainid;
  log('info', `Home domain: ${domainId}`);

  // getdomain2: read details about the account's home domain.
  if (domainId) {
    console.log();
    console.log('-- getdomain2 (read domain details) --------------------');
    const domainNode = client.verifyResponse(
      await client.jsonRequest('GET', 'getdomain2', { domainid: String(domainId) }),
    );
    const domain = domainNode.domain ?? {};
    log('info', `Domain name: ${domain.name}`);
    log('info', `Userspace  : ${domain.userspace}`);
    if (domain.type) log('info', `Type       : ${domain.type}`);
  }

  console.log();
  console.log('========================================================');
  console.log('  All API calls succeeded.  OAuth integration is working.');
  console.log('  No data was created or modified.');
  console.log('========================================================');
  console.log();
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
