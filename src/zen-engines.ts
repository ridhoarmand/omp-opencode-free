// SPDX-License-Identifier: GPL-3.0-or-later
import type {
  Api,
  Context,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
  StreamOptions,
} from "@earendil-works/pi-ai";
import {
  getApiProvider,
  registerApiProvider,
  type ApiProvider,
  type ApiStreamFunction,
  type ApiStreamSimpleFunction,
} from "@earendil-works/pi-ai/compat";
import { applyOpenCodeFreePayload } from "./zen-payload.js";
import {
  applyOpenCodeFreeHeaders,
  getHeader,
  OPENCODE_PUBLIC_API_KEY,
} from "./zen-headers.js";

/**
 * Zen engine adapters.
 *
 * Pi's provider composer routes a provider-level `streamSimple` solely to
 * models whose engine matches the provider-level `api`
 * (`model.api === extension.api`), and a provider declares exactly one
 * `api`. One wrapper therefore can never cover all four Zen backends
 * (completions, responses, Anthropic, Google).
 *
 * Instead this module registers one custom engine adapter per Zen backend
 * (`zen-*`, each shaping the request for Zen's shared `public` lane, then
 * delegating to Pi's native engine). Models point at the `zen-*` ids, so
 * every request — parent, background runner, foreground child — travels
 * through the same header + payload fixups.
 */

/** Native Pi engines behind the Zen gateway (exactly the stock `opencode` routing). */
export type NativeZenApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

/** Custom engine ids: same dispatch as native, plus the Zen identity stamp. */
export type ZenApi = `zen-${NativeZenApi}`;

export const ZEN_COMPLETIONS_API: ZenApi = "zen-openai-completions";
export const ZEN_RESPONSES_API: ZenApi = "zen-openai-responses";
export const ZEN_ANTHROPIC_API: ZenApi = "zen-anthropic-messages";
export const ZEN_GOOGLE_API: ZenApi = "zen-google-generative-ai";

const NATIVE_TO_ZEN: Record<NativeZenApi, ZenApi> = {
  "openai-completions": ZEN_COMPLETIONS_API,
  "openai-responses": ZEN_RESPONSES_API,
  "anthropic-messages": ZEN_ANTHROPIC_API,
  "google-generative-ai": ZEN_GOOGLE_API,
};

const ZEN_TO_NATIVE: Record<ZenApi, NativeZenApi> = {
  [ZEN_COMPLETIONS_API]: "openai-completions",
  [ZEN_RESPONSES_API]: "openai-responses",
  [ZEN_ANTHROPIC_API]: "anthropic-messages",
  [ZEN_GOOGLE_API]: "google-generative-ai",
};

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function isNativeZenApi(api: unknown): api is NativeZenApi {
  return typeof api === "string" && hasOwn(NATIVE_TO_ZEN, api);
}

export function isZenApi(api: unknown): api is ZenApi {
  return typeof api === "string" && hasOwn(ZEN_TO_NATIVE, api);
}

/** Maps a native engine to its stamping Zen adapter; undefined for unknown values. */
export function zenApiForNative(api: string): ZenApi | undefined {
  if (!isNativeZenApi(api)) return undefined;
  return NATIVE_TO_ZEN[api];
}

/** Maps a Zen adapter id back to its native engine; undefined for anything else. */
export function nativeApiForZen(api: unknown): NativeZenApi | undefined {
  if (!isZenApi(api)) return undefined;
  return ZEN_TO_NATIVE[api];
}

export type HeaderTransform = (
  headers: ProviderHeaders,
) => ProviderHeaders | Promise<ProviderHeaders>;

type PayloadTransform = (
  payload: unknown,
  model: Model<Api>,
) => unknown | undefined | Promise<unknown | undefined>;

type ZenTransformOptions = {
  headers?: ProviderHeaders;
  transformHeaders?: HeaderTransform;
  onPayload?: PayloadTransform;
  sessionId?: string;
  apiKey?: string;
};

/**
 * Composes Pi core's per-request `transformHeaders` (attribution + hooks
 * wherever they run) with the Zen public-lane stamp.
 */
export function composeZenTransformHeaders(
  parent?: HeaderTransform | undefined,
  nativeApi?: NativeZenApi,
): HeaderTransform {
  return async (headers: ProviderHeaders) => {
    const base = parent ? await parent(headers) : headers;
    const stamped: ProviderHeaders = { ...(base ?? {}) };
    stamped["x-opencode-client"] = "cli";
    if (!getHeader(stamped, "x-opencode-project")) {
      stamped["x-opencode-project"] = "global";
    }
    applyOpenCodeFreeHeaders(stamped, nativeApi);
    return stamped;
  };
}

