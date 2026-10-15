// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import opencodeDirectExtension, {
  COMPLETIONS_COMPAT,
  RESPONSES_COMPAT,
} from "./index.js";
import {
  canonicalSessionId,
  CANONICAL_SESSION_PATTERN,
  DESCENDING_TIME_PART_PATTERN,
  applyOpenCodeFreeHeaders,
  OPENCODE_PUBLIC_API_KEY,
} from "./zen-headers.js";

// Zen request invariants, asserted against the extension's REAL code
// (compat constants + toProviderModel output), not local mirrors.
// Context: pi-cache-optimizer compatibility — Zen payloads must keep
// max_tokens (never renamed to max_completion_tokens), keep
// reasoning_content on assistant messages, and keep tool_calls intact.
// Those payload shapes are produced by Pi's native engines from our
// per-model api + compat fields, so pinning compat here pins the payload.

async function getConfig() {
  let registeredConfig: any = null;
  const fakePi = {
    on() {},
    registerProvider(_id: string, config: any) {
      registeredConfig = config;
    },
  } as unknown as ExtensionAPI;
  await opencodeDirectExtension(fakePi);
  return registeredConfig;
}

async function getHook() {
  let hook: any = null;
  const fakePi = {
    on(event: string, handler: any) {
      if (event === "before_provider_headers") hook = handler;
    },
    registerProvider() {},
  } as unknown as ExtensionAPI;
  await opencodeDirectExtension(fakePi);
  return hook;
}

test("compat constants keep max_tokens and never rename it", async () => {
  assert.equal(COMPLETIONS_COMPAT.maxTokensField, "max_tokens");
  assert.equal("max_completion_tokens" in COMPLETIONS_COMPAT, false);
  assert.equal(RESPONSES_COMPAT.sessionAffinityFormat, "openai-nosession");
});

test("public-lane free access applies via header hook and zen engines", async () => {
  const cfg = await getConfig();
  // No provider-level streamSimple: one wrapper could never cover all four
  // backends (Pi's composer routes solely default-engine models through
  // it), so every model points at its stamping `zen-*` engine adapter.
  assert.equal(cfg.streamSimple, undefined);
  assert.equal(cfg.api, "zen-openai-completions");
  const hook = await getHook();
  assert.equal(typeof hook, "function");
  const headers: Record<string, string | null> = {
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    Authorization: "Bearer none",
  };
  hook({ headers });
  assert.equal(headers.Authorization, "Bearer public");
  assert.equal(headers["x-opencode-client"], "cli");
  assert.match(
    (headers as any)["x-opencode-session"],
    /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
  );
});

