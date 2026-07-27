/**
 * Buzz API client library.
 *
 * Makes requests to a Buzz API server, authenticating with OAuth 2.0 JWT client
 * credentials (RFC 6749 + RFC 7523). The client obtains and refreshes Bearer
 * access tokens automatically, retries transient failures with exponential
 * backoff, and honours rate-limit headers.
 *
 * Requires Node.js 22+ (uses the built-in global `fetch` and `node:crypto`).
 * No third-party runtime dependencies.
 */

import { createPrivateKey, randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

const RETRIES_TO_MAKE = 5;
const INITIAL_WAIT_MS = 1000;
const MAX_RETRY_WAIT_MS = 64000;

/**
 * How far before token expiry to proactively refresh. Tokens are valid for one
 * hour; refreshing five minutes early gives a comfortable window for slow
 * networks or clock skew.
 */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Fields that must never be written to logs. */
const SENSITIVE_FIELDS = new Set(
  ['token', 'access_token', 'refresh_token', 'password', 'client_assertion', 'client_secret'],
);

/**
 * HTTP status codes that must NOT be retried. Everything else — network errors,
 * timeouts, 500, 502, 504, 429, 503 — is retried.
 */
const NO_RETRY_STATUS = new Set([
  400, 401, 402, 403, 405, 406, 407, 410, 411, 412, 413, 414, 415, 416,
  417, 421, 422, 424, 426, 428, 431, 451,
  501, 505, 506, 508, 510, 511,
]);

/** Raised when a Buzz API call fails or returns a non-OK response code. */
export class BuzzApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuzzApiError';
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, message: string) => void;

export interface BuzzApiClientOptions {
  /** Log request URLs at info level instead of debug. */
  verbose?: boolean;
  /** Per-request timeout in milliseconds (default 600000). */
  timeoutMs?: number;
  /** Logger to use; defaults to writing info/warn/error to stderr. */
  logger?: Logger;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * A client for the Buzz API using OAuth 2.0 JWT client credentials.
 */
export class BuzzApiClient {
  readonly serverUrl: string;
  readonly userAgent: string;
  token: string | null = null;

  private readonly oauthUserId: string;
  private readonly oauthKid: string;
  private readonly privateKey: KeyObject;
  private readonly tokenEndpoint: string;
  private readonly verbose: boolean;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  private tokenExpiryMs = 0;
  private authInFlight: Promise<void> | null = null;

  constructor(
    serverUrl: string,
    userAgent: string,
    oauthUserId: string,
    oauthKid: string,
    privateKey: KeyObject,
    options: BuzzApiClientOptions = {},
  ) {
    if (!oauthUserId) throw new Error('oauthUserId is required');
    if (!oauthKid) throw new Error('oauthKid is required');
    if (!privateKey) throw new Error('privateKey is required');

    this.serverUrl = serverUrl.trim().replace(/\/+$/, '');
    this.userAgent = userAgent;
    this.oauthUserId = oauthUserId;
    this.oauthKid = oauthKid;
    this.privateKey = privateKey;
    this.verbose = options.verbose ?? false;
    this.timeoutMs = options.timeoutMs ?? 600000;
    this.logger = options.logger ?? defaultLogger;
    this.tokenEndpoint = `${this.serverUrl}/api/oauth/token`;
  }

  /** Create a client, loading the RSA private key from a PKCS#8 PEM file. */
  static fromPemFile(
    serverUrl: string,
    userAgent: string,
    oauthUserId: string,
    oauthKid: string,
    privateKeyPath: string,
    options: BuzzApiClientOptions = {},
  ): BuzzApiClient {
    const key = createPrivateKey(readFileSync(privateKeyPath));
    return new BuzzApiClient(serverUrl, userAgent, oauthUserId, oauthKid, key, options);
  }

  /**
   * Make a request to a Buzz command that returns JSON.
   *
   * @returns the parsed JSON response, or null if the body was empty.
   */
  async jsonRequest(
    method: string,
    cmd?: string,
    params?: Record<string, string>,
    jsonBody?: unknown,
    includeToken = true,
  ): Promise<Json> {
    if (includeToken) {
      await this.ensureToken();
    }
    const content = jsonBody === undefined || jsonBody === null ? null : JSON.stringify(jsonBody);

    let { body } = await this.requestWithRetry(method, cmd, params, content, includeToken);
    let node = parseJson(body);
    this.traceResponse(node);

    // If the token expired or was revoked, re-authenticate and retry once.
    if (includeToken && this.token && responseCode(node) === 'NoAuthentication') {
      this.log('debug', 'Re-authenticating because the request returned code "NoAuthentication"');
      await this.authenticateOAuth();
      ({ body } = await this.requestWithRetry(method, cmd, params, content, includeToken));
      node = parseJson(body);
      this.traceResponse(node);
    }
    return node;
  }

