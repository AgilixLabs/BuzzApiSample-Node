# BuzzApiSample-Node

A TypeScript sample and reusable client library for the Buzz API. The `BuzzApiClient` class
handles OAuth 2.0 authentication, automatic token refresh, exponential backoff, and rate-limit
compliance so your integration code can focus on business logic.

Targets **Node.js 22+** and uses only built-ins (`fetch`, `node:crypto`) — **no runtime
dependencies**. TypeScript is a build-time dev dependency only.

## Authentication

The only authentication method supported by the client is **OAuth 2.0 JWT Client Credentials**
([RFC 6749](https://www.rfc-editor.org/rfc/rfc6749) +
[RFC 7523](https://www.rfc-editor.org/rfc/rfc7523)).
An RSA private key signs a short-lived JWT assertion; Buzz verifies the signature against the
registered public key and returns a Bearer access token valid for one hour. The private key
never leaves your system — there is no shared secret to intercept.

> The legacy username/password (`login3`) flow is **not** used by new integrations and is not
> part of this client. It appears only inside the setup/cleanup scripts, where an administrator
> must briefly authenticate to create the Application Identity account and register keys.

---

## Overview

**`sample.ts`** demonstrates read-only access:
1. Configuring `BuzzApiClient` with OAuth credentials and a Buzz server URL.
2. Calling `getuser2` to verify authentication and discover the home domain.
3. Calling `getdomain2` to read domain details.

The sample is intentionally read-only — it can be run repeatedly without modifying any data.

**BuzzApiClient** simplifies integration by:
- Managing OAuth tokens automatically — requesting and refreshing Bearer tokens as needed.
- Retrying transient failures with exponential backoff (1 s → 64 s, up to 5 retries).
- Honouring `Retry-After` and `X-RateLimit-Reset` headers from the server.
- Providing `jsonRequest` and `verifyResponse` helpers for common JSON API patterns.

---

## Requirements

- **Node.js 22 or newer** (for stable global `fetch`).
- Install dev dependencies (TypeScript) and build once:

```bash
npm install
npm run build
```

## Compatibility

Written for **Node.js 22 LTS** (the oldest maintained LTS line) and verified to run on the
current release (Node 24). The client uses only stable built-ins, and the package has **zero
runtime dependencies**, so newer Node versions work without changes. Nothing here discourages
running on the latest Node.

## Configuration

Configuration uses **environment variables** (12-factor style). For local development you can put
them in a `.env` file in the project root — it is loaded automatically and is gitignored.

| Variable | Meaning |
|---|---|
| `BUZZ_SERVER_URL` | Buzz API server URL (no trailing slash) |
| `BUZZ_CONTACT_INFORMATION` | Contact info for the User-Agent header |
| `BUZZ_APPLICATION_INFORMATION` | Application name for the User-Agent header |
| `BUZZ_OAUTH_USER_ID` | `userid` of the Application Identity account (the OAuth `client_id`) |
| `BUZZ_OAUTH_KID` | Key id (`kid`) chosen when registering the public key |
| `BUZZ_PRIVATE_KEY_PATH` | Path to the RSA private key PEM |

Copy `.env.example` to `.env` and fill it in, or let the setup script generate it.

---

## Quickest start

### Run (setup + demo in one command)

The run script checks whether one-time setup has been completed. If not, it runs the interactive
setup first, then builds and executes the read-only demo.

```bash
node scripts/run-buzz-sample.js
node scripts/run-buzz-sample.js --setup    # force re-running setup
```

### Cleanup (return to a clean state)

Deletes the Application Identity account from Buzz, removes the registered OAuth key, and deletes
the local key files and `.env`.

```bash
node scripts/cleanup-buzz-sample.js
```

---

## OAuth setup (one time per application)

The setup script automates all of the following, but you can also perform the steps manually.

### Step 1 — Create an Application Identity account

An Application Identity account authenticates exclusively via OAuth. Create it with the
`createusers2` API and `type=applicationidentity`, using an admin account with the Create User
right in the target domain. Record the returned `userid` — this is your **OAuth User ID**
(`BUZZ_OAUTH_USER_ID`), used as the OAuth `client_id`.

### Step 2 — Generate an RSA key pair

```bash
node scripts/new-buzz-oauth-key.js                 # writes private_key.pem + public_key.pem
node scripts/new-buzz-oauth-key.js --out secrets --bits 4096
```

Choose a **Key ID** (`kid`), e.g. `2025-q2`. Allowed characters: ASCII letters, digits, `-`, `_`,
`.` (max 128).

> **SECURITY** — `private_key.pem` is gitignored. Store it in a secrets manager for production.
> Never commit it.

### Step 3 — Register the public key with Buzz

```bash
node scripts/register-buzz-oauth-key.js \
    -s https://api.agilixbuzz.com \
    -u 12345678 \
    -k 2025-q2 \
    -p public_key.pem
# Admin Bearer token via -t, the BUZZ_ADMIN_TOKEN env var, or an interactive prompt.
```

A `204 No Content` response means the key is stored.

### Step 4 — Configure and run

Create `.env` (see Configuration above) or run `node scripts/run-buzz-sample.js`, then:

```bash
npm run build && npm run sample
```

---

## Using BuzzApiClient in your own code

```ts
import { BuzzApiClient } from 'buzz-api-sample'; // or './dist'

const client = BuzzApiClient.fromPemFile(
  'https://api.agilixbuzz.com',
  'MyApp/1.0 (Node; MyApp; admin@example.com)',
  '12345678',        // oauthUserId
  '2025-q2',         // oauthKid
  'private_key.pem', // privateKeyPath
);

// BuzzApiClient obtains and refreshes Bearer tokens automatically.
const user = client.verifyResponse(await client.jsonRequest('GET', 'getuser2'));
const domain = client.verifyResponse(
  await client.jsonRequest('GET', 'getdomain2', { domainid: '6' }),
);
```

`jsonRequest(method, cmd?, params?, jsonBody?, includeToken?)` resolves to the parsed JSON
response. `verifyResponse(node)` throws `BuzzApiError` unless `response.code === "OK"` (and
recursively checks child responses from batch APIs).

---

## Key management

### Rotating a key (zero downtime)

1. Generate a new key pair and choose a new `kid`.
2. Register the new public key (PUTting a new `kid` leaves the old key active).
3. Update `BUZZ_OAUTH_KID` and `BUZZ_PRIVATE_KEY_PATH` to the new key.
4. Once all instances have switched over, delete the old key:
   `DELETE {server}/api/users/{userid}/keys/{old-kid}` with an admin Bearer token.

### Revoking a compromised key

Register a new key, switch your app to it, then delete the compromised public key and revoke
outstanding tokens (`POST {server}/api/oauth/revoke` with form body `token=<access_token>`).

---

## Troubleshooting OAuth

| Error | Cause | Fix |
|-------|-------|-----|
| `invalid_client: The client_assertion JWT has expired.` | Clock skew or a slow retry. | Sync your system clock (NTP). A fresh JWT is built for every token request. |
| `invalid_client: No active key found for the specified 'kid'.` | `BUZZ_OAUTH_KID` doesn't match a registered key. | Re-register the key and verify the `kid` matches exactly. |
| `invalid_client: ... signature or claims are invalid.` | Wrong private key, or `iss`/`sub` mismatch. | Confirm `BUZZ_OAUTH_USER_ID` is the Application Identity account's `userid` and the key matches the registered public key. |
| HTTP 400 registering a key | Wrong PEM format or key too small. | Use an SPKI PEM (`-----BEGIN PUBLIC KEY-----`), minimum 2048 bits. |
| HTTP 401/403 registering a key | Admin token lacks Update User rights. | Use an admin with the Update User right on the account. |
