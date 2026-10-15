// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Shared OpenCode Zen request identity: headers, auth pinning, and
 * canonical session synthesis.
 *
 * Zen's free/public lane now validates three things together:
 * - the shared `public` upstream credential,
 * - an official OpenCode-like session id encoding,
 * - agent-shaped request bodies (handled in `./zen-payload.ts`).
 */
import { createHash, randomUUID } from "node:crypto";

/** Zen base URLs: Anthropic Messages lives at the bare gateway root. */
export const ZEN_BASE_URL = "https://opencode.ai/inference/v1";
export const ZEN_ANTHROPIC_BASE_URL = "https://opencode.ai/inference/v1";

/** Only base URLs we ever persist or restore; anything else is dropped. */
const TRUSTED_BASE_URLS = new Set([ZEN_BASE_URL, ZEN_ANTHROPIC_BASE_URL]);

/** Official OpenCode client identity expected by Zen's public lane. */
export const OPENCODE_USER_AGENT = "opencode/latest/2.0.28/cli";
export const OPENCODE_PUBLIC_API_KEY = "public";

/** Native Pi engines this extension routes models to. */
export const KNOWN_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

/** Returns true for a base URL we persist; drops poisoned snapshots. */
export function isTrustedBaseUrl(value: unknown): value is string {
  return typeof value === "string" && TRUSTED_BASE_URLS.has(value);
}

/** Returns true for a native engine id; drops poisoned `api` values. */
export function isKnownApi(value: unknown): value is string {
  return typeof value === "string" && KNOWN_APIS.has(value);
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const DESCENDING_TIME_PART_PATTERN = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;

function cleanSignal(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function base62Fixed(bytes: Uint8Array, width: number): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  for (let i = 0; i < width; i++) {
    out = BASE62[Number(value % 62n)] + out;
    value /= 62n;
  }
  return out;
}

/**
 * Renders a hash prefix in OpenCode's descending-id time layout:
 * a 36-bit pseudo-timestamp shifted into the top of a 48-bit word, counter=1,
 * then bitwise-NOT-ed so the low 12 bits land in the accepted `fc0`-`fff`
 * window. This mirrors the reference gateway's public-lane fix.
 */
function descendingTimePart(hash: Uint8Array): string {
  const current =
    (((BigInt(hash[0] ?? 0) << 28n) |
      (BigInt(hash[1] ?? 0) << 20n) |
      (BigInt(hash[2] ?? 0) << 12n) |
      (BigInt(hash[3] ?? 0) << 4n) |
      (BigInt(hash[4] ?? 0) >> 4n))
      << 12n) |
    1n;
  const inverted = (~current) & 0xFFFFFFFFFFFFn;
  return inverted.toString(16).padStart(12, "0");
}

/**
 * Returns `signal` unchanged when it already matches the OpenCode descending
 * session format; otherwise deterministically re-encodes it into that layout.
 * Without this exact encoding Zen rejects public-lane requests with 403.
 */
export function canonicalSessionId(signal?: string): string {
  const cleaned = cleanSignal(signal) ?? `fallback:${randomUUID()}`;
  if (
    CANONICAL_SESSION_PATTERN.test(cleaned) &&
    DESCENDING_TIME_PART_PATTERN.test(cleaned.slice(4, 16))
  ) {
    return cleaned;
  }
  const sum = createHash("sha256").update(`ses\0${cleaned}`).digest();
  return `ses_${descendingTimePart(sum.subarray(0, 6))}${base62Fixed(sum.subarray(6, 16), 14)}`;
}

/** Same shape as pi-ai `ProviderHeaders`; kept local to avoid subpath imports. */
export type MutableHeaders = Record<string, string | null>;

export function getHeader(
  headers: MutableHeaders,
  name: string,
): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/** Deletes every case variant of a header (`Authorization` vs `authorization`). */
export function deleteHeader(headers: MutableHeaders, name: string): void {
  const expected = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === expected) delete headers[key];
  }
}

function setHeader(headers: MutableHeaders, name: string, value: string): void {
  deleteHeader(headers, name);
  headers[name] = value;
}

function sessionSignalFromHeaders(headers: MutableHeaders): string | undefined {
  return cleanSignal(
    getHeader(headers, "x-session-affinity") ??
      getHeader(headers, "x-session-id") ??
      getHeader(headers, "x-client-request-id") ??
      getHeader(headers, "session_id") ??
      getHeader(headers, "x-opencode-session"),
  );
}

/**
 * Zen request transform for our provider's traffic.
 *
 * Gated on the provider's own `x-opencode-client` + `x-opencode-project`
 * markers so foreign traffic stays untouched.
 *
 * - Pins auth to OpenCode's shared `public` credential.
 * - Re-encodes any upstream session signal into the accepted descending form.
 * - Stamps the official OpenCode UA + request/session headers.
 */
export function applyOpenCodeFreeHeaders(
  headers: MutableHeaders,
  api?: string,
): void {
  if (getHeader(headers, "x-opencode-client") !== "cli") return;
  if (!getHeader(headers, "x-opencode-project")) return;

  const session = canonicalSessionId(sessionSignalFromHeaders(headers));
  const currentProject = getHeader(headers, "x-opencode-project") ?? "global";
  const project = /^[0-9a-f]{40}$/i.test(currentProject)
    ? currentProject.toLowerCase()
    : createHash("sha256").update(`opencode-project\0${currentProject}`).digest("hex").slice(0, 40);

  setHeader(headers, "x-opencode-client", "cli");
  setHeader(headers, "x-opencode-project", project);
  setHeader(headers, "x-opencode-session", session);
  setHeader(headers, "x-opencode-session-id", session);
  setHeader(headers, "x-session-affinity", session);
  setHeader(headers, "X-Session-Id", session);
  setHeader(headers, "x-session-id", session);
  deleteHeader(headers, "x-client-request-id");
  deleteHeader(headers, "x-opencode-request");
  deleteHeader(headers, "user-agent");
  headers["User-Agent"] = OPENCODE_USER_AGENT;

  if (api === "anthropic-messages") {
    deleteHeader(headers, "authorization");
    headers["Authorization"] = null;
    setHeader(headers, "x-api-key", OPENCODE_PUBLIC_API_KEY);
    if (getHeader(headers, "x-goog-api-key") !== undefined) {
      deleteHeader(headers, "x-goog-api-key");
      headers["x-goog-api-key"] = null;
    }
    return;
  }

  setHeader(headers, "Authorization", `Bearer ${OPENCODE_PUBLIC_API_KEY}`);

  if (getHeader(headers, "x-api-key") !== undefined) {
    deleteHeader(headers, "x-api-key");
    headers["x-api-key"] = null;
  }

  if (api === "google-generative-ai") {
    setHeader(headers, "x-goog-api-key", OPENCODE_PUBLIC_API_KEY);
  } else if (getHeader(headers, "x-goog-api-key") !== undefined) {
    deleteHeader(headers, "x-goog-api-key");
    headers["x-goog-api-key"] = null;
  }
}