function composeZenOnPayload(
  parent: PayloadTransform | undefined,
  nativeApi: NativeZenApi,
): PayloadTransform {
  return async (payload: unknown, model: Model<Api>) => {
    const base = parent ? await parent(payload, model) : payload;
    return applyOpenCodeFreePayload(
      base === undefined ? payload : base,
      nativeApi,
    );
  };
}

/**
 * Compat/native api adapters do not eagerly apply `transformHeaders` or own
 * the provider-level stamp, so we shape the request up front as well as pass
 * the composed transforms through for host paths that consume them.
 */
function withZenHeaders<O>(options: O, nativeApi: NativeZenApi): O {
  const current = options as ZenTransformOptions | undefined;
  const headers: ProviderHeaders = { ...(current?.headers ?? {}) };
  headers["x-opencode-client"] = "cli";
  if (!getHeader(headers, "x-opencode-project")) {
    headers["x-opencode-project"] = "global";
  }
  if (typeof current?.sessionId === "string" && current.sessionId.trim()) {
    if (!getHeader(headers, "x-session-affinity")) {
      headers["x-session-affinity"] = current.sessionId;
    }
    if (!getHeader(headers, "x-client-request-id")) {
      headers["x-client-request-id"] = current.sessionId;
    }
    if (!getHeader(headers, "x-session-id")) {
      headers["X-Session-Id"] = current.sessionId;
    }
  }
  applyOpenCodeFreeHeaders(headers, nativeApi);
  return {
    ...((options ?? {}) as Record<string, unknown>),
    apiKey: OPENCODE_PUBLIC_API_KEY,
    headers,
    transformHeaders: composeZenTransformHeaders(
      current?.transformHeaders,
      nativeApi,
    ),
    onPayload: composeZenOnPayload(current?.onPayload, nativeApi),
  } as O;
}

export type EngineResolver = (
  api: Api,
) => Pick<
  NonNullable<ReturnType<typeof getApiProvider>>,
  "stream" | "streamSimple"
> | undefined;

/**
 * Builds the `{ stream, streamSimple }` pair for one Zen backend: shape the
 * request for Zen's public lane, then delegate straight to the native engine
 * adapter — never to compat's top-level `stream`/`streamSimple` (that would
 * resolve the `zen-*` id back to this same wrapper and recurse).
 *
 * Pi-ai's `registerApiProvider` wraps every native engine with a strict
 * `model.api === api` guard (`Mismatched api: ... expected ...`). Models
 * reaching this adapter carry the `zen-*` id, so the model must be re-keyed
 * to `nativeApi` before delegating — otherwise every non-default backend
 * fails with e.g. `Mismatched api: zen-openai-responses expected
 * openai-responses`.
 *
 * `resolveEngine` is injectable for tests; production always uses the real
 * engine registry.
 */
export function createZenEngineFunctions(
  nativeApi: NativeZenApi,
  resolveEngine: EngineResolver = (api) => getApiProvider(api),
): Pick<ApiProvider, "stream" | "streamSimple"> {
  const resolve = () => {
    const engine = resolveEngine(nativeApi);
    if (!engine) {
      throw new Error(`No API provider registered for api: ${nativeApi}`);
    }
    return engine;
  };
  // Re-key to the native engine id; all other model fields (provider,
  // baseUrl, compat, ...) travel unchanged so Zen routing is preserved.
  const toNativeModel = (model: Model<Api>): Model<Api> => ({
    ...model,
    api: nativeApi,
  });
  const stream: ApiStreamFunction = (
    model: Model<Api>,
    context: Context,
    options?: StreamOptions,
  ) =>
    resolve().stream(
      toNativeModel(model),
      context,
      withZenHeaders(options, nativeApi),
    );
  const streamSimple: ApiStreamSimpleFunction = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) =>
    resolve().streamSimple(
      toNativeModel(model),
      context,
      withZenHeaders(options, nativeApi),
    );
  return { stream, streamSimple };
}

const ZEN_SOURCE_ID = "pi-opencode-free";

/**
 * Registers the four `zen-*` engine adapters. Idempotent: re-registering
 * overwrites with an equivalent wrapper. The `register` parameter is
 * injectable so tests can capture registrations without touching the
 * global engine registry.
 */
export function registerZenApiProviders(
  register: typeof registerApiProvider = registerApiProvider,
): ZenApi[] {
  const ids: ZenApi[] = [];
  for (const native of Object.keys(NATIVE_TO_ZEN) as NativeZenApi[]) {
    const zen = NATIVE_TO_ZEN[native];
    const registration: ApiProvider = {
      api: zen,
      ...createZenEngineFunctions(native),
    };
    register(registration, ZEN_SOURCE_ID);
    ids.push(zen);
  }
  return ids;
}
