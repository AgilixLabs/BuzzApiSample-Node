/**
 * Buzz API client library.
 *
 * Makes requests to a Buzz API server, authenticating with OAuth 2.0 JWT client
 * credentials (RFC 6749 + RFC 7523). The client obtains and refreshes Bearer
 * access tokens automatically, retries transient failures with exponential
 * backoff, and handles throttling and backend pressure (rate limits, time
 * limits, and overload), whether the server reports it with HTTP 429/503 or
 * with a code in the XML/JSON response envelope.
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
 * The longest server-directed wait (Retry-After / X-RateLimit-Reset) the client
 * will sit out before retrying. Rate-limit windows are five minutes and the
 * server adds jitter, so a Retry-After of several minutes is normal. Retrying
 * before the server says to only burns quota, so a longer wait fails the
 * request instead of retrying early.
 */
const MAX_SERVER_DIRECTED_WAIT_MS = 10 * 60 * 1000;

/**
 * Response codes the server uses in the XML/JSON envelope to say "slow down and
 * retry later" (compared case-insensitively). Throttles are usually reported
 * with HTTP 200 (the server wraps them for legacy clients), so the envelope code
 * must be checked even when the HTTP status is a success. "TooManyRequests" is
 * what every throttle collapses to when the server is set to report throttles
 * generically; "Service Unavailable" is the code written when the server sheds
 * load before a request is authenticated.
 */
const THROTTLE_CODES = new Set([
  'toomanyrequests', 'retrylater', 'limitexceeded', 'ratelimit', 'timelimit',
  'serveroverwhelmed', 'backendpressure', 'service unavailable', 'serviceunavailable',
]);

/** Throttle codes that stand for HTTP 503 (overload) rather than 429 (rate/time limit). */
const OVERLOAD_THROTTLE_CODES = new Set([
  'serveroverwhelmed', 'backendpressure', 'service unavailable', 'serviceunavailable',
]);

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
  400, 401, 402, 403, 404, 405, 406, 407, 409, 410, 411, 412, 413, 414, 415, 416,
  417, 421, 422, 424, 426, 428, 431, 451,
  501, 505, 506, 508, 510, 511,
]);

/** Raised when a Buzz API call fails or returns a non-OK response code. */
export class BuzzApiError extends Error {
  /** The HTTP status behind the failure, when there is one. */
  readonly status?: number;

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BuzzApiError';
    this.status = status;
  }
}

/**
 * Raised when the Buzz API throttles a request (rate limit, time limit, or
 * backend pressure) and the client has run out of retries, or when items within
 * a batch or multi-object request were throttled.
 *
 * Extends `BuzzApiError` so existing handlers still catch it. `status` is 429 or
 * 503 even when the server wrapped the throttle in HTTP 200.
 */
export class BuzzApiThrottledError extends BuzzApiError {
  declare readonly status: number;

  /**
   * The throttle code from the response envelope (for example "TimeLimit",
   * "RateLimit", "BackendPressure", or "TooManyRequests"), or the OAuth error
   * code for the token endpoint. Null if the server sent no code.
   */
  readonly code: string | null;

  /** How long the server asked the client to wait (Retry-After or X-RateLimit-Reset), if it said. */
  readonly retryAfterMs: number | null;

  /**
   * For batch and multi-object requests, the indexes of the items that were
   * throttled and should be resubmitted. Items not listed here completed
   * normally (or failed for other reasons) and should not be resubmitted.
   * Empty when the whole request was throttled.
   */
  readonly throttledItemIndexes: readonly number[];

  /** The full response envelope, including the results of any items that were not throttled. */
  readonly response: Json;

