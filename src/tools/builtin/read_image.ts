import { z } from "zod";
import type { RegisterFn } from "../types.js";
import { jsonError } from "../../util/json_response.js";

/** Default cap so multimodal payloads stay reasonable for host agents. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
const DEFAULT_MAX_IMAGES = 3;
const HARD_MAX_IMAGES = 8;

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Resolve Discourse image references to fetchable URLs.
 * - upload://hash.ext  →  {site}/uploads/short-url/hash.ext
 * - relative /uploads/... → absolute on site origin
 * - absolute http(s) kept as-is
 */
export function resolveImageUrl(ref: string, siteBase: string): string {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("Empty image reference");

  if (trimmed.startsWith("upload://")) {
    const key = trimmed.slice("upload://".length).replace(/^\/+/, "");
    const base = siteBase.replace(/\/$/, "");
    return `${base}/uploads/short-url/${key}`;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }

  if (trimmed.startsWith("/")) {
    const origin = new URL(siteBase).origin;
    return `${origin}${trimmed}`;
  }

  // bare short-url key like "abc.jpeg"
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(trimmed)) {
    const base = siteBase.replace(/\/$/, "");
    return `${base}/uploads/short-url/${trimmed}`;
  }

  throw new Error(`Unrecognized image reference: ${trimmed.slice(0, 120)}`);
}

/** Extract image URLs from Discourse cooked HTML and/or raw markdown.
 * Prefer site-local upload:// / short-url (same host as API, better CF auth path)
 * before CDN optimized URLs.
 */
export function extractImageRefs(cooked: string, raw: string): string[] {
  const preferred: string[] = [];
  const rest: string[] = [];
  const seen = new Set<string>();

  const isPreferred = (t: string) =>
    t.startsWith("upload://") || t.includes("/uploads/short-url/") || t.startsWith("/uploads/");

  const push = (u: string) => {
    let t = u.trim();
    if (!t || seen.has(t)) return;
    if (t.startsWith("data:")) return;
    // strip download query noise for de-dupe but keep path
    seen.add(t);
    if (isPreferred(t)) preferred.push(t);
    else rest.push(t);
  };

  // 1) raw markdown first — stable upload:// keys
  if (raw) {
    for (const m of raw.matchAll(/upload:\/\/([A-Za-z0-9_.-]+)/g)) {
      push(`upload://${m[1]}`);
    }
    for (const m of raw.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (target.startsWith("upload://") || /^https?:\/\//i.test(target) || target.startsWith("/uploads/")) {
        push(target);
      }
    }
  }

  // 2) cooked HTML (CDN optimized + lightbox originals)
  if (cooked) {
    for (const m of cooked.matchAll(/data-(?:download-href|orig-src)=["']([^"']+)["']/gi)) {
      push(m[1]);
    }
    for (const m of cooked.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
      push(m[1]);
    }
    for (const m of cooked.matchAll(/<a\b[^>]*\bhref=["']([^"']+\.(?:png|jpe?g|gif|webp|svg)(?:\?[^"']*)?)["']/gi)) {
      push(m[1]);
    }
  }

  return [...preferred, ...rest];
}

function normalizeMime(mime: string, url: string): string {
  const base = (mime || "").split(";")[0].trim().toLowerCase();
  if (base.startsWith("image/")) return base;
  // CDN sometimes returns octet-stream; sniff extension
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return base || "application/octet-stream";
}

