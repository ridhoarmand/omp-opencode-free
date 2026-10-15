// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { applyOpenCodeFreePayload } from "./zen-payload.js";

function toolNames(tools: any[] | undefined, pick: (tool: any) => string | undefined) {
  return (tools ?? []).map(pick).filter((name): name is string => typeof name === "string");
}

test("openai completions payload gets stream, usage, and core tools", () => {
  const payload = {
    model: "hy3-free",
    stream: false,
    stream_options: { trace_id: "abc" },
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Weather lookup",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  };
  const shaped = applyOpenCodeFreePayload(payload, "openai-completions") as any;
  assert.equal(shaped.stream, true);
  assert.deepEqual(shaped.stream_options, {
    trace_id: "abc",
    include_usage: true,
  });
  assert.deepEqual(
    toolNames(shaped.tools, (tool) => tool?.function?.name),
    ["get_weather", "shell", "edit", "glob", "grep", "read"],
  );
});

test("openai responses payload preserves existing tools and appends missing core tools", () => {
  const payload = {
    model: "muse-spark-1.2-contributor-free",
    tools: [{ type: "function", name: "grep", parameters: { type: "object" } }],
  };
  const shaped = applyOpenCodeFreePayload(payload, "openai-responses") as any;
  assert.equal(shaped.stream, true);
  assert.deepEqual(
    toolNames(shaped.tools, (tool) => tool?.name),
    ["grep", "shell", "edit", "glob", "read"],
  );
});

test("anthropic payload uses anthropic tool schema with stream enabled", () => {
  const shaped = applyOpenCodeFreePayload(
    { model: "minimax-m3-free" },
    "anthropic-messages",
  ) as any;
  assert.equal(shaped.stream, true);
  assert.deepEqual(
    toolNames(shaped.tools, (tool) => tool?.name),
    ["shell", "edit", "glob", "grep", "read"],
  );
  assert.equal(shaped.tools[0].input_schema.type, "object");
});

test("google payload appends missing core tools into existing function declarations group", () => {
  const shaped = applyOpenCodeFreePayload(
    {
      model: "gemini-free",
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: "read",
                description: "Existing read tool",
                parametersJsonSchema: { type: "object", properties: {} },
              },
            ],
          },
        ],
      },
    },
    "google-generative-ai",
  ) as any;
  assert.equal(Array.isArray(shaped.config.tools), true);
  assert.equal(shaped.config.tools.length, 1);
  assert.deepEqual(
    shaped.config.tools[0].functionDeclarations.map((decl: any) => decl.name),
    ["read", "shell", "edit", "glob", "grep"],
  );
});

test("google payload creates a function declaration group when none exists", () => {
  const shaped = applyOpenCodeFreePayload(
    {
      model: "gemini-free",
    },
    "google-generative-ai",
  ) as any;
  assert.equal(Array.isArray(shaped.config.tools), true);
  assert.equal(shaped.config.tools.length, 1);
  assert.deepEqual(
    shaped.config.tools[0].functionDeclarations.map((decl: any) => decl.name),
    ["shell", "edit", "glob", "grep", "read"],
  );
});

test("applyOpenCodeFreePayload works with zen-openai-completions", () => {
  const payload = {
    model: "hy3-free",
  };
  const shaped = applyOpenCodeFreePayload(payload, "zen-openai-completions") as any;
  assert.equal(shaped.stream, true);
  assert.deepEqual(
    toolNames(shaped.tools, (tool) => tool?.function?.name),
    ["shell", "edit", "glob", "grep", "read"],
  );
});

test("openai completions detects tools with custom or top-level name and does not duplicate them", () => {
  const payload = {
    model: "hy3-free",
    tools: [
      {
        type: "custom",
        custom: {
          name: "shell",
        },
      },
      {
        type: "function",
        name: "read",
      },
    ],
  };
  const shaped = applyOpenCodeFreePayload(payload, "openai-completions") as any;
  assert.deepEqual(
    shaped.tools.map((tool: any) => tool?.function?.name ?? tool?.custom?.name ?? tool?.name),
    ["shell", "read", "edit", "glob", "grep"],
  );
});

test("tool descriptions use genuine OpenCode definitions", () => {
  const shaped = applyOpenCodeFreePayload(
    { model: "hy3-free" },
    "openai-completions",
  ) as any;
  assert.equal(
    shaped.tools[0].function.name,
    "shell",
  );
  assert.ok(
    shaped.tools[0].function.description.includes("Execute a shell command"),
  );
});

test("unknown api or non-object payload passes through unchanged", () => {
  const text = "plain-text-payload";
  assert.equal(applyOpenCodeFreePayload(text, "openai-completions"), text);
  const payload = { model: "x" };
  assert.equal(applyOpenCodeFreePayload(payload, "totally-made-up-engine"), payload);
});
