// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real-scenario smoke test against the live OpenCode Zen API, exercising the
 * extension's exact provider config via the registered `zen-*` engine
 * adapters (the same public-lane header/payload shaping path every backend
 * travels in production).
 * Run with: bun scripts/smoke-real.ts
 */
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  Tool,
} from "@earendil-works/pi-ai";
import { discoverModels } from "../src/discovery.js";
import {
  OPENCODE_USER_AGENT,
  ZEN_ANTHROPIC_BASE_URL,
  ZEN_BASE_URL,
  applyOpenCodeFreeHeaders,
} from "../src/zen-headers.js";
import {
  nativeApiForZen,
  registerZenApiProviders,
  zenApiForNative,
  ZEN_COMPLETIONS_API,
} from "../src/zen-engines.js";
// Imported, never mirrored: compat flags must match production exactly.
import { COMPLETIONS_COMPAT, RESPONSES_COMPAT } from "../src/index.js";

registerZenApiProviders();

const HEADERS = {
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  "User-Agent": OPENCODE_USER_AGENT,
};

/**
 * Mirrors src/index.ts: per-model api selects the registered `zen-*` engine
 * adapter (stamping + native dispatch). Headers are pre-stamped here the
 * way Pi core's streamFn + before_provider_headers hook would stamp them in
 * production; the adapter's composed transform then stamps them again on
 * dispatch. Kept in sync via the shared zen-headers module — do not
 * hand-roll header logic here.
 */
function shimStream(model: any, context: Context, options?: any) {
  const engine = getApiProvider(model.api);
  if (!engine) {
    throw new Error(`No API provider registered for api: ${model.api}`);
  }
  const headers: Record<string, string | null> = {
    ...options?.headers,
    ...HEADERS,
  };
  const nativeApi = nativeApiForZen(model.api) ?? "openai-completions";
  applyOpenCodeFreeHeaders(headers, nativeApi);
  return engine.streamSimple(model, context, { ...options, headers });
}

function toPiModel(m: Awaited<ReturnType<typeof discoverModels>>[number]): any {
  // Mirrors src/index.ts toProviderModel (model SHAPE only — the compat and
  // engine constants above/below are imported, not copied): zen-* engine
  // routing with stock-style compat/baseUrl (completions quirks apply only
  // to openai-completions; Anthropic/Google engines get no compat).
  const api = zenApiForNative(m.api ?? "openai-completions") ?? ZEN_COMPLETIONS_API;
  const native = nativeApiForZen(api) ?? "openai-completions";
  return {
    id: m.id.replace(/^opencode\//, ""),
    name: m.name,
    api,
    provider: "opencode-free",
    baseUrl:
      native === "anthropic-messages" ? ZEN_ANTHROPIC_BASE_URL : ZEN_BASE_URL,
    reasoning: m.reasoning ?? false,
    thinkingLevelMap: m.thinkingLevelMap,
    input: ["text"],
    contextWindow: m.contextWindow ?? 128_000,
    maxTokens: m.maxTokens ?? 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat:
      native === "openai-responses"
        ? RESPONSES_COMPAT
        : native === "openai-completions"
          ? COMPLETIONS_COMPAT
          : undefined,
    headers: HEADERS,
  };
}

async function run(model: Model<Api>, context: Context, opts?: any) {
  const events: AssistantMessageEvent[] = [];
  const stream = shimStream(model, context, { apiKey: "public", ...opts });
  let final: any = null;
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "done") final = ev.message;
    if (ev.type === "error") final = ev.error;
  }
  return { events, final };
}

function textOf(msg: any): string {
  return (msg?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
}

function nativeApiOf(m: Awaited<ReturnType<typeof discoverModels>>[number]): string {
  return nativeApiForZen(m.api) ?? m.api ?? "openai-completions";
}

function preferNativeApi(
  items: Awaited<ReturnType<typeof discoverModels>>,
  api: string,
) {
  return [
    ...items.filter((m) => nativeApiOf(m) === api),
    ...items.filter((m) => nativeApiOf(m) !== api),
  ];
}

function finalDetail(final: any): string {
  return final?.errorMessage ?? `stopReason=${final?.stopReason}`;
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

console.log("== 1. Live model discovery from OpenCode Zen ==");
const models = await discoverModels();
console.log(`   endpoint lists ${models.length} free models (all served): ${models.map(m => m.id).join(", ")}`);
check("discovery returns free models", models.length > 0);
check(
  "all discovered ids match the free regex",
  models.every(m => /(^(opencode\/)?.*-free$)|(^(opencode\/)?big-pickle$)/i.test(m.id)),
);

const plainChatCandidates = preferNativeApi(models, "openai-completions");
let plainChat:
  | {
      model: (typeof plainChatCandidates)[number];
      final: any;
    }
  | undefined;
const plainChatSkips: string[] = [];
for (const candidate of plainChatCandidates) {
  const { final } = await run(toPiModel(candidate), {
    systemPrompt: "You are terse.",
    messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }],
  }, { maxTokens: 200 });
  if (final?.stopReason === "stop" && /OK/i.test(textOf(final))) {
    plainChat = { model: candidate, final };
    break;
  }
  plainChatSkips.push(`${candidate.id}: ${finalDetail(final)}`);
}
console.log(`\n== 2. Plain chat via zen engine (${plainChat?.model.id ?? plainChatCandidates[0]?.id ?? "none"}) ==`);
if (plainChatSkips.length > 0) {
  console.log(`   skipped unhealthy candidates: ${plainChatSkips.slice(0, 3).join("; ")}`);
}
check(
  "chat completion succeeds",
  !!plainChat,
  plainChat
    ? `model=${plainChat.model.id} text="${textOf(plainChat.final).trim().slice(0, 60)}"`
    : plainChatSkips[0],
);
check(
  "usage reported",
  (plainChat?.final?.usage?.output ?? 0) > 0,
  JSON.stringify(plainChat?.final?.usage),
);