test("models carry zen per-model api with stock-style compat and baseUrl routing", async () => {
  const cfg = await getConfig();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("models.dev"))
      return {
        ok: true,
        json: async () => ({
          opencode: {
            models: {
              "muse-spark-1.2-contributor-free": {
                provider: { npm: "@ai-sdk/openai" },
              },
              "minimax-m3-free": { provider: { npm: "@ai-sdk/anthropic" } },
              "gemini-free": { provider: { npm: "@ai-sdk/google" } },
            },
          },
        }),
      };
    return {
      ok: true,
      json: async () => ({
        data: [
          { id: "hy3-free" },
          { id: "muse-spark-1.2-contributor-free" },
          { id: "minimax-m3-free" },
          { id: "gemini-free" },
        ],
      }),
    };
  }) as unknown as typeof fetch;
  try {
    const refreshed = await cfg.refreshModels({
      allowNetwork: true,
      signal: new AbortController().signal,
      stored: undefined,
      publish: async () => true,
    });
    const byId = (id: string) => refreshed.find((m: any) => m.id === id);
    const hy3 = byId("hy3-free");
    const muse = byId("muse-spark-1.2-contributor-free");
    const minimax = byId("minimax-m3-free");
    const gemini = byId("gemini-free");
    // Engine routing mirrors stock opencode.json, via the stamping zen-* adapters.
    assert.equal(hy3?.api, "zen-openai-completions");
    assert.equal(muse?.api, "zen-openai-responses");
    assert.equal(minimax?.api, "zen-anthropic-messages");
    assert.equal(gemini?.api, "zen-google-generative-ai");
    // Compat: completions-only flags stay on the completions engine.
    assert.deepEqual(hy3?.compat, COMPLETIONS_COMPAT);
    assert.equal(hy3?.compat.maxTokensField, "max_tokens");
    assert.deepEqual(muse?.compat, RESPONSES_COMPAT);
    assert.equal(minimax?.compat, undefined); // stock defines none
    assert.equal(gemini?.compat, undefined); // stock defines none
    // Base URLs: default /v1 inherited, Anthropic bare root override.
    assert.equal(hy3?.baseUrl, undefined);
    assert.equal(muse?.baseUrl, undefined);
    assert.equal(minimax?.baseUrl, "https://opencode.ai/inference/v1");
    assert.equal(gemini?.baseUrl, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("canonicalSessionId returns already-canonical OpenCode descending session ID untouched", () => {
  const canonical = "ses_012345678fc00123456789ABCD";
  assert.equal(canonicalSessionId(canonical), canonical);
  const derived = canonicalSessionId("existing-session-seed");
  assert.equal(canonicalSessionId(derived), derived);
});

test("canonicalSessionId deterministically maps arbitrary signal to valid canonical session ID with descending time part", () => {
  const mapped = canonicalSessionId("test-session-id");
  assert.match(mapped, CANONICAL_SESSION_PATTERN);
  assert.match(mapped.slice(4, 16), DESCENDING_TIME_PART_PATTERN);
});

test("canonicalSessionId with no arguments returns a valid canonical session ID", () => {
  const session = canonicalSessionId();
  assert.match(session, CANONICAL_SESSION_PATTERN);
  assert.match(session.slice(4, 16), DESCENDING_TIME_PART_PATTERN);
});

test("canonicalSessionId is deterministic when called with the same custom signal", () => {
  const signal = "test-session-id";
  const first = canonicalSessionId(signal);
  const second = canonicalSessionId(signal);
  assert.equal(first, second);
});

test("applyOpenCodeFreeHeaders removes mixed-case x-opencode-client header", () => {
  const headers: Record<string, string | null> = {
    "X-OpenCode-Client": "cli",
    "x-opencode-project": "global",
  };
  applyOpenCodeFreeHeaders(headers);
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal("X-OpenCode-Client" in headers, false);
});

test("applyOpenCodeFreeHeaders sets x-goog-api-key for google-generative-ai and nulls/omits for others", () => {
  const googleHeaders: Record<string, string | null> = {
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
  };
  applyOpenCodeFreeHeaders(googleHeaders, "google-generative-ai");
  assert.equal(googleHeaders["x-goog-api-key"], OPENCODE_PUBLIC_API_KEY);

  const mixedGoogleHeaders: Record<string, string | null> = {
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "X-Goog-Api-Key": "legacy-key",
  };
  applyOpenCodeFreeHeaders(mixedGoogleHeaders, "google-generative-ai");
  assert.equal(mixedGoogleHeaders["x-goog-api-key"], OPENCODE_PUBLIC_API_KEY);
  assert.equal("X-Goog-Api-Key" in mixedGoogleHeaders, false);

  const openaiHeaders: Record<string, string | null> = {
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
  };
  applyOpenCodeFreeHeaders(openaiHeaders, "openai-completions");
  assert.equal("x-goog-api-key" in openaiHeaders, false);

  const openaiHeadersWithKey: Record<string, string | null> = {
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "X-Goog-Api-Key": "some-key",
  };
  applyOpenCodeFreeHeaders(openaiHeadersWithKey, "openai-completions");
  assert.equal(openaiHeadersWithKey["x-goog-api-key"], null);
  assert.equal("X-Goog-Api-Key" in openaiHeadersWithKey, false);
});
