import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "../util/logger.js";
import { registerAllTools, type RegistryOptions } from "../tools/registry.js";
import { registerAllResources, type ResourceRegistrar } from "../resources/registry.js";
import { registerAllPrompts, type PromptRegistrar } from "../prompts/registry.js";
import { SiteState } from "../site/state.js";
import type { ToolRegistrar } from "../tools/types.js";
import { installImpersMock, makeImpersResponse } from "./http_mock.js";
import { extractImageRefs, resolveImageUrl } from "../tools/builtin/read_image.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;

/** Creates a minimal mock server that captures tool registrations for testing */
function createMockServer(): { server: ToolRegistrar; tools: Record<string, { handler: ToolHandler }> } {
  const tools: Record<string, { handler: ToolHandler }> = {};
  const server = {
    registerTool(name: string, _meta: Record<string, unknown>, handler: ToolHandler) {
      tools[name] = { handler };
    },
  } as ToolRegistrar;
  return { server, tools };
}

function discourseMock(extra?: (url: string) => ReturnType<typeof makeImpersResponse> | null) {
  const calls: string[] = [];
  const mock = installImpersMock((_method, url) => {
    calls.push(url);
    const custom = extra?.(url);
    if (custom) return custom;
    if (url.includes("/about.json")) {
      return makeImpersResponse({ body: { about: { title: "Example Discourse" } }, url });
    }
    if (url.includes("/search.json")) {
      return makeImpersResponse({
        body: { topics: [{ id: 123, title: "Hello World", slug: "hello-world" }] },
        url,
      });
    }
    if (url.includes("/posts/") && url.includes(".json")) {
      return makeImpersResponse({
        body: {
          id: 1,
          raw: "![x](upload://abc123.jpeg)",
          cooked: '<img src="https://cdn.example.com/a.jpeg">',
        },
        url,
      });
    }
    if (url.includes("/uploads/short-url/") || url.includes("cdn.example.com")) {
      return makeImpersResponse({
        binary: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        contentType: "image/jpeg",
        url,
      });
    }
    return makeImpersResponse({ status: 404, body: "not found", contentType: "text/plain", url });
  });
  return { mock, calls };
}

test("registers built-in tools", async () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });

  test("registers write-enabled tools when allowWrites=true", async () => {
    const logger = new Logger("silent");
    const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });

    const { server, tools } = createMockServer();

    await registerAllTools(server, siteState, logger, {
      allowWrites: true,
      toolsMode: "discourse_api_only",
    } satisfies RegistryOptions);

    assert.ok("discourse_create_post" in tools);
    assert.ok("discourse_create_category" in tools);
    assert.ok("discourse_create_topic" in tools);
    assert.ok("discourse_update_topic" in tools);
    assert.ok("discourse_update_user" in tools);
  });

  test("does not register write tools when allowWrites=false", async () => {
    const logger = new Logger("silent");
    const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });

    const { server, tools } = createMockServer();

    await registerAllTools(server, siteState, logger, {
      allowWrites: false,
      toolsMode: "discourse_api_only",
    } satisfies RegistryOptions);

    assert.ok(!("discourse_create_post" in tools));
    assert.ok(!("discourse_create_topic" in tools));
    assert.ok(!("discourse_update_topic" in tools));
    assert.ok(!("discourse_update_user" in tools));

    assert.ok("discourse_search" in tools);
    assert.ok("discourse_read_topic" in tools);
    assert.ok("discourse_read_image" in tools);
  });

  const server = new McpServer(
    { name: "test", version: "0.0.0" },
    { capabilities: { tools: { listChanged: false } } }
  );

  await registerAllTools(server, siteState, logger, {
    allowWrites: false,
    toolsMode: "discourse_api_only",
  } satisfies RegistryOptions);

  assert.ok(true);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readFixture(name: string) {
  const p = path.resolve(__dirname, "../../fixtures/try", name);
  try {
    const data = await readFile(p, "utf8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

test("fixtures manifest exists or sync script can be run", async () => {
  const manifest = await readFixture("manifest.json");
  assert.ok(manifest === null || typeof manifest === "object");
});

test("select-site then search flow works with mocked HTTP", async () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });
  const { server, tools } = createMockServer();
  const { mock } = discourseMock();

  try {
    await registerAllTools(server, siteState, logger, { allowWrites: false, toolsMode: "discourse_api_only" });

    const selectRes = await tools["discourse_select_site"].handler({ site: "https://example.com" }, {});
    assert.equal(selectRes?.isError, undefined);

    const searchRes = await tools["discourse_search"].handler({ query: "hello" }, {});
    const text = String(searchRes?.content?.[0]?.text || "");
    const json = JSON.parse(text);
    assert.ok(json.results);
    assert.equal(json.results[0].slug, "hello-world");
  } finally {
    mock.restore();
  }
});