  constructor(
    message: string,
    code: string | null,
    response: Json,
    throttledItemIndexes: readonly number[],
    retryAfterMs: number | null = null,
    status = 429,
  ) {
    super(message, status);
    this.name = 'BuzzApiThrottledError';
    this.code = code;
    this.response = response;
    this.throttledItemIndexes = throttledItemIndexes;
    this.retryAfterMs = retryAfterMs;
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

  /**
   * Epoch milliseconds before which no request from this client should be
   * sent. Set whenever the server signals throttling or backend pressure, so
   * concurrent requests sharing this client back off together instead of each
   * discovering the throttle separately.
   */
  private throttledUntilMs = 0;

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
   * @returns the parsed JSON response (an XML response is converted to the same
   *   shape), or null if the body was empty.
   * @throws BuzzApiThrottledError if the request is still throttled after the
   *   allowed retries, or the server asks to wait longer than 10 minutes.
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

    let node: Json = null;
    let authenticationRejected: boolean;
    try {
      node = await this.requestWithRetry(method, cmd, params, content, includeToken);
      this.traceResponse(node);
      authenticationRejected = responseCode(node) === 'NoAuthentication';
    } catch (e) {
      // REST-style endpoints report an expired or revoked token as HTTP 401, possibly with no envelope.
      if (!(e instanceof BuzzApiError && e.status === 401 && includeToken && this.token)) throw e;
      authenticationRejected = true;
    }

    // If the token expired or was revoked, re-authenticate and retry once.
    if (includeToken && this.token && authenticationRejected) {
      this.log('debug', 'Re-authenticating because the request was rejected with "NoAuthentication"');
      await this.authenticateOAuth();
      node = await this.requestWithRetry(method, cmd, params, content, includeToken);
      this.traceResponse(node);
    }
    return node;
  }

