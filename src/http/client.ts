import { Logger } from "../util/logger.js";
import {
  bootstrapLibcurlWithGh,
  formatBootstrapFailure,
} from "./bootstrap_libcurl.js";
import { SlidingWindowRateLimiter, type SlidingWindowOptions } from "./rate_limit.js";

export type AuthMode =
  | { type: "none" }
  | { type: "api_key"; key: string; username?: string }
  | { type: "user_api_key"; key: string; client_id?: string };

export interface HttpClientOptions {
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
  auth: AuthMode;
  httpBasicAuth?: { user: string; pass: string };
  /** Browser profile for impers / curl-impersonate (default chrome120; works with official libcurl-impersonate releases). */
  impersonate?: string;
  /**
   * Optional sliding-window limit for all outbound HTTP (reads + writes).
   * max<=0 disables. When rateLimit.statePath is set, shared across processes.
   */
  rateLimit?: SlidingWindowOptions;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = "HttpError";
  }
}

type ImpersModule = typeof import("impers");
type MultipartField = import("impers").MultipartField;

let impersModule: ImpersModule | null = null;

/**
 * Test-only hook: inject a fake impers module (must implement `request`).
 * Pass `null` to clear and restore real impers on next use.
 */
export function setImpersModuleForTests(mod: ImpersModule | null): void {
  impersModule = mod;
}

/**
 * Load impers and let it resolve libcurl with its native order:
 * 1. LIBCURL_IMPERSONATE_PATH
 * 2. LIBCURL_PATH
 * 3. common install paths
 * 4. download curl-impersonate from GitHub into ~/.cache/impers/...
 * 5. system libcurl (no impersonate)
 */
async function getImpers(): Promise<ImpersModule> {
  if (!impersModule) {
    impersModule = await import("impers");
  }
  return impersModule;
}

/**
 * Startup probe for curl-impersonate.
 *
 * 1. Let impers resolve (env → common paths → its own GitHub download → system libcurl)
 * 2. If still not impersonate, try `gh release download` into the impers cache
 * 3. Re-resolve; if still missing, return failure (caller prints install hints)
 */
export async function checkImpersonateLibrary(logger?: Logger): Promise<{
  isImpersonate: boolean;
  path: string;
  via?: "impers" | "gh";
  bootstrapError?: string;
}> {
  const impers = await getImpers();
  let info = await impers.resolveLibrary();
  if (info.isImpersonate) {
    return { isImpersonate: true, path: info.path, via: "impers" };
  }

  // Impers path failed (often GitHub API rate limit). Fall back to authenticated `gh`.
  if (logger) {
    logger.info(
      `libcurl-impersonate not available via impers (resolved ${info.path}); trying GitHub CLI (gh) fallback...`
    );
  }

  const boot = bootstrapLibcurlWithGh(
    logger ??
      ({
        info: (m: string) => console.error(m),
        error: (m: string) => console.error(m),
        debug: () => {},
      } as unknown as Logger)
  );

  if (!boot.ok) {
    return {
      isImpersonate: false,
      path: info.path,
      bootstrapError: formatBootstrapFailure(boot),
    };
  }

  info = await impers.resolveLibrary();
  if (info.isImpersonate) {
    return { isImpersonate: true, path: info.path, via: "gh" };
  }

  return {
    isImpersonate: false,
    path: info.path,
    bootstrapError:
      `gh download finished but impers still resolved non-impersonate library: ${info.path}\n` +
      `Cache dir: ${boot.cacheDir}\n` +
      `Try setting LIBCURL_IMPERSONATE_PATH explicitly to the dylib/so/dll under that directory.`,
  };
}

async function formDataToMultipart(formData: FormData): Promise<MultipartField[]> {
  const fields: MultipartField[] = [];
  for (const [name, value] of formData.entries()) {
    if (typeof value === "string") {
      fields.push({ name, value });
      continue;
    }
    // File / Blob (Node 18+ File extends Blob)
    const blob = value as Blob & { name?: string };
    const buf = Buffer.from(await blob.arrayBuffer());
    fields.push({
      name,
      value: buf,
      filename: blob.name || "file",
      contentType: blob.type || undefined,
    });
  }
  return fields;
}

export class HttpClient {
  private base: URL;
  private cache = new Map<string, { value: any; expiresAt: number }>();
  private impersonate: string;
  private rateLimiter: SlidingWindowRateLimiter | null;

  constructor(private opts: HttpClientOptions) {
    this.base = new URL(opts.baseUrl);
    if (!this.base.pathname.endsWith("/")) {
      this.base.pathname += "/";
    }
    this.impersonate = opts.impersonate || "chrome120";
    this.rateLimiter =
      opts.rateLimit && opts.rateLimit.max > 0 && opts.rateLimit.windowMs > 0
        ? new SlidingWindowRateLimiter(opts.rateLimit, (msg) => this.opts.logger.error(msg))
        : null;
  }

