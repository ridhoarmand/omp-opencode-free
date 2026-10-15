// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { filterFreeModels } from "./discovery.js";
import { toOmpModel } from "../omp-entry.js";

test("toOmpModel keeps discovered limits instead of hardcoded 128K", () => {
  const m = toOmpModel({
    id: "opencode/longcat-2.5-preview-free",
    name: "Longcat 2.5 Preview",
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    reasoning: true,
  });
  assert.equal(m.id, "longcat-2.5-preview-free"); // opencode/ prefix stripped
  assert.equal(m.contextWindow, 1_000_000);
  assert.equal(m.maxTokens, 131_072);
});
test("a new upstream free model flows through with no code change", () => {
  // The live list comes from Zen; FALLBACK is offline bootstrap only. A
  // never-before-seen *-free id must survive the whole mapping chain.
  const [found] = filterFreeModels([{ id: "hypothetical-new-free" }], {
    catalog: {
      "hypothetical-new-free": {
        name: "Hypothetical New",
        reasoning: true,
        limit: { context: 500_000, output: 50_000 },
      },
    },
  });
  assert.ok(found);
  const m = toOmpModel({
    id: found.id,
    name: found.name,
    api: found.api,
    reasoning: found.reasoning,
    contextWindow: found.contextWindow,
    maxTokens: found.maxTokens,
  });
  assert.equal(m.id, "hypothetical-new-free");
  assert.equal(m.contextWindow, 500_000);
  assert.equal(m.maxTokens, 50_000);
});
test("toOmpModel falls back to conservative limits when unknown", () => {
  const m = toOmpModel({ id: "jev-1.13-free" });
  assert.equal(m.contextWindow, 128_000);
  assert.equal(m.maxTokens, 16_384);
});