export const registerReadImage: RegisterFn = (server, ctx) => {
  const schema = z.object({
    url: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Image URL or Discourse short ref: https://..., /uploads/..., or upload://xxxx.jpeg (from post raw markdown)'
      ),
    post_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Load images embedded in this post (from cooked HTML + raw markdown)"),
    image_index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("When using post_id, only return this 0-based image index"),
    max_images: z
      .number()
      .int()
      .min(1)
      .max(HARD_MAX_IMAGES)
      .optional()
      .describe(`Max images to return when reading a post (default ${DEFAULT_MAX_IMAGES}, hard max ${HARD_MAX_IMAGES})`),
    max_bytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Max bytes per image (default ${DEFAULT_MAX_BYTES})`),
  });

  server.registerTool(
    "discourse_read_image",
    {
      title: "Read Image",
      description:
        "Fetch Discourse post images for the model to view. Returns MCP image content (base64 + mimeType) plus a short text summary. " +
        "Pass url (https / upload:// / short path) and/or post_id to extract images from a post. " +
        "Use after discourse_read_post/topic when raw contains ![alt](upload://...). " +
        "Does not rotate browser profiles; uses the same authenticated HTTP client as other tools.",
      inputSchema: schema.shape,
    },
    async (args: z.infer<typeof schema>) => {
      try {
        if (!args.url && !args.post_id) {
          return jsonError("Provide url and/or post_id");
        }
        const { client, base } = ctx.siteState.ensureSelectedSite();
        const maxBytes = args.max_bytes ?? DEFAULT_MAX_BYTES;
        const maxImages = Math.min(args.max_images ?? DEFAULT_MAX_IMAGES, HARD_MAX_IMAGES);

        const refs: string[] = [];

        if (args.post_id) {
          const data = (await client.get(`/posts/${args.post_id}.json?include_raw=true`)) as any;
          const cooked = String(data?.cooked || "");
          const raw = String(data?.raw || "");
          const found = extractImageRefs(cooked, raw);
          if (found.length === 0) {
            return jsonError(`No images found in post ${args.post_id}`);
          }
          if (args.image_index !== undefined) {
            if (args.image_index >= found.length) {
              return jsonError(`image_index ${args.image_index} out of range (post has ${found.length} image(s))`);
            }
            refs.push(found[args.image_index]);
          } else {
            refs.push(...found.slice(0, maxImages));
          }
        }

        if (args.url) {
          refs.unshift(args.url);
        }

        // de-dupe while preserving order
        const uniqueRefs: string[] = [];
        const seen = new Set<string>();
        for (const r of refs) {
          if (seen.has(r)) continue;
          seen.add(r);
          uniqueRefs.push(r);
        }

        const toFetch = uniqueRefs.slice(0, maxImages);
        if (toFetch.length === 0) {
          return jsonError("No image URLs to fetch");
        }

        const content: McpContent[] = [];
        const meta: Array<Record<string, unknown>> = [];

        for (let i = 0; i < toFetch.length; i++) {
          const ref = toFetch[i];
          const absolute = resolveImageUrl(ref, base);
          try {
            const bin = await client.getBinary(absolute, { maxBytes });
            const mimeType = normalizeMime(bin.mimeType, bin.url);
            if (!mimeType.startsWith("image/") && mimeType !== "application/octet-stream") {
              meta.push({
                index: i,
                ref,
                url: bin.url,
                error: `Not an image content-type: ${mimeType}`,
                bytes: bin.bytes,
              });
              continue;
            }
            const finalMime = mimeType === "application/octet-stream" ? normalizeMime("", bin.url) : mimeType;
            if (!finalMime.startsWith("image/")) {
              meta.push({
                index: i,
                ref,
                url: bin.url,
                error: `Could not determine image MIME type (got ${mimeType})`,
                bytes: bin.bytes,
              });
              continue;
            }

            content.push({
              type: "image",
              data: bin.buffer.toString("base64"),
              mimeType: finalMime,
            });
            meta.push({
              index: i,
              ref,
              url: bin.url,
              mimeType: finalMime,
              bytes: bin.bytes,
            });
          } catch (e: any) {
            meta.push({
              index: i,
              ref,
              url: absolute,
              error: e?.message || String(e),
            });
          }
        }

        const loaded = content.filter((c) => c.type === "image").length;
        if (loaded === 0) {
          return jsonError("Failed to load any images", { images: meta });
        }

        // MCP: text summary + image content blocks (type:image + base64) so hosts can feed vision models
        content.unshift({
          type: "text",
          text: JSON.stringify({
            loaded,
            requested: toFetch.length,
            images: meta,
          }),
        });

        return { content };
      } catch (e: any) {
        return jsonError(`Failed to read image: ${e?.message || String(e)}`);
      }
    }
  );
};