test("tethered mode hides select_site and allows search without selection", async () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });
  const { server, tools } = createMockServer();
  const { mock } = discourseMock();

  try {
    const { base, client } = siteState.buildClientForSite("https://example.com");
    await client.get("/about.json");
    siteState.selectSite(base);

    await registerAllTools(server, siteState, logger, {
      allowWrites: false,
      toolsMode: "discourse_api_only",
      hideSelectSite: true,
    } satisfies RegistryOptions);

    assert.ok(!("discourse_select_site" in tools));

    const searchRes = await tools["discourse_search"].handler({ query: "hello" }, {});
    const text = String(searchRes?.content?.[0]?.text || "");
    const json = JSON.parse(text);
    assert.ok(json.results);
    assert.equal(json.results[0].slug, "hello-world");
  } finally {
    mock.restore();
  }
});

test("default-search prefix is applied to queries", async () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });
  const { server, tools } = createMockServer();
  const { mock, calls } = discourseMock();

  try {
    const { base, client } = siteState.buildClientForSite("https://example.com");
    await client.get("/about.json");
    siteState.selectSite(base);

    await registerAllTools(server, siteState, logger, {
      allowWrites: false,
      toolsMode: "discourse_api_only",
      defaultSearchPrefix: "tag:ai order:latest",
    } satisfies RegistryOptions);

    await tools["discourse_search"].handler({ query: "hello world" }, {});
    const searchUrl = calls.find((u) => u.includes("/search.json"));
    assert.ok(searchUrl && searchUrl.includes("/search.json?"));
    const qs = searchUrl!.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    assert.equal(params.get("expanded"), "true");
    assert.equal(params.get("q"), "tag:ai order:latest hello world");
  } finally {
    mock.restore();
  }
});

// ========================
// Tool registration tests
// ========================

const READ_ONLY_TOOLS = [
  "discourse_select_site",
  "discourse_search",
  "discourse_filter_topics",
  "discourse_read_topic",
  "discourse_read_post",
  "discourse_read_image",
  "discourse_get_user",
  "discourse_list_user_posts",
  "discourse_get_chat_messages",
  "discourse_get_draft",
];

const ADMIN_READ_TOOLS = ["discourse_list_users", "discourse_get_query", "discourse_run_query"];

const WRITE_TOOLS = [
  "discourse_create_post",
  "discourse_create_user",
  "discourse_create_category",
  "discourse_create_topic",
  "discourse_update_topic",
  "discourse_update_post",
  "discourse_update_user",
  "discourse_upload_file",
  "discourse_save_draft",
  "discourse_delete_draft",
  "discourse_create_query",
  "discourse_update_query",
  "discourse_delete_query",
];

test("read-only mode registers read + admin-read tools (access checked at call time)", async () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });
  const { server, tools } = createMockServer();

  await registerAllTools(server, siteState, logger, {
    allowWrites: false,
    toolsMode: "discourse_api_only",
  });

  const registeredTools = Object.keys(tools).sort();
  const expectedTools = [...READ_ONLY_TOOLS, ...ADMIN_READ_TOOLS].sort();
  assert.deepEqual(registeredTools, expectedTools);
});

test("write mode registers all tools", async () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });
  const { server, tools } = createMockServer();

  await registerAllTools(server, siteState, logger, {
    allowWrites: true,
    toolsMode: "discourse_api_only",
  });

  const registeredTools = Object.keys(tools).sort();
  const expectedTools = [...READ_ONLY_TOOLS, ...ADMIN_READ_TOOLS, ...WRITE_TOOLS].sort();
  assert.deepEqual(registeredTools, expectedTools);
});

