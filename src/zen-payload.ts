// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Zen public-lane payload shaping.
 *
 * OpenCode's shared `public` credential accepts only agent-shaped requests for
 * free models: streaming enabled plus the five core coding tools present.
 * This module appends the minimal missing structure per native backend.
 */

const CORE_TOOL_NAMES = ["shell", "edit", "glob", "grep", "read"] as const;

type JsonPrimitive = string | number | boolean | null;
interface JsonObject {
  [key: string]: JsonValue | undefined;
}
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type ZenPayload = JsonValue | undefined;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const OPENCODE_GENUINE_TOOLS: Record<string, { description: string; parameters: JsonObject }> = {
  shell: {
    description: "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: { type: "string", description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." },
        timeout: { type: "integer", minimum: 0, description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default." },
        background: { type: "boolean", description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  edit: {
    description: "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to edit" },
        oldString: { type: "string", description: "Exact text to find and replace" },
        newString: { type: "string", description: "Text to replace oldString with (must differ from oldString)" },
        replaceAll: { type: "boolean", description: "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false." },
      },
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
    },
  },
  glob: {
    description: "Search file paths using a glob pattern (examples: \"**/*.ts\", \"src/**/*.tsx\").",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files against" },
        path: { type: "string", description: "Directory to search. Defaults to the current working directory." },
        hidden: { type: "boolean", description: "Include hidden files and directories (default: false)." },
        limit: { type: "integer", exclusiveMinimum: 0, description: "Maximum number of matching files to return (default: 100)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  grep: {
    description: "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1, description: "Regular expression or literal text to match in file contents." },
        path: { type: "string", description: "File or directory to search. Defaults to the current working directory." },
        include: { type: "string", description: "Glob pattern to filter files (for example, \"*.js\" or \"*.{ts,tsx}\")" },
        literal: { type: "boolean", description: "Treat `pattern` as exact text instead of a regular expression (default: false)." },
        caseSensitive: { type: "boolean", description: "Use case-sensitive matching (default: true)." },
        limit: { type: "integer", exclusiveMinimum: 0, description: "Maximum number of matching lines to return (default: 100)" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  read: {
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  write: {
    description: "Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write to" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
};

function baseToolParameters(): JsonObject {
  return { type: "object", properties: {} };
}

function openAIChatTool(name: string): JsonObject {
  const genuine = OPENCODE_GENUINE_TOOLS[name];
  return {
    type: "function",
    function: {
      name,
      description: genuine?.description ?? `Agent tool ${name}`,
      parameters: genuine?.parameters ?? baseToolParameters(),
    },
  };
}

function openAIResponsesTool(name: string): JsonObject {
  const genuine = OPENCODE_GENUINE_TOOLS[name];
  return {
    type: "function",
    name,
    description: genuine?.description ?? `Agent tool ${name}`,
    parameters: genuine?.parameters ?? baseToolParameters(),
  };
}

function anthropicTool(name: string): JsonObject {
  const genuine = OPENCODE_GENUINE_TOOLS[name];
  return {
    name,
    description: genuine?.description ?? `Agent tool ${name}`,
    input_schema: genuine?.parameters ?? baseToolParameters(),
  };
}

function googleFunctionDeclaration(name: string): JsonObject {
  const genuine = OPENCODE_GENUINE_TOOLS[name];
  return {
    name,
    description: genuine?.description ?? `Agent tool ${name}`,
    parametersJsonSchema: genuine?.parameters ?? baseToolParameters(),
  };
}

function ensureStream(payload: JsonObject): boolean {
  if (payload.stream === true) return false;
  payload.stream = true;
  return true;
}

function ensureChatStreamUsage(payload: JsonObject): boolean {
  const current = payload.stream_options;
  if (!isRecord(current)) {
    payload.stream_options = { include_usage: true };
    return true;
  }
  if (current.include_usage === true) return false;
  payload.stream_options = { ...current, include_usage: true };
  return true;
}

function ensureTools(
  payload: JsonObject,
  getName: (item: unknown) => string | undefined,
  build: (name: string) => JsonObject,
): boolean {
  const current = payload.tools;
  if (current === undefined) {
    payload.tools = CORE_TOOL_NAMES.map(build);
    return true;
  }
  if (!Array.isArray(current)) return false;
  let changed = false;
  const items = [...current];
  const present = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const name = getName(items[i]);
    if (!name) continue;
    present.add(name);
    if (name in OPENCODE_GENUINE_TOOLS) {
      items[i] = build(name);
      changed = true;
    }
  }
  const missing = CORE_TOOL_NAMES.filter((name) => !present.has(name));
  if (missing.length > 0) {
    items.push(...missing.map(build));
    changed = true;
  }
  if (!changed) return false;
  payload.tools = items;
  return true;
}

function openAIChatToolName(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  const fn = item.function;
  if (isRecord(fn) && typeof fn.name === "string") return fn.name;
  const custom = item.custom;
  if (isRecord(custom) && typeof custom.name === "string") return custom.name;
  if (typeof item.name === "string") return item.name;
  return undefined;
}

function namedTool(item: unknown): string | undefined {
  return isRecord(item) && typeof item.name === "string" ? item.name : undefined;
}

function googleDeclaredToolNames(groups: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(groups)) return names;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.functionDeclarations)) continue;
    for (const decl of group.functionDeclarations) {
      if (isRecord(decl) && typeof decl.name === "string") names.add(decl.name);
    }
  }
  return names;
}