  /**
   * Verify that a Buzz JSON response indicates success.
   *
   * @throws BuzzApiError if the response code is not "OK".
   */
  verifyResponse(responseJson: Json, checkChildResponses = true): Json {
    if (responseJson == null) {
      this.log('error', 'Buzz API call failed. Expected response.code to be OK, found: null');
      throw new BuzzApiError('Buzz API call failed. Expected response.code to be OK, found: null');
    }

    let toVerify = responseJson;
    if (responseJson.response && typeof responseJson.response === 'object') {
      toVerify = responseJson.response;
    }

    if (toVerify?.code !== 'OK') {
      const redacted = JSON.stringify(cloneAndRedact(responseJson));
      this.log('error', `Buzz API call failed. Expected response.code to be OK, found: ${redacted}`);
      throw new BuzzApiError(`Buzz API call failed. Expected response.code to be OK, found: ${redacted}`);
    }

    if (checkChildResponses && toVerify.responses && toVerify.responses.response) {
      const child = toVerify.responses.response;
      if (Array.isArray(child)) {
        for (const item of child) this.verifyResponse(item);
      } else if (typeof child === 'object') {
        this.verifyResponse(child);
      }
    }
    return toVerify;
  }

  // ── OAuth ──────────────────────────────────────────────────────────────────
  private async ensureToken(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiryMs - TOKEN_REFRESH_MARGIN_MS) {
      return;
    }
    // Coalesce concurrent callers onto a single in-flight authentication.
    if (!this.authInFlight) {
      this.authInFlight = this.authenticateOAuth().finally(() => {
        this.authInFlight = null;
      });
    }
    await this.authInFlight;
  }

  /** Request a new Bearer access token using a signed JWT client assertion. */
  private async authenticateOAuth(): Promise<void> {
    this.log('info', 'Requesting OAuth access token');

    let retriesRemaining = RETRIES_TO_MAKE;
    let baseWait = INITIAL_WAIT_MS;
    for (;;) {
      // A fresh assertion is built on every attempt: JWTs expire in two minutes
      // and a long backoff can push a reused assertion past its exp claim.
      const assertion = this.buildClientAssertion();
      const form = new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      });

      let resp: Response;
      try {
        resp = await fetch(this.tokenEndpoint, {
          method: 'POST',
          headers: { 'User-Agent': this.userAgent, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if (retriesRemaining > 0) {
          await sleep(waitFromRetryHeader(null, baseWait));
          retriesRemaining--; baseWait *= 2;
          continue;
        }
        throw new BuzzApiError(`OAuth token request failed: ${(e as Error).message}`);
      }

      if ((resp.status === 429 || resp.status === 503) && retriesRemaining > 0) {
        const wait = waitFromResponse(resp, baseWait);
        this.log('warn', `OAuth token request rate-limited (${resp.status}), backing off ${wait}ms, ${retriesRemaining} retries remaining`);
        await sleep(wait);
        retriesRemaining--; baseWait *= 2;
        continue;
      }

      if (resp.status < 200 || resp.status >= 300) {
        if (retriesRemaining > 0 && statusAllowsRetry(resp.status)) {
          await sleep(waitFromRetryHeader(resp.headers.get('retry-after'), baseWait));
          retriesRemaining--; baseWait *= 2;
          continue;
        }
        const body = await resp.text();
        this.log('error', `OAuth token request failed: ${resp.status} ${body}`);
        throw new BuzzApiError(`OAuth token request failed (HTTP ${resp.status}): ${body}`);
      }

      const tokenJson = parseJson(await resp.text());
      const accessToken: string | undefined = tokenJson?.access_token;
      if (!accessToken) {
        throw new BuzzApiError('OAuth token response did not contain an access_token.');
      }
      let expiresIn = Number.parseInt(String(tokenJson.expires_in ?? '3600'), 10);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) expiresIn = 3600;
      this.token = accessToken;
      this.tokenExpiryMs = Date.now() + expiresIn * 1000;
      this.log('info', `OAuth token obtained, expires in ${expiresIn}s`);
      return;
    }
  }

  /**
   * Build a signed JWT client assertion for the token endpoint (RFC 7523 §3),
   * signed with RS256 (RSASSA-PKCS1-v1_5 + SHA-256).
   */
  private buildClientAssertion(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: this.oauthKid, typ: 'JWT' };
    const payload = {
      iss: this.oauthUserId,          // issuer = client
      sub: this.oauthUserId,          // subject = client (must equal iss per RFC 7523)
      aud: this.tokenEndpoint,        // audience = token endpoint URL
      iat: now,                       // issued at
      exp: now + 120,                 // expires (2-minute lifetime; max allowed is 5 min)
      jti: randomUUID().replace(/-/g, ''), // unique id — prevents replay attacks
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = cryptoSign('sha256', Buffer.from(signingInput), this.privateKey);
    return `${signingInput}.${signature.toString('base64url')}`;
  }

