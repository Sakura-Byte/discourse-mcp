import test from "node:test";
import assert from "node:assert/strict";
import { Logger } from "../util/logger.js";
import { HttpClient } from "../http/client.js";
import { SiteState } from "../site/state.js";
import { registerAllTools, type RegistryOptions } from "../tools/registry.js";
import type { ToolRegistrar } from "../tools/types.js";
import { installImpersMock, makeImpersResponse } from "./http_mock.js";

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;

function createMockServer(): { server: ToolRegistrar; tools: Record<string, { handler: ToolHandler }> } {
  const tools: Record<string, { handler: ToolHandler }> = {};
  const server = {
    registerTool(name: string, _meta: Record<string, unknown>, handler: ToolHandler) {
      tools[name] = { handler };
    },
  } as ToolRegistrar;
  return { server, tools };
}

function discourseJsonRouter(calls: string[]) {
  return installImpersMock((_method, url) => {
    calls.push(url);
    if (url.endsWith("/about.json") || url.includes("/about.json")) {
      return makeImpersResponse({ body: { about: { title: "Example Discourse" } }, url });
    }
    if (url.includes("/search.json")) {
      return makeImpersResponse({
        body: { topics: [{ id: 123, title: "Hello World", slug: "hello-world" }] },
        url,
      });
    }
    if (url.endsWith("/site.json") || url.includes("/site.json")) {
      return makeImpersResponse({ body: { site: { title: "Example Discourse" } }, url });
    }
    return makeImpersResponse({ status: 404, body: "not found", contentType: "text/plain", url });
  });
}

test("SiteState preserves and normalizes subfolder base paths", () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });

  const first = siteState.buildClientForSite("https://example.com/forum");
  const second = siteState.buildClientForSite("https://example.com/forum/");

  assert.equal(first.base, "https://example.com/forum");
  assert.equal(second.base, "https://example.com/forum");
  assert.equal(first.client, second.client);
});

test("HttpClient routes leading-slash paths under subfolder base", async () => {
  const calls: string[] = [];
  const mock = discourseJsonRouter(calls);
  const logger = new Logger("silent");
  const client = new HttpClient({
    baseUrl: "https://example.com/forum",
    timeoutMs: 5000,
    logger,
    auth: { type: "none" },
  });

  try {
    await client.get("/about.json");
    assert.equal(calls[0], "https://example.com/forum/about.json");
  } finally {
    mock.restore();
  }
});

test("HttpClient root base still routes leading-slash paths from origin root", async () => {
  const calls: string[] = [];
  const mock = discourseJsonRouter(calls);
  const logger = new Logger("silent");
  const client = new HttpClient({
    baseUrl: "https://example.com",
    timeoutMs: 5000,
    logger,
    auth: { type: "none" },
  });

  try {
    await client.get("/about.json");
    assert.equal(calls[0], "https://example.com/about.json");
  } finally {
    mock.restore();
  }
});

test("HttpClient getCached cache key preserves subfolder base path", async () => {
  const calls: string[] = [];
  const mock = discourseJsonRouter(calls);
  const logger = new Logger("silent");
  const client = new HttpClient({
    baseUrl: "https://example.com/forum",
    timeoutMs: 5000,
    logger,
    auth: { type: "none" },
  });

  try {
    await client.getCached("/site.json", 60_000);
    await client.getCached("/site.json", 60_000);
    assert.deepEqual(calls, ["https://example.com/forum/site.json"]);
  } finally {
    mock.restore();
  }
});

test("HttpClient getBinary returns buffer and mime", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mock = installImpersMock((_m, url) =>
    makeImpersResponse({
      binary: png,
      contentType: "image/png",
      url: url + "?final=1",
    })
  );
  const logger = new Logger("silent");
  const client = new HttpClient({
    baseUrl: "https://example.com",
    timeoutMs: 5000,
    logger,
    auth: { type: "none" },
  });

  try {
    const bin = await client.getBinary("/uploads/short-url/x.png");
    assert.equal(bin.mimeType, "image/png");
    assert.equal(bin.bytes, png.length);
    assert.ok(bin.buffer.equals(png));
    assert.ok(bin.url.includes("x.png"));
  } finally {
    mock.restore();
  }
});

test("select-site then search flow preserves subfolder base path", async () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });
  const { server, tools } = createMockServer();
  const calls: string[] = [];
  const mock = discourseJsonRouter(calls);

  try {
    await registerAllTools(server, siteState, logger, {
      allowWrites: false,
      toolsMode: "discourse_api_only",
    } satisfies RegistryOptions);

    const selectRes = await tools["discourse_select_site"].handler({ site: "https://example.com/forum" }, {});
    assert.equal(selectRes?.isError, undefined);

    const searchRes = await tools["discourse_search"].handler({ query: "hello" }, {});
    assert.equal(searchRes?.isError, undefined);

    assert.equal(calls[0], "https://example.com/forum/about.json");
    assert.ok(calls[1]?.startsWith("https://example.com/forum/search.json?"));
  } finally {
    mock.restore();
  }
});

test("tethered validation then search preserves subfolder base path", async () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });
  const { server, tools } = createMockServer();
  const calls: string[] = [];
  const mock = discourseJsonRouter(calls);

  try {
    const { base, client } = siteState.buildClientForSite("https://example.com/forum");
    await client.get("/about.json");
    siteState.selectSite(base);

    await registerAllTools(server, siteState, logger, {
      allowWrites: false,
      toolsMode: "discourse_api_only",
      hideSelectSite: true,
    } satisfies RegistryOptions);
    assert.ok(!("discourse_select_site" in tools));

    const searchRes = await tools["discourse_search"].handler({ query: "hello" }, {});
    assert.equal(searchRes?.isError, undefined);

    assert.equal(calls[0], "https://example.com/forum/about.json");
    assert.ok(calls[1]?.startsWith("https://example.com/forum/search.json?"));
  } finally {
    mock.restore();
  }
});