function shapeOpenAICompletionsPayload(payload: JsonObject): JsonObject {
  ensureStream(payload);
  ensureChatStreamUsage(payload);
  ensureTools(payload, openAIChatToolName, openAIChatTool);
  return payload;
}

function shapeOpenAIResponsesPayload(payload: JsonObject): JsonObject {
  ensureStream(payload);
  ensureTools(payload, namedTool, openAIResponsesTool);
  return payload;
}

function shapeAnthropicPayload(payload: JsonObject): JsonObject {
  ensureStream(payload);
  ensureTools(payload, namedTool, anthropicTool);
  return payload;
}

function shapeGooglePayload(payload: JsonObject): JsonObject {
  const config = isRecord(payload.config) ? { ...payload.config } : {};
  const groups = Array.isArray(config.tools) ? [...config.tools] : [];
  const present = new Set<string>();
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.functionDeclarations)) continue;
    for (let i = 0; i < group.functionDeclarations.length; i++) {
      const decl = group.functionDeclarations[i];
      if (isRecord(decl) && typeof decl.name === "string") {
        present.add(decl.name);
        if (decl.name in OPENCODE_GENUINE_TOOLS) {
          group.functionDeclarations[i] = googleFunctionDeclaration(decl.name);
        }
      }
    }
  }
  const missing = CORE_TOOL_NAMES.filter((name) => !present.has(name));
  if (missing.length > 0) {
    const missingDecls = missing.map(googleFunctionDeclaration);
    const existingGroupIndex = groups.findIndex(
      (group) => isRecord(group) && Array.isArray(group.functionDeclarations),
    );
    if (existingGroupIndex >= 0) {
      const existingGroup = groups[existingGroupIndex] as JsonObject;
      const existingDecls = Array.isArray(existingGroup.functionDeclarations)
        ? existingGroup.functionDeclarations
        : [];
      groups[existingGroupIndex] = {
        ...existingGroup,
        functionDeclarations: [...existingDecls, ...missingDecls],
      };
    } else {
      groups.push({ functionDeclarations: missingDecls });
    }
  }
  payload.config = { ...config, tools: groups };
  return payload;
}

/**
 * Returns a shaped payload copy for Zen's public lane. Unknown payload shapes
 * are passed through unchanged so paid/private behavior is never widened by
 * accident.
 */
export function applyOpenCodeFreePayload(
  payload: unknown,
  api: string,
): ZenPayload {
  if (!isRecord(payload)) return payload as ZenPayload;
  const shaped: JsonObject = { ...payload };
  const normalizedApi = api.replace(/^zen-/, "");
  switch (normalizedApi) {
    case "openai-completions":
      return shapeOpenAICompletionsPayload(shaped);
    case "openai-responses":
      return shapeOpenAIResponsesPayload(shaped);
    case "anthropic-messages":
      return shapeAnthropicPayload(shaped);
    case "google-generative-ai":
      return shapeGooglePayload(shaped);
    default:
      return payload as ZenPayload;
  }
}
