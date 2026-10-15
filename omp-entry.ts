/**
 * OMP adapter for pi-opencode-free PR #3 (ReStranger:fix/plugin-loads-models).
 *
 * Upstream `src/index.ts` targets stock Pi (`@earendil-works/pi-ai/compat`
 * engine registry, `refreshModels` lifecycle, `before_provider_headers`
 * hook) — none of which exist in OMP. This entry reuses the PR's portable
 * core untouched (`zen-headers`, `zen-payload`, `discovery`) and wires it
 * through OMP's API: `pi.registerProvider` + a `globalThis.fetch` patch
 * for opencode.ai traffic (same proven pattern as pi-opencode-zen).
 *
 * Recipe (from the PR): official UA, canonical descending ses_ ids,
 * `public` lane credentials per backend, and agent-shaped payloads
 * (stream + five core tools) — no marker prompt, no daemon.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  OPENCODE_PUBLIC_API_KEY,
  OPENCODE_USER_AGENT,
  ZEN_ANTHROPIC_BASE_URL,
  ZEN_BASE_URL,
  applyOpenCodeFreeHeaders,
  canonicalSessionId,
  type MutableHeaders,
} from "./src/zen-headers.js";
import { applyOpenCodeFreePayload } from "./src/zen-payload.js";
import { discoverModels } from "./src/discovery.js";

export const PROVIDER_ID = "opencode-free";

 // Fallback catalog (live discovery refreshes on `omp models` refresh;
// ids without a known engine default to chat completions, except
// Muse Spark which is Responses-only). Limits mirror models.dev's
// `opencode` provider section; jev-1.13-free is a Zen-only alias with no
// catalog entry, so it keeps the conservative defaults.
const FALLBACK: { id: string; api?: string; contextWindow?: number; maxTokens?: number }[] = [
  { id: "big-pickle", contextWindow: 200_000, maxTokens: 32_000 },
  { id: "cat-jam-free", contextWindow: 262_144, maxTokens: 131_072 },
  { id: "mimo-v2.6-flash-free", contextWindow: 200_000, maxTokens: 32_000 },
  { id: "muse-spark-1.2-contributor-free", api: "openai-responses", contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: "muse-spark-1.3-contributor-free", api: "openai-responses", contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: "nemotron-3.5-lightning-free", contextWindow: 262_144, maxTokens: 262_144 },
  { id: "jev-1.13-free" },
  { id: "step-5-preview-free", contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: "longcat-2.5-preview-free", contextWindow: 1_000_000, maxTokens: 131_072 },
  { id: "deepseek-v4.1-flash-free", contextWindow: 200_000, maxTokens: 32_000 },
  { id: "space-bunny-free", contextWindow: 1_048_576, maxTokens: 524_288 },
];

export function toOmpModel(m: { id: string; name?: string; api?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }) {
  const id = m.id.replace(/^opencode\//, "");
  const native =
    m.api === "openai-responses" ||
    m.api === "anthropic-messages" ||
    m.api === "google-generative-ai"
      ? m.api
      : "openai-completions";
  return {
    id,
    name: m.name ?? id,
    api: native,
    ...(native === "anthropic-messages" ? { baseUrl: ZEN_ANTHROPIC_BASE_URL } : {}),
    reasoning: m.reasoning ?? true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? 128_000,
    maxTokens: m.maxTokens ?? 16_384,
  };
}

/** Backend detection for responses/completions payloads. */
function detectApiFromPayload(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if ("input" in body && Array.isArray(body.input)) return "openai-responses";
  if ("messages" in body && Array.isArray(body.messages)) return "openai-completions";
  if ("contents" in body) return "google-generative-ai";
  return undefined;
}

/** Only shape our own traffic: opencode-free serves ids ending in -free and big-pickle. */
function isFreePayload(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  if (!("model" in body) || typeof body.model !== "string") return false;
  return /(^|\/)[a-z0-9_.-]+-free$/i.test(body.model) || /(^|\/)big-pickle$/i.test(body.model);
}

function detectApi(url: string, body: unknown): string {
  if (url.includes("/responses")) return "openai-responses";
  if (url.includes("/chat/completions")) return "openai-completions";
  if (url.includes("/messages")) return "anthropic-messages";
  if (url.includes("generateContent")) return "google-generative-ai";
  if (
    typeof body === "object" &&
    body !== null &&
    "input" in body &&
    Array.isArray(body.input)
  ) {
    return "openai-responses";
  }
  return "openai-completions";
}

