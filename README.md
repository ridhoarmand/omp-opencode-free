# Pi-opencode-free

Free OpenCode models in [Pi](https://github.com/earendil-works/pi), with no personal API key.

## Why

The Pi CLI already ships an `opencode` provider, but through it the models only run on paid plans. This extension hits the same endpoint for the models advertised as free and shapes requests for OpenCode's public lane.

> No personal key, no account, no paid plan. Zen's free lane is **not**
> truly anonymous though: it currently accepts requests only when they carry
> the shared upstream credential `public`, official OpenCode identity
> headers/session format, and agent-shaped streaming payloads with the core
> coding tools. This extension applies all of that automatically, so Pi
> users do not need to provide their own secret.

Everything else is Pi's native engines with per-model dispatch, exactly like the stock `opencode` provider: streaming, reasoning, tools. There are two interception points for headers — a `before_provider_headers` hook and one stamping engine adapter per Zen backend (`src/zen-headers.ts`, `src/zen-engines.ts`) — plus request-body shaping in `src/zen-payload.ts`. Models point at `zen-openai-completions`, `zen-openai-responses`, `zen-anthropic-messages`, and `zen-google-generative-ai`, so the same public-lane fixups travel with the provider config even where no ambient hook runs: foreground (`async:false`) subagent children. Each request gets the OpenCode identity headers stamped on it, auth pinned to the shared `public` credential (`Authorization: Bearer public` or `x-api-key: public` for Anthropic), and any Pi-stored user credential overwritten before it can leak on the wire. Because subagent children also launch with ambient extensions disabled, the entry file additionally registers itself as a host-required child extension for the session (`src/required-child.ts`, best-effort, no-op without `pi-subagents`). Two base URLs are used: `https://opencode.ai/zen/v1` for OpenAI-compatible and Google engines, and the bare root `https://opencode.ai/zen` for the Anthropic-messages backend (same split as stock).

## Install

```bash
pi install npm:pi-opencode-free
```


## Usage

Pick any `(Free)` model in Pi's model selector. The free-model catalog is
managed natively by Pi: it loads instantly from a persisted snapshot and
refreshes itself in the background on interactive startup or when opening
the model selector.

## Issues & contributions

Found a problem? Open an [issue](../../issues/new). Contributions are welcome.

## Development

Uses [Bun](https://bun.sh)

```bash
bun install
bun test src/            # unit tests
bun scripts/smoke-real.ts  # live request against Zen
```

| File | Purpose |
|------|---------|
| `src/index.ts` | Native provider registration, per-model config, snapshot persistence |
| `src/discovery.ts` | Free-model discovery (Zen + models.dev enrichment) |
| `src/zen-engines.ts` | Per-backend `zen-*` engine adapters (stamp, shape, then delegate) |
| `src/zen-headers.ts` | Shared OpenCode client identity: headers, session/request ids, public auth |
| `src/zen-payload.ts` | Public-lane payload shaping for OpenAI / Responses / Anthropic / Google |
| `src/required-child.ts` | Self-registration for subagent children (optional `pi-subagents`) |
| `scripts/smoke-real.ts` | Live end-to-end checks against the Zen API |

## License

[GPL-3.0-or-later](./LICENSE) — © 2026 pi-opencode-free contributors