  /**
   * Verify that a Buzz JSON response indicates success.
   *
   * @throws BuzzApiThrottledError if the request, or any item of a batch or
   *   multi-object request, was throttled.
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

    const code = codeOf(toVerify);
    if (code !== 'OK') {
      const redacted = JSON.stringify(cloneAndRedact(responseJson));
      this.log('error', `Buzz API call failed. Expected response.code to be OK, found: ${redacted}`);
      if (isThrottleCode(code)) {
        throw new BuzzApiThrottledError(`Buzz API call was throttled (${code}): ${redacted}`,
          code, responseJson, [], null, throttleStatus(200, code));
      }
      throw new BuzzApiError(`Buzz API call failed. Expected response.code to be OK, found: ${redacted}`);
    }

    if (checkChildResponses) {
      const responses = childResponses(toVerify);

      // Batch and multi-object commands report per-item throttles under an outer
      // OK. Report them together so the caller can resubmit just those items.
      // Throttled batch items were rejected without running; a multi-object row
      // that hit BackendPressure (e.g. a database timeout) may have partially run.
      const throttledIndexes: number[] = [];
      responses.forEach((item, i) => {
        if (isThrottleCode(codeOf(item))) throttledIndexes.push(i);
      });
      if (throttledIndexes.length > 0) {
        const firstCode = codeOf(responses[throttledIndexes[0]]);
        const indexes = throttledIndexes.join(',');
        this.log('warn', `${throttledIndexes.length} of ${responses.length} items were throttled (${firstCode}); resubmit items ${indexes}`);
        throw new BuzzApiThrottledError(
          `${throttledIndexes.length} of ${responses.length} items were throttled (${firstCode}). Resubmit the items at indexes ${indexes}.`,
          firstCode, responseJson, throttledIndexes, null, throttleStatus(200, firstCode));
      }

      for (const item of responses) this.verifyResponse(item);
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

      await this.waitForThrottleWindow();

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

      if (resp.status < 200 || resp.status >= 300) {
        const body = await resp.text();
        // The token endpoint answers with RFC 6749 errors rather than the Buzz
        // envelope: rate limits and backend pressure are 429/503 with error
        // "temporarily_unavailable" and Retry-After.
        const errorField = tryParseEnvelope(body, resp.headers.get('content-type'))?.error;
        const oauthError = typeof errorField === 'string' ? errorField : null;
        if (resp.status === 429 || resp.status === 503 || oauthError === 'temporarily_unavailable') {
          const serverWait = serverDirectedWaitMs(resp.headers);
          const wait = throttleWaitMs(serverWait, baseWait);
          if (retriesRemaining > 0 && wait <= MAX_SERVER_DIRECTED_WAIT_MS) {
            this.log('warn', `OAuth token request throttled (${resp.status}, ${oauthError ?? 'no error code'}), backing off ${wait}ms, ${retriesRemaining} retries remaining`);
            this.extendThrottleWindow(wait);
            retriesRemaining--; baseWait *= 2;
            continue; // the throttle window is awaited at the top of the loop
          }
          this.extendThrottleWindow(Math.min(wait, MAX_SERVER_DIRECTED_WAIT_MS));
          throw new BuzzApiThrottledError(`OAuth token request was throttled (HTTP ${resp.status}): ${body}`,
            oauthError, null, [], serverWait, throttleStatus(resp.status, null));
        }
        if (retriesRemaining > 0 && statusAllowsRetry(resp.status)) {
          await sleep(waitFromRetryHeader(resp.headers.get('retry-after'), baseWait));
          retriesRemaining--; baseWait *= 2;
          continue;
        }
        this.log('error', `OAuth token request failed: ${resp.status} ${body}`);
        throw new BuzzApiError(`OAuth token request failed (HTTP ${resp.status}): ${body}`, resp.status);
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
  /**
   * Send a request, retrying transient failures, and return the parsed
   * response envelope (XML or JSON, normalized to JSON). Throttling is
   * recognized from the HTTP status (429/503) or from the envelope code, since
   * the server usually reports throttles as HTTP 200 with a code like
   * "TimeLimit" or "BackendPressure" in the body.
   */
  private async requestWithRetry(
    method: string,
    cmd: string | undefined,
    params: Record<string, string> | undefined,
    content: string | null,
    includeToken: boolean,
  ): Promise<Json> {
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
      await this.waitForThrottleWindow();

      this.traceRequest(url);
      let resp: Response;
      let body: string;
      try {
        resp = await fetch(url, {
          method,
          headers,
          body: content ?? undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        body = await resp.text();
      } catch (e) {
        if (retriesRemaining > 0) {
          await sleep(waitFromRetryHeader(null, baseWait));
          retriesRemaining--; baseWait *= 2;
          continue;
        }
        throw new BuzzApiError(`Request to ${url} failed: ${(e as Error).message}`);
      }

      // Parse strictly on success; on failure the envelope is optional (it may
      // be missing, or an HTML error page from a proxy). A success body that
      // fails to parse is not retried: the server already ran the command, and
      // resending a mutation (or a batch) could repeat it.
      const ok = resp.status >= 200 && resp.status < 300;
      const contentType = resp.headers.get('content-type');
      let envelope: Json;
      if (ok) {
        try {
          envelope = parseEnvelope(body, contentType);
        } catch (e) {
          throw new BuzzApiError(`Response to ${cmd ?? url} could not be parsed: ${(e as Error).message}`,
            resp.status, { cause: e });
        }
      } else {
        envelope = tryParseEnvelope(body, contentType);
      }
      const code = responseCode(envelope);

      // API time/rate limiting and backend pressure: HTTP 429/503 (REST-style),
      // or an envelope throttle code (usually with HTTP 200). Retry-After is
      // sent either way; X-RateLimit-Reset (seconds until the window resets)
      // is the fallback.
      if (resp.status === 429 || resp.status === 503 || isThrottleCode(code)) {
        const serverWait = serverDirectedWaitMs(resp.headers);
        const wait = throttleWaitMs(serverWait, baseWait);
        const message = envelope?.response?.message ?? null;
        if (retriesRemaining > 0 && wait <= MAX_SERVER_DIRECTED_WAIT_MS) {
          const service = resp.headers.get('x-backend-pressure-service');
          const level = resp.headers.get('x-backend-pressure-level');
          const pressure = service || level ? `, pressure: ${service ?? '?'} ${level ?? '?'}` : '';
          this.log('warn', `Request throttled (HTTP ${resp.status}, code ${code ?? 'none'}, message: ${message ?? 'none'}${pressure}), backing off ${wait}ms, ${retriesRemaining} retries remaining`);
          this.extendThrottleWindow(wait);
          retriesRemaining--; baseWait *= 2;
          continue; // the throttle window is awaited at the top of the loop
        }
        this.extendThrottleWindow(Math.min(wait, MAX_SERVER_DIRECTED_WAIT_MS));
        const reason = retriesRemaining > 0
          ? `server asked to wait ${Math.floor(wait / 1000)}s, longer than the ${MAX_SERVER_DIRECTED_WAIT_MS / 1000}s limit`
          : 'no retries remaining';
        throw new BuzzApiThrottledError(
          `Buzz API request was throttled (HTTP ${resp.status}, code ${code ?? 'none'}): ${message ?? ''} (${reason})`,
          code, envelope, [], serverWait, throttleStatus(resp.status, code));
      }

      if (ok) {
        this.extendThrottleWindowForThrottledItems(envelope, resp.headers);
        return envelope;
      }

      // A REST-style error status with an envelope (e.g. 400 BadRequest, 404
      // ResourceNotFound): return it so the caller sees the server's code and
      // message, just as it would for the same error wrapped in HTTP 200. 401 is
      // thrown instead so jsonRequest re-authenticates whether or not an
      // envelope came with it.
      if (code !== null && !statusAllowsRetry(resp.status) && resp.status !== 401) {
        return envelope;
      }

      if (retriesRemaining > 0 && statusAllowsRetry(resp.status)) {
        await sleep(waitFromRetryHeader(resp.headers.get('retry-after'), baseWait));
        retriesRemaining--; baseWait *= 2;
        continue;
      }
      throw new BuzzApiError(
        `Request to ${cmd ?? url} failed: HTTP ${resp.status}${code !== null ? ` (code ${code})` : ''}`, resp.status);
    }
  }

  // ── Throttle window ──────────────────────────────────────────────────────────
  /**
   * Back off the whole client when a successful batch or multi-object response
   * contains throttled items, so resubmitting them (and any other requests
   * sharing this client) waits as the server asked.
   */
  private extendThrottleWindowForThrottledItems(envelope: Json, headers: Headers): void {
    const response = envelope?.response && typeof envelope.response === 'object' ? envelope.response : envelope;
    const throttled = countThrottledItems(response);
    if (throttled === 0) return;
    const wait = Math.min(throttleWaitMs(serverDirectedWaitMs(headers), INITIAL_WAIT_MS), MAX_SERVER_DIRECTED_WAIT_MS);
    this.log('warn', `${throttled} items in the response were throttled; backing off ${wait}ms before the next request`);
    this.extendThrottleWindow(wait);
  }

  /**
   * Move the client-wide throttle window out to at least `waitMs` from now.
   * It never moves backward. Node runs this on a single thread, so a plain
   * compare-and-assign is safe across concurrent requests.
   */
  private extendThrottleWindow(waitMs: number): void {
    this.throttledUntilMs = Math.max(this.throttledUntilMs, Date.now() + waitMs);
  }

  /** Wait until the client-wide throttle window has passed. */
  private async waitForThrottleWindow(): Promise<void> {
    for (;;) {
      const remaining = this.throttledUntilMs - Date.now();
      if (remaining <= 0) return;
      this.log('debug', `Waiting ${remaining}ms for the server's throttle window to pass`);
      await sleep(remaining);
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

/**
 * Parse a response body as the XML or JSON envelope. The server returns XML
 * unless JSON is requested, and some error paths may ignore the Accept header,
 * so XML is converted to the equivalent JSON shape: attributes and child
 * elements become properties, repeated elements become arrays, and text
 * content becomes "$value".
 *
 * @returns the envelope as JSON, or null for an empty body.
 * @throws SyntaxError if the body is not well-formed JSON or XML.
 */
function parseEnvelope(body: string, contentType: string | null): Json {
  if (!body || !body.trim()) return null;
  const isXml = (contentType ?? '').toLowerCase().includes('xml') || body.trimStart().startsWith('<');
  return isXml ? xmlToJson(body) : JSON.parse(body);
}

/**
 * Like parseEnvelope, but returns null instead of throwing when the body is
 * not XML or JSON (for example, an HTML error page from a proxy).
 */
function tryParseEnvelope(body: string, contentType: string | null): Json {
  try {
    return parseEnvelope(body, contentType);
  } catch {
    return null;
  }
}

// ── XML to JSON ────────────────────────────────────────────────────────────────
// Node has no built-in XML parser, and this library has no runtime
// dependencies, so this is a small non-validating parser that covers what the
// Buzz response envelope uses: elements, attributes, text, CDATA, the five
// predefined entities and numeric character references, self-closing tags, and
// the XML declaration, comments, processing instructions, and DOCTYPE (skipped).
// Namespace prefixes are dropped and xmlns attributes ignored, as local names
// are all the envelope needs. Malformed XML throws a SyntaxError.

/** Convert an XML document to `{ <rootName>: object }`. */
function xmlToJson(xml: string): Json {
  return new XmlReader(xml).readDocument();
}

const XML_NAME = /[A-Za-z_:À-￿][-A-Za-z0-9_:.·-￿]*/y;

class XmlReader {
  private pos = 0;
  private readonly src: string;

  constructor(xml: string) {
    // XML parsers normalize line endings to \n; a leading BOM is not content.
    this.src = xml.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  }

  readDocument(): Json {
    this.skipMisc(true);
    if (this.src[this.pos] !== '<') this.fail('expected a root element');
    const root = this.readElement();
    this.skipMisc(false);
    if (this.pos < this.src.length) this.fail('unexpected content after the root element');
    const doc = {};
    setProp(doc, root.name, root.value);
    return doc;
  }

  /** Skip whitespace, comments, and processing instructions (and a DOCTYPE before the root). */
  private skipMisc(beforeRoot: boolean): void {
    for (;;) {
      this.skipWhitespace();
      if (this.startsWith('<?')) this.skipPast(2, '?>', 'processing instruction');
      else if (this.startsWith('<!--')) this.skipComment();
      else if (beforeRoot && this.startsWith('<!DOCTYPE')) this.skipDoctype();
      else return;
    }
  }

  private readElement(): { name: string; value: Json } {
    this.pos++; // '<'
    const name = this.readName();
    const obj = {};
    const seen = new Set<string>();

    // Attributes, then either '/>' or '>'.
    for (;;) {
      const hadSpace = this.skipWhitespace();
      if (this.startsWith('/>')) {
        this.pos += 2;
        return { name: localName(name), value: obj };
      }
      if (this.src[this.pos] === '>') {
        this.pos++;
        break;
      }
      if (this.pos >= this.src.length) this.fail(`unterminated start tag <${name}>`);
      if (!hadSpace) this.fail(`expected whitespace before an attribute in <${name}>`);
      const attrName = this.readName();
      this.skipWhitespace();
      if (this.src[this.pos] !== '=') this.fail(`expected '=' after attribute ${attrName}`);
      this.pos++;
      this.skipWhitespace();
      const quote = this.src[this.pos];
      if (quote !== '"' && quote !== "'") this.fail(`expected a quoted value for attribute ${attrName}`);
      const end = this.src.indexOf(quote, this.pos + 1);
      if (end < 0) this.fail(`unterminated value for attribute ${attrName}`);
      const raw = this.src.slice(this.pos + 1, end);
      if (raw.includes('<')) this.fail(`'<' in the value of attribute ${attrName}`);
      this.pos = end + 1;
      if (seen.has(attrName)) this.fail(`duplicate attribute ${attrName}`);
      seen.add(attrName);
      if (attrName === 'xmlns' || attrName.startsWith('xmlns:')) continue;
      // Attribute-value normalization: literal tabs and newlines become spaces
      // (character references to them are kept, so decode afterwards).
      setProp(obj, localName(attrName), this.decode(raw.replace(/[\t\n]/g, ' ')));
    }

    // Content: child elements, text, CDATA, comments, processing instructions.
    const children = new Map<string, Json[]>();
    let text = '';
    for (;;) {
      if (this.pos >= this.src.length) this.fail(`unclosed element <${name}>`);
      if (this.startsWith('</')) {
        this.pos += 2;
        const closing = this.readName();
        this.skipWhitespace();
        if (this.src[this.pos] !== '>') this.fail(`expected '>' to close </${closing}`);
        this.pos++;
        if (closing !== name) this.fail(`</${closing}> does not match <${name}>`);
        break;
      }
      if (this.startsWith('<!--')) {
        this.skipComment();
      } else if (this.startsWith('<![CDATA[')) {
        const end = this.src.indexOf(']]>', this.pos + 9);
        if (end < 0) this.fail('unterminated CDATA section');
        text += this.src.slice(this.pos + 9, end);
        this.pos = end + 3;
      } else if (this.startsWith('<?')) {
        this.skipPast(2, '?>', 'processing instruction');
      } else if (this.startsWith('<!')) {
        this.fail('unexpected markup declaration in element content');
      } else if (this.src[this.pos] === '<') {
        const child = this.readElement();
        const list = children.get(child.name);
        if (list) list.push(child.value);
        else children.set(child.name, [child.value]);
      } else {
        let end = this.src.indexOf('<', this.pos);
        if (end < 0) end = this.src.length;
        text += this.decode(this.src.slice(this.pos, end));
        this.pos = end;
      }
    }

    for (const [childName, list] of children) {
      setProp(obj, childName, list.length === 1 ? list[0] : list);
    }
    if (text.trim() !== '') setProp(obj, '$value', text);
    return { name: localName(name), value: obj };
  }

  private readName(): string {
    XML_NAME.lastIndex = this.pos;
    const match = XML_NAME.exec(this.src);
    if (!match) this.fail('expected a name');
    this.pos += match[0].length;
    return match[0];
  }

  /** Decode the predefined entities and numeric character references. */
  private decode(raw: string): string {
    if (!raw.includes('&')) return raw;
    return raw.replace(/&([^;&]*);|&/g, (_m, ref: string | undefined) => {
      switch (ref) {
        case undefined: return this.fail("'&' that does not start an entity reference");
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
      }
      let codePoint: number;
      if (/^#x[0-9A-Fa-f]+$/.test(ref)) codePoint = Number.parseInt(ref.slice(2), 16);
      else if (/^#[0-9]+$/.test(ref)) codePoint = Number.parseInt(ref.slice(1), 10);
      else return this.fail(`unknown entity &${ref};`);
      if (!isXmlChar(codePoint)) this.fail(`invalid character reference &${ref};`);
      return String.fromCodePoint(codePoint);
    });
  }

  private skipComment(): void {
    this.skipPast(4, '-->', 'comment');
  }

  private skipDoctype(): void {
    // Skip to the closing '>', stepping over an internal subset [...] and quoted strings.
    let depth = 0;
    for (let i = this.pos + 9; i < this.src.length; i++) {
      const c = this.src[i];
      if (c === '"' || c === "'") {
        const end = this.src.indexOf(c, i + 1);
        if (end < 0) break;
        i = end;
      } else if (c === '[') {
        depth++;
      } else if (c === ']') {
        depth--;
      } else if (c === '>' && depth <= 0) {
        this.pos = i + 1;
        return;
      }
    }
    this.fail('unterminated DOCTYPE');
  }

  private skipPast(openerLength: number, terminator: string, what: string): void {
    const end = this.src.indexOf(terminator, this.pos + openerLength);
    if (end < 0) this.fail(`unterminated ${what}`);
    this.pos = end + terminator.length;
  }

  /** Skip whitespace; returns whether any was skipped. */
  private skipWhitespace(): boolean {
    const start = this.pos;
    while (this.pos < this.src.length && ' \t\n\r'.includes(this.src[this.pos])) this.pos++;
    return this.pos > start;
  }

  private startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  private fail(message: string): never {
    throw new SyntaxError(`Invalid XML at offset ${this.pos}: ${message}`);
  }
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

function isXmlChar(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd
    || (cp >= 0x20 && cp <= 0xd7ff)
    || (cp >= 0xe000 && cp <= 0xfffd)
    || (cp >= 0x10000 && cp <= 0x10ffff);
}

/** Set a property as an own data property, so names like "__proto__" can't touch the prototype. */
function setProp(obj: object, key: string, value: Json): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/** The envelope code, which is `response.code` for a normal response. */
function responseCode(node: Json): string | null {
  if (node && typeof node === 'object') {
    if (node.response && typeof node.response === 'object') return codeOf(node.response);
    return codeOf(node);
  }
  return null;
}

/** The `code` property of a response object (or batch item), as a string. */
function codeOf(node: Json): string | null {
  const code = node && typeof node === 'object' ? node.code : null;
  return code == null ? null : String(code);
}

function isThrottleCode(code: string | null): boolean {
  return code !== null && THROTTLE_CODES.has(code.toLowerCase());
}

/**
 * The HTTP status to report for a throttle: the real one when the server sent
 * 429/503, otherwise the status the envelope code stands for (the server wraps
 * these in HTTP 200 for legacy clients).
 */
function throttleStatus(status: number, code: string | null): number {
  if (status === 429 || status === 503) return status;
  return code !== null && OVERLOAD_THROTTLE_CODES.has(code.toLowerCase()) ? 503 : 429;
}

/**
 * The per-item results of a batch or multi-object command
 * (`responses.response`). JSON always gives an array; a single item converted
 * from XML is an object.
 */
function childResponses(response: Json): Json[] {
  const items = response && typeof response === 'object' ? response.responses?.response : undefined;
  if (Array.isArray(items)) return items;
  return items && typeof items === 'object' ? [items] : [];
}

/**
 * Count throttled items at any depth, since a batch item can itself be a
 * multi-object command with per-row results.
 */
function countThrottledItems(response: Json): number {
  let count = 0;
  for (const item of childResponses(response)) {
    if (isThrottleCode(codeOf(item))) count++;
    count += countThrottledItems(item);
  }
  return count;
}

function statusAllowsRetry(status: number): boolean {
  return !NO_RETRY_STATUS.has(status);
}

/**
 * The wait the server asked for: Retry-After (delta-seconds or HTTP date)
 * first, then X-RateLimit-Reset, which Buzz sends as seconds until the
 * rate-limit window resets (not a Unix time). The server sends these on
 * throttled responses whether the HTTP status is 200 or 429/503.
 *
 * @returns the server-directed wait in milliseconds, or null if the server gave none.
 */
function serverDirectedWaitMs(headers: Headers): number | null {
  const retryAfter = retryAfterMs(headers.get('retry-after'));
  if (retryAfter != null && retryAfter > 0) return retryAfter;
  const reset = headers.get('x-ratelimit-reset')?.trim();
  if (reset && /^\d+$/.test(reset)) {
    const resetMs = Number.parseInt(reset, 10) * 1000;
    if (resetMs > 0) return resetMs;
  }
  return null;
}

/**
 * How long to back off from a throttle: the server-directed wait if there is
 * one (never less than the current exponential base), otherwise exponential
 * backoff with jitter. A server-directed wait is not capped here; the caller
 * compares it with MAX_SERVER_DIRECTED_WAIT_MS rather than retrying before the
 * server said to.
 */
function throttleWaitMs(serverWait: number | null, baseWait: number): number {
  if (serverWait != null) return Math.max(serverWait, baseWait);
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