function isFreeUrl(url: string): boolean {
  return url.includes("opencode.ai");
}

type PatchedFetch = typeof globalThis.fetch & { __freePatched?: boolean };

function installFetchPatch(): void {
  const current = globalThis.fetch as PatchedFetch;
  if (current.__freePatched) return;
  const base = current;
  const patched = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    let url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as Request)?.url ?? "");
    if (!isFreeUrl(url)) return base(input as RequestInfo | URL, init);
    if (url.includes("opencode.ai/zen/v1")) {
      url = url.replace("opencode.ai/zen/v1", "opencode.ai/inference/v1");
    } else if (url.includes("opencode.ai/zen")) {
      url = url.replace("opencode.ai/zen", "opencode.ai/inference");
    }
    try {
      const headers = new Headers(init?.headers);
      for (const key of [...headers.keys()]) {
        if (key.toLowerCase().startsWith("x-stainless-")) headers.delete(key);
      }
      if (!headers.has("x-opencode-client")) headers.set("x-opencode-client", "cli");
      if (!headers.has("x-opencode-project")) headers.set("x-opencode-project", "c0b92d396d341f0eaed3c4fb6e6742620934e44e");
      let body = init?.body;
      let parsed: unknown;
      if (typeof body === "string" && body.length > 0) {
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = undefined;
        }
      }
      const api = detectApi(url, parsed);
      const record: MutableHeaders = {};
      headers.forEach((value, key) => {
        record[key] = value;
      });
      applyOpenCodeFreeHeaders(record, api);
      if (parsed !== undefined) {
        const shaped = applyOpenCodeFreePayload(parsed, api);
        if (shaped !== undefined) body = JSON.stringify(shaped);
      }
      const next = new Headers();
      for (const [k, v] of Object.entries(record)) {
        if (v !== null) next.set(k, v);
      }
      return base(input as RequestInfo | URL, { ...init, headers: next, body });
    } catch {
      return base(input as RequestInfo | URL, init);
    }
  }) as PatchedFetch;
  patched.__freePatched = true;
  globalThis.fetch = patched;
}

export default function (pi: ExtensionAPI): void {
  installFetchPatch();
  // One stable session for all requests (reuse across requests is safe;
  // OpenCode itself reuses headers on retry).
  const SESSION = canonicalSessionId();
  // Request path shaping: OMP engines bypass globalThis.fetch, so the fetch
  // patch above never sees provider traffic. This hook DOES run in the
  // request path — returning a value replaces the payload.
  pi.on("before_provider_request", (event) => {
    try {
      const payload = (event as { payload?: unknown }).payload;
      if (!isFreePayload(payload)) return;
      const api = detectApiFromPayload(payload);
      if (!api) return;
      const shaped = applyOpenCodeFreePayload(payload, api);
      if (shaped !== undefined && shaped !== payload) return shaped;
    } catch {
      // never break requests
    }
  });
  pi.registerProvider(PROVIDER_ID, {
    name: "OpenCode Direct (Free)",
    baseUrl: ZEN_BASE_URL,
    api: "openai-completions",
    apiKey: OPENCODE_PUBLIC_API_KEY,
    headers: {
      "x-opencode-client": "cli",
      "x-opencode-project": "c0b92d396d341f0eaed3c4fb6e6742620934e44e",
      "x-opencode-session": SESSION,
      "x-opencode-session-id": SESSION,
      "x-session-affinity": SESSION,
      "x-session-id": SESSION,
      "X-Session-Id": SESSION,
      "User-Agent": OPENCODE_USER_AGENT,
    },
    models: FALLBACK.map(toOmpModel),
    fetchDynamicModels: async () => {
      try {
        const discovered = await discoverModels({});
        if (discovered.length === 0) return FALLBACK.map(toOmpModel);
        return discovered.map((m) =>
          toOmpModel({ id: m.id, name: m.name, api: m.api, reasoning: m.reasoning, contextWindow: m.contextWindow, maxTokens: m.maxTokens }),
        );
      } catch {
        return FALLBACK.map(toOmpModel);
      }
    },
  });
}