  // ── HTTP with retry ──────────────────────────────────────────────────────────
  private async requestWithRetry(
    method: string,
    cmd: string | undefined,
    params: Record<string, string> | undefined,
    content: string | null,
    includeToken: boolean,
  ): Promise<{ status: number; body: string }> {
    let url = `${this.serverUrl}/cmd${cmd ? `/${cmd}` : ''}`;
    if (params && Object.keys(params).length > 0) {
      url += `?${new URLSearchParams(params).toString()}`;
    }
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': this.userAgent };
    if (content !== null) headers['Content-Type'] = 'application/json';
    // OAuth always authenticates via the Authorization: Bearer header.
    if (includeToken && this.token) headers.Authorization = `Bearer ${this.token}`;

    let retriesRemaining = RETRIES_TO_MAKE;
    let baseWait = INITIAL_WAIT_MS;
    for (;;) {
      this.traceRequest(url);
      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers,
          body: content ?? undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if (retriesRemaining > 0) {
          await sleep(waitFromRetryHeader(null, baseWait));
          retriesRemaining--; baseWait *= 2;
          continue;
        }
        throw new BuzzApiError(`Request to ${url} failed: ${(e as Error).message}`);
      }

      if (resp.status === 429 || resp.status === 503) {
        if (retriesRemaining > 0) {
          const wait = waitFromResponse(resp, baseWait);
          this.log('warn', `Request rate/time limited (${resp.status}), backing off ${wait}ms, ${retriesRemaining} retries remaining`);
          await sleep(wait);
          retriesRemaining--; baseWait *= 2;
          continue;
        }
        throw new BuzzApiError(`Server returned ${resp.status} (rate/time limited). No retries remaining.`);
      }

      if (resp.status < 200 || resp.status >= 300) {
        if (retriesRemaining > 0 && statusAllowsRetry(resp.status)) {
          await sleep(waitFromRetryHeader(resp.headers.get('retry-after'), baseWait));
          retriesRemaining--; baseWait *= 2;
          continue;
        }
        throw new BuzzApiError(`Request to ${cmd ?? url} failed: HTTP ${resp.status}`);
      }
      return { status: resp.status, body: await resp.text() };
    }
  }

  // ── Logging ────────────────────────────────────────────────────────────────
  private traceRequest(url: string): void {
    // Bodies are never logged: request bodies may contain credentials.
    this.log(this.verbose ? 'info' : 'debug', `Request: ${redactQueryParam(url, '_token')}`);
  }

  private traceResponse(node: Json): void {
    if (node == null) {
      this.log('debug', 'Response was empty or not JSON');
      return;
    }
    const text = JSON.stringify(cloneAndRedact(node));
    this.log('debug', `Response: ${text.slice(0, 1000)}`);
  }

  private log(level: LogLevel, message: string): void {
    this.logger(level, message);
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────────
function defaultLogger(level: LogLevel, message: string): void {
  if (level === 'debug') return;
  process.stderr.write(`${level.toUpperCase()}: ${message}\n`);
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function parseJson(body: string): Json {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function responseCode(node: Json): string | null {
  if (node && typeof node === 'object') {
    if (node.response && typeof node.response === 'object') return node.response.code ?? null;
    return node.code ?? null;
  }
  return null;
}

function statusAllowsRetry(status: number): boolean {
  return !NO_RETRY_STATUS.has(status);
}

/** Backoff from rate-limit headers: Retry-After, else X-RateLimit-Reset. */
function waitFromResponse(resp: Response, baseWait: number): number {
  const seconds = retryAfterMs(resp.headers.get('retry-after'));
  if (seconds != null && seconds > 0) return clamp(seconds, baseWait, MAX_RETRY_WAIT_MS);

  const reset = resp.headers.get('x-ratelimit-reset');
  if (reset && /^\d+$/.test(reset.trim())) {
    const resetMs = Number.parseInt(reset.trim(), 10) * 1000;
    if (resetMs > 0) return clamp(resetMs, baseWait, MAX_RETRY_WAIT_MS);
  }
  return Math.min(MAX_RETRY_WAIT_MS, baseWait + jitter());
}

/** Backoff from a Retry-After header, else exponential backoff with jitter. */
function waitFromRetryHeader(retryAfter: string | null, baseWait: number): number {
  const ms = retryAfterMs(retryAfter);
  if (ms != null) return Math.min(MAX_RETRY_WAIT_MS, Math.max(baseWait, ms));
  return Math.min(MAX_RETRY_WAIT_MS, baseWait + jitter());
}

/** Parse a Retry-After value (delta-seconds or an HTTP date) into milliseconds. */
function retryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null;
  const v = retryAfter.trim();
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10) * 1000;
  const when = Date.parse(v);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

function jitter(): number {
  return 1 + Math.floor(Math.random() * 1000);
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactQueryParam(uri: string, paramName: string): string {
  const q = uri.indexOf('?');
  if (q < 0) return uri;
  const kept = uri.slice(q + 1).split('&').filter(
    (p) => !p.toLowerCase().startsWith(`${paramName.toLowerCase()}=`),
  );
  return kept.length > 0 ? `${uri.slice(0, q)}?${kept.join('&')}` : uri.slice(0, q);
}

/** Deep-copy a JSON value, masking any sensitive field values. */
function cloneAndRedact(node: Json): Json {
  if (Array.isArray(node)) return node.map(cloneAndRedact);
  if (node && typeof node === 'object') {
    const result: Record<string, Json> = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = SENSITIVE_FIELDS.has(key) ? '[REDACTED]' : cloneAndRedact(value);
    }
    return result;
  }
  return node;
}