// Prefer reasoning models confirmed alive on the free tier: deepseek is still
// listed but its free promotion ended server-side and returns 401.
const reasoner =
  models.find(m => m.reasoning && m.id.includes("hy3")) ??
  models.find(m => m.reasoning && m.thinkingLevelMap?.low);
if (reasoner) {
  console.log(`\n== 3. Reasoning stream via zen engine (${reasoner.id}, level=low) ==`);
  const { final } = await run(toPiModel(reasoner), {
    systemPrompt: "You are terse.",
    messages: [{ role: "user", content: "What is 17*23? Think briefly, then answer.", timestamp: Date.now() }],
  }, { maxTokens: 2000, reasoning: "low" });
  const hasThinking = (final?.content ?? []).some((b: any) => b.type === "thinking");
  const hasText = textOf(final).length > 0;
  check("reasoning completion succeeds", final?.stopReason === "stop", `stopReason=${final?.stopReason}`);
  check("thinking block present", hasThinking);
  check("answer text present", hasText, `"${textOf(final).trim().slice(0, 60)}"`);
} else {
  console.log("\n== 3. Skipped: no reasoning model with low effort in discovery ==");
}

const weather: Tool = {
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
};
const toolCandidates = preferNativeApi(models, "openai-completions");
let toolRun:
  | {
      model: (typeof toolCandidates)[number];
      final: any;
      call: any;
    }
  | undefined;
const toolSkips: string[] = [];
for (const candidate of toolCandidates) {
  const { final } = await run(toPiModel(candidate), {
    systemPrompt: "You must use the get_weather tool to answer weather questions.",
    messages: [{ role: "user", content: "What's the weather in Lisbon?", timestamp: Date.now() }],
    tools: [weather],
  }, { maxTokens: 500 });
  const call = (final?.content ?? []).find((b: any) => b.type === "toolCall");
  if (call && final?.stopReason === "toolUse") {
    toolRun = { model: candidate, final, call };
    break;
  }
  toolSkips.push(`${candidate.id}: ${call ? `unexpected stopReason=${final?.stopReason}` : finalDetail(final)}`);
}
console.log(`\n== 4. Native tool calling (${toolRun?.model.id ?? toolCandidates[0]?.id ?? "none"}) ==`);
if (toolSkips.length > 0) {
  console.log(`   skipped unhealthy candidates: ${toolSkips.slice(0, 3).join("; ")}`);
}
check(
  "tool call emitted",
  !!toolRun,
  toolRun
    ? `${toolRun.call.name}(${JSON.stringify(toolRun.call.arguments)})`
    : toolSkips[0],
);
check(
  "stopReason is toolUse",
  toolRun?.final?.stopReason === "toolUse",
  toolRun ? `got ${toolRun.final.stopReason}` : toolSkips[0],
);

if (toolRun) {
  // Multi-turn: replay assistant toolCall + tool result, expect final answer.
  console.log("   -- follow-up turn with tool result --");
  const { final: final2 } = await run(toPiModel(toolRun.model), {
    systemPrompt: "You are terse.",
    messages: [
      { role: "user", content: "What's the weather in Lisbon?", timestamp: Date.now() },
      toolRun.final,
      {
        role: "toolResult",
        toolCallId: toolRun.call.id,
        toolName: toolRun.call.name,
        content: [{ type: "text", text: "18°C, light rain" }],
        isError: false,
        timestamp: Date.now(),
      },
    ],
    tools: [weather],
  }, { maxTokens: 300 });
  check("post-tool answer succeeds", final2?.stopReason === "stop" && /rain|18/i.test(textOf(final2)), `stopReason=${final2?.stopReason} text="${textOf(final2).trim().slice(0, 60)}"`);
}

// Models routed via @ai-sdk/openai (e.g. muse-spark) only answer on Zen's
// Responses endpoint — exercises the zen openai-responses engine adapter.
const responsesModel = models.find(m => m.api === "openai-responses");
if (responsesModel) {
  console.log(`\n== 5. Responses-API model via zen engine (${responsesModel.id}) ==`);
  const { final } = await run(toPiModel(responsesModel), {
    systemPrompt: "You are terse.",
    messages: [{ role: "user", content: "Reply with exactly: RESPONSES_OK", timestamp: Date.now() }],
  }, { maxTokens: 200 });
  check("responses completion succeeds", final?.stopReason === "stop", `stopReason=${final?.stopReason}`);
  check("responses answer present", /RESPONSES_OK/i.test(textOf(final)), `"${textOf(final).trim().slice(0, 60)}"`);
} else {
  console.log("\n== 5. Skipped: no @ai-sdk/openai-routed model in discovery ==");
}

console.log(`\n${failures === 0 ? "ALL REAL-SCENARIO CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