  private urlFor(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      return new URL(path).toString();
    }

    const relativePath = path.replace(/^\/+/, "");
    return new URL(relativePath, this.base).toString();
  }

  private headers(): Record<string, string> {
    // Do not force a custom User-Agent when impersonating — let impers defaultHeaders
    // supply a browser-consistent UA (better for Cloudflare TLS fingerprinting).
    const h: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.opts.auth.type === "api_key") {
      h["Api-Key"] = this.opts.auth.key;
      if (this.opts.auth.username) h["Api-Username"] = this.opts.auth.username;
    } else if (this.opts.auth.type === "user_api_key") {
      h["User-Api-Key"] = this.opts.auth.key;
      if (this.opts.auth.client_id) h["User-Api-Client-Id"] = this.opts.auth.client_id;
    }
    if (this.opts.httpBasicAuth) {
      const { user, pass } = this.opts.httpBasicAuth;
      const encoded = Buffer.from(`${user}:${pass}`).toString("base64");
      h["Authorization"] = `Basic ${encoded}`;
    }
    return h;
  }

  async get(path: string, { signal, headers }: { signal?: AbortSignal; headers?: Record<string, string> } = {}) {
    return this.request("GET", path, undefined, { signal, extraHeaders: headers });
  }

  /**
   * Fetch binary content (images, files). Returns Buffer + mime + final URL after redirects.
   */
  async getBinary(
    path: string,
    { signal, headers, maxBytes }: { signal?: AbortSignal; headers?: Record<string, string>; maxBytes?: number } = {}
  ): Promise<{ buffer: Buffer; mimeType: string; url: string; bytes: number }> {
    const h = this.headers();
    // Do not force JSON Accept for binary assets (CDN images, short-url redirects)
    h["Accept"] = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
    if (headers) Object.assign(h, headers);

    const result = await this.executeRequestBinary("GET", path, h, signal);
    if (maxBytes && result.buffer.length > maxBytes) {
      throw new Error(
        `Binary response too large (${result.buffer.length} bytes > max ${maxBytes}). ` +
          `Try a smaller/optimized URL or raise the limit.`
      );
    }
    return result;
  }

  async getCached(path: string, ttlMs: number, { signal }: { signal?: AbortSignal } = {}) {
    const url = this.urlFor(path);
    const entry = this.cache.get(url);
    const now = Date.now();
    if (entry && entry.expiresAt > now) return entry.value;
    const value = await this.request("GET", path, undefined, { signal });
    this.cache.set(url, { value, expiresAt: now + ttlMs });
    return value;
  }

  async post(path: string, body: unknown, { signal, headers }: { signal?: AbortSignal; headers?: Record<string, string> } = {}) {
    return this.request("POST", path, body, { signal, extraHeaders: headers });
  }

  async delete(path: string, body?: unknown, { signal, headers }: { signal?: AbortSignal; headers?: Record<string, string> } = {}) {
    return this.request("DELETE", path, body, { signal, extraHeaders: headers });
  }

  async put(path: string, body: unknown, { signal, headers }: { signal?: AbortSignal; headers?: Record<string, string> } = {}) {
    return this.request("PUT", path, body, { signal, extraHeaders: headers });
  }

  async postMultipart(path: string, formData: FormData, { signal, headers }: { signal?: AbortSignal; headers?: Record<string, string> } = {}) {
    return this.requestMultipart("POST", path, formData, { signal, extraHeaders: headers });
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    { signal, extraHeaders }: { signal?: AbortSignal; extraHeaders?: Record<string, string> } = {}
  ) {
    const headers = this.headers();
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }
    return this.executeRequest(
      method,
      path,
      body !== undefined ? JSON.stringify(body) : undefined,
      headers,
      signal
    );
  }

  private async requestMultipart(
    method: string,
    path: string,
    formData: FormData,
    { signal, extraHeaders }: { signal?: AbortSignal; extraHeaders?: Record<string, string> } = {}
  ) {
    const headers = this.headers();
    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }
    // Content-Type + boundary set by impers multipart handling
    delete headers["Content-Type"];
    return this.executeRequest(method, path, formData, headers, signal, /* allowRetries */ false);
  }

  private async executeRequest(
    method: string,
    path: string,
    body: string | FormData | undefined,
    headers: Record<string, string>,
    signal?: AbortSignal,
    allowRetries = true
  ) {
    const res = await this.perform(method, path, body, headers, signal, allowRetries);
    const ct = res.headers.get("content-type") || res.contentType || "";
    if (ct.includes("application/json")) {
      try {
        return res.json();
      } catch {
        return safeJson(res.text);
      }
    }
    return res.text;
  }

  private async executeRequestBinary(
    method: string,
    path: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
    allowRetries = true
  ): Promise<{ buffer: Buffer; mimeType: string; url: string; bytes: number }> {
    const res = await this.perform(method, path, undefined, headers, signal, allowRetries);
    const buffer: Buffer = Buffer.isBuffer(res.content) ? res.content : Buffer.from(res.content ?? []);
    const mimeType =
      (res.headers.get("content-type") || res.contentType || "application/octet-stream").split(";")[0].trim() ||
      "application/octet-stream";
    return {
      buffer,
      mimeType,
      url: res.url || this.urlFor(path),
      bytes: buffer.length,
    };
  }

  /** Shared impers request with retries; returns the raw Response-like object. */
  private async perform(
    method: string,
    path: string,
    body: string | FormData | undefined,
    headers: Record<string, string>,
    signal?: AbortSignal,
    allowRetries = true
  ) {
    const url = this.urlFor(path);
    this.opts.logger.debug(`HTTP ${method} ${url} (impersonate=${this.impersonate})`);

    if (this.rateLimiter) {
      const waited = await this.rateLimiter.acquire();
      if (waited > 0) {
        this.opts.logger.debug(`HTTP rate limit waited ${waited}ms before ${method} ${url}`);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const combinedSignal = mergeSignals([signal, controller.signal]);

    const attempt = async () => {
      try {
        const impers = await getImpers();
        const options: import("impers").RequestOptions = {
          headers,
          impersonate: this.impersonate,
          // Keep browser default headers (UA, sec-ch-ua, etc.) for CF compatibility
          defaultHeaders: true,
          timeout: Math.max(1, Math.ceil(this.opts.timeoutMs / 1000)),
          signal: combinedSignal,
        };

        if (body instanceof FormData) {
          options.multipart = await formDataToMultipart(body);
        } else if (typeof body === "string") {
          options.content = body;
        }

        const res = await impers.request(method, url, options);

        this.opts.logger.debug(`HTTP ${method} ${url} -> ${res.status} ${res.statusText}`);

        if (!res.ok) {
          const text = res.text || "";
          const errorBody = safeJson(text);
          this.opts.logger.error(`HTTP ${res.status} ${res.statusText} for ${method} ${url}: ${text.slice(0, 2000)}`);
          throw new HttpError(res.status, `HTTP ${res.status} ${res.statusText}`, errorBody);
        }

        return res;
      } catch (e: any) {
        if (e instanceof HttpError) {
          throw e;
        }

        if (e?.name === "AbortError" || e?.name === "Timeout" || e?.name === "ReadTimeout" || e?.name === "ConnectTimeout") {
          const timeoutMsg = `Request timeout after ${this.opts.timeoutMs}ms for ${method} ${url}`;
          this.opts.logger.error(timeoutMsg);
          throw new Error(timeoutMsg);
        }

        const name = e?.name || "Error";
        const message = e?.message || String(e);
        const genericMsg = `HTTP client error for ${method} ${url}: ${name}: ${message}`;
        this.opts.logger.error(genericMsg);
        if (e?.cause) {
          this.opts.logger.error(`Cause: ${String(e.cause)}`);
        }
        if (e?.stack) {
          this.opts.logger.debug(`Stack: ${e.stack}`);
        }
        throw new Error(`${name}: ${message}`);
      }
    };

    try {
      const maxRetries = allowRetries ? 3 : 1;
      return await withRetries(attempt, this.opts.logger, url, method, maxRetries);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isRetriableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  // 403: intermittent Cloudflare challenges (delay-retry only; no profile rotation)
  // 429 / 5xx: rate limits and transient server errors (upstream behaviour)
  return status === 403 || status === 429 || status >= 500;
}

async function withRetries<T>(fn: () => Promise<T>, logger: Logger, url: string, method: string, retries = 3): Promise<T> {
  let attempt = 0;
  // Start a bit higher for CF 403 cool-down; still doubles each attempt
  let delay = 500;
  for (;;) {
    try {
      return await fn();
    } catch (e: any) {
      const status = e?.status as number | undefined;
      if (attempt < retries - 1 && isRetriableStatus(status)) {
        attempt++;
        logger.info(
          `Retrying ${method} ${url} (attempt ${attempt}/${retries - 1}) after ${delay}ms due to HTTP ${status}`
        );
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      if (attempt > 0) {
        logger.error(`Request failed after ${attempt + 1} attempts: ${method} ${url}`);
      }
      throw e;
    }
  }
}

function mergeSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