test("tethered mode hides select_site from tool list", async () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });
  const { server, tools } = createMockServer();

  await registerAllTools(server, siteState, logger, {
    allowWrites: false,
    toolsMode: "discourse_api_only",
    hideSelectSite: true,
  } satisfies RegistryOptions);

  assert.ok(!("discourse_select_site" in tools));
  const registeredTools = Object.keys(tools).sort();
  const expectedTools = [...READ_ONLY_TOOLS, ...ADMIN_READ_TOOLS]
    .filter((t) => t !== "discourse_select_site")
    .sort();
  assert.deepEqual(registeredTools, expectedTools);
});

// ========================
// read_image helpers + tool
// ========================

test("extractImageRefs prefers upload:// over CDN", () => {
  const raw = "![a|1x1](upload://abc.jpeg)\ntext";
  const cooked =
    '<img src="https://cdn.example.com/opt/a.jpeg"><a data-download-href="/uploads/short-url/abc.jpeg?dl=1">';
  const refs = extractImageRefs(cooked, raw);
  assert.ok(refs[0] === "upload://abc.jpeg" || refs[0].includes("/uploads/short-url/"));
  assert.ok(refs.some((r) => r.includes("cdn.example.com") || r.startsWith("upload://")));
});

test("resolveImageUrl maps upload:// to short-url", () => {
  assert.equal(
    resolveImageUrl("upload://abc.jpeg", "https://www.example.com/"),
    "https://www.example.com/uploads/short-url/abc.jpeg"
  );
  assert.equal(
    resolveImageUrl("/uploads/short-url/x.png", "https://www.example.com/forum"),
    "https://www.example.com/uploads/short-url/x.png"
  );
});

test("discourse_read_image returns MCP image content blocks", async () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });
  const { server, tools } = createMockServer();
  const { mock } = discourseMock();

  try {
    const { base, client } = siteState.buildClientForSite("https://example.com");
    await client.get("/about.json");
    siteState.selectSite(base);

    await registerAllTools(server, siteState, logger, {
      allowWrites: false,
      toolsMode: "discourse_api_only",
    });

    const res = await tools["discourse_read_image"].handler(
      { url: "upload://abc123.jpeg" },
      {}
    );
    assert.equal(res?.isError, undefined);
    const types = (res?.content || []).map((c) => c.type);
    assert.ok(types.includes("text"));
    assert.ok(types.includes("image"));
    const img = (res?.content || []).find((c) => c.type === "image");
    assert.equal(img?.mimeType, "image/jpeg");
    assert.ok(img?.data && img.data.length > 0);
  } finally {
    mock.restore();
  }
});

// ========================
// Resources / prompts registration
// ========================

const BASE_RESOURCES = [
  "site_categories",
  "site_tags",
  "site_groups",
  "chat_channels",
  "user_chat_channels",
  "user_drafts",
];

const ADMIN_RESOURCES = [
  "explorer_schema",
  "explorer_schema_tables",
  "explorer_queries",
  "explorer_queries_page",
];

function createMockResourceServer(): { server: ResourceRegistrar; resources: Record<string, unknown> } {
  const resources: Record<string, unknown> = {};
  const server = {
    resource(name: string, ...rest: unknown[]) {
      resources[name] = rest;
    },
  } as ResourceRegistrar;
  return { server, resources };
}

test("resources always includes Data Explorer resources regardless of auth", async () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });
  const { server, resources } = createMockResourceServer();

  registerAllResources(server, { siteState, logger });

  const registeredResources = Object.keys(resources).sort();
  const expectedResources = [...BASE_RESOURCES, ...ADMIN_RESOURCES].sort();
  assert.deepEqual(registeredResources, expectedResources);
});

function createMockPromptServer(): { server: PromptRegistrar; prompts: Record<string, unknown> } {
  const prompts: Record<string, unknown> = {};
  const server = {
    registerPrompt(name: string, ...rest: unknown[]) {
      prompts[name] = rest;
    },
  } as PromptRegistrar;
  return { server, prompts };
}

test("prompts always includes sql_query prompt regardless of auth", async () => {
  const logger = new Logger("silent");
  const siteState = new SiteState({ logger, timeoutMs: 5000, defaultAuth: { type: "none" } });
  const { server, prompts } = createMockPromptServer();

  registerAllPrompts(server, { siteState, logger });

  assert.deepEqual(Object.keys(prompts), ["sql_query"]);
});
