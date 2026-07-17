/**
 * Shared mock for HttpClient tests.
 * HttpClient uses impers (not fetch); tests must inject a fake module via setImpersModuleForTests.
 */
import { setImpersModuleForTests } from "../http/client.js";

export type MockResponseInit = {
  status?: number;
  body?: unknown;
  contentType?: string;
  /** Final URL after redirects (for getBinary). */
  url?: string;
  binary?: Buffer;
};

export function makeImpersResponse(init: MockResponseInit = {}) {
  const status = init.status ?? 200;
  const contentType = init.contentType ?? (init.binary ? "application/octet-stream" : "application/json");
  const buffer = init.binary
    ? init.binary
    : Buffer.from(typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? {}));
  const text = buffer.toString("utf8");

  return {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    ok: status >= 200 && status < 300,
    text,
    content: buffer,
    contentType,
    url: init.url || "",
    headers: {
      get(name: string) {
        if (name.toLowerCase() === "content-type") return contentType;
        return null;
      },
    },
    json() {
      return JSON.parse(text);
    },
  };
}

export type RequestHandler = (
  method: string,
  url: string,
  options: Record<string, unknown>
) => ReturnType<typeof makeImpersResponse> | Promise<ReturnType<typeof makeImpersResponse>>;

/**
 * Install impers mock. Returns { calls, restore }.
 * `calls` records absolute request URLs (and methods).
 */
export function installImpersMock(handler: RequestHandler) {
  const calls: Array<{ method: string; url: string }> = [];

  const mod = {
    async request(method: string, url: string, options: Record<string, unknown> = {}) {
      calls.push({ method, url });
      return handler(method, url, options);
    },
    async resolveLibrary() {
      return { path: "mock-libcurl-impersonate", isImpersonate: true };
    },
  };

  // Cast: only the methods HttpClient uses are required
  setImpersModuleForTests(mod as any);

  return {
    calls,
    urls: () => calls.map((c) => c.url),
    restore() {
      setImpersModuleForTests(null);
    },
  };
}

/** Convenience JSON router by URL suffix/substring (matches former fetch mocks). */
export function installJsonRouteMock(
  routes: Array<{ match: (url: string) => boolean; body: unknown; status?: number }>
) {
  return installImpersMock((_method, url) => {
    for (const r of routes) {
      if (r.match(url)) {
        return makeImpersResponse({ status: r.status ?? 200, body: r.body, contentType: "application/json", url });
      }
    }
    return makeImpersResponse({
      status: 404,
      body: "not found",
      contentType: "text/plain",
      url,
    });
  });
}
