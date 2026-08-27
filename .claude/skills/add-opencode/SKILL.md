---
name: add-opencode
description: Use OpenCode as an agent provider. OpenRouter, OpenAI, Google, DeepSeek, etc. via OpenCode config — not the Anthropic Agent SDK. Per-group via `ncl groups config update --provider opencode`; host passes OPENCODE_* and XDG state when spawning containers.
metadata:
  nanoclaw-provider: opencode
  nanoclaw-provider-label: OpenCode
  nanoclaw-provider-hint: Open-source provider router
  nanoclaw-provider-offered: 'false'
  nanoclaw-provider-install-skill: add-opencode
  nanoclaw-provider-image: local-required
---

# OpenCode agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. Each group's backend is selected by `container_configs.provider` (default `claude`).

Trunk ships with only the `claude` provider baked in. This skill copies the OpenCode provider files in from the `providers` branch, wires them into the host and container barrels, installs dependencies, and rebuilds the image.

## Install

The payload, declarations, dependencies, and barrels are deterministic and idempotent.

```nc:copy from-branch:providers
src/providers/opencode.ts
src/providers/opencode-registration.test.ts
src/provider-contracts/opencode.ts
container/agent-runner/src/providers/opencode.ts
container/agent-runner/src/providers/mcp-to-opencode.ts
container/agent-runner/src/providers/mcp-to-opencode.test.ts
container/agent-runner/src/providers/opencode-registration.test.ts
container/agent-runner/src/providers/opencode.factory.test.ts
container/agent-runner/src/providers/opencode.attachments.test.ts
container/agent-runner/src/providers/opencode.compaction.test.ts
container/agent-runner/src/providers/opencode.config.test.ts
container/agent-runner/src/providers/opencode.empty-resume.test.ts
container/agent-runner/src/providers/opencode.memory.test.ts
container/agent-runner/src/providers/opencode.question.test.ts
container/agent-runner/src/provider-contracts/opencode.ts
setup/provider-contracts/opencode.ts
```

```nc:append to:src/providers/index.ts
import './opencode.js';
```

```nc:append to:src/provider-contracts/index.ts
import './opencode.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts
import './opencode.js';
```

```nc:append to:container/agent-runner/src/provider-contracts/index.ts
import './opencode.js';
```

```nc:append to:setup/provider-contracts/index.ts
import './opencode.js';
```

The SDK and CLI pins must match; 1.14.x has a different session API.

```nc:dep manager:bun cwd:container/agent-runner
@opencode-ai/sdk@1.4.17
```

```nc:json-merge into:container/cli-tools.json key:name
{ "name": "opencode-ai", "version": "1.4.17" }
```

```nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

```nc:run effect:test
pnpm exec tsx scripts/provider-contract-verifier.ts
```

## Configuration

### Host `.env` (typical)

Set model/provider strings in the form OpenCode expects (often `provider/model-id`). **Put comments on their own lines** — a `#` inside a value is kept verbatim and breaks model IDs.

These variables are read **on the host** and passed into the container only when the effective provider is `opencode`. They do not switch the provider by themselves.

- `OPENCODE_PROVIDER` — OpenCode provider id, e.g. `openrouter`, `anthropic`, `deepseek`.
- `OPENCODE_MODEL` — full model id in `provider/model` form, e.g. `deepseek/deepseek-chat`.
- `OPENCODE_SMALL_MODEL` — optional second model for lighter tasks; defaults to `OPENCODE_MODEL` if unset.
- `ANTHROPIC_BASE_URL` — **required for non-`anthropic` providers.** The opencode container provider passes this as the `baseURL` for the upstream provider config so requests route through OneCLI's credential proxy or directly to the provider's API. Set it to the provider's API base URL (e.g. `https://api.deepseek.com/v1`, `https://openrouter.ai/api/v1`).
- `OPENCODE_MODEL_CONTEXT_LIMIT` — optional context window, in tokens, declared for **`OPENCODE_MODEL` only** (not the small model); OpenCode auto-compacts as a session approaches it, and a model its registry does not know resolves to `0` and so never compacts. Anything but a positive integer is logged and treated as unset, which emits no limit and leaves behavior unchanged.
- `OPENCODE_MODEL_OUTPUT_LIMIT` — optional max output tokens for the same main model, only applied alongside a valid context limit (without one it is logged and ignored). Anything but a positive integer is logged and treated as unset.
- `OPENCODE_MODEL_INPUT_MODALITIES` — optional comma-separated subset of `text,audio,image,video,pdf`, declared for **`OPENCODE_MODEL` only**. OpenCode drops any file part whose modality the model does not declare, so images and PDFs never reach a registry-unknown custom model unless this is set. Unrecognized entries are logged and skipped; unset declares nothing and leaves behavior unchanged. A distinct `OPENCODE_SMALL_MODEL` never inherits this; it keeps the undeclared-model default regardless.

  Declaring the modality only opens OpenCode's gate for the file part to reach the model call. It does not by itself mean an attachment arrives as media today: the runner produces a file part from a channel attachment only once the attachment plumbing lands on `main` ([nanoclaw#3156](https://github.com/nanocoai/nanoclaw/issues/3156)). Until then, attachments are still described in the prompt text the formatter renders, same as every other provider.

Credentials: register provider API keys in OneCLI with the matching `--host-pattern` (e.g. `api.deepseek.com`, `openrouter.ai`). OneCLI injects them via `HTTPS_PROXY` in the container — the key never lives in `.env` or the container environment.

After adding a secret, **grant the agent access** — agents in `selective` mode only receive secrets they've been explicitly assigned:

```bash
# Find the agent id and secret id, then:
onecli agents set-secrets --id <agent-id> --secret-ids <existing-ids>,<new-secret-id>
```

Always include existing secret IDs in the list — `set-secrets` replaces, not appends.

#### Example: DeepSeek

```env
OPENCODE_PROVIDER=deepseek
OPENCODE_MODEL=deepseek/deepseek-chat
OPENCODE_SMALL_MODEL=deepseek/deepseek-chat
ANTHROPIC_BASE_URL=https://api.deepseek.com/v1
```

Register the key:
```bash
onecli secrets create --name "DeepSeek" --type generic \
  --value YOUR_KEY --host-pattern "api.deepseek.com" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

#### Example: OpenRouter

```env
OPENCODE_PROVIDER=openrouter
OPENCODE_MODEL=openrouter/anthropic/claude-sonnet-4
OPENCODE_SMALL_MODEL=openrouter/anthropic/claude-haiku-4.5
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
```

Register the key:
```bash
onecli secrets create --name "OpenRouter" --type generic \
  --value YOUR_KEY --host-pattern "openrouter.ai" \
  --header-name "Authorization" --value-format "Bearer {value}"
```

#### Example: Anthropic (no ANTHROPIC_BASE_URL needed)

When `OPENCODE_PROVIDER` is `anthropic`, OpenCode uses normal Anthropic env inside the container — the proxy + placeholder key pattern is unchanged and `ANTHROPIC_BASE_URL` is not required.

```env
OPENCODE_PROVIDER=anthropic
OPENCODE_MODEL=anthropic/claude-sonnet-4-20250514
OPENCODE_SMALL_MODEL=anthropic/claude-haiku-4-5-20251001
```

#### OpenCode Zen (`x-api-key`, not Bearer)

Zen's HTTP API (e.g. `POST …/zen/v1/messages`) expects the key in the **`x-api-key`** header. If OneCLI injects **`Authorization: Bearer …`** only, Zen often returns **401 / "Missing API key"** even though the gateway is working.

**Naming:** NanoClaw's group config `provider=opencode` means "run the **OpenCode agent provider**." Separately, **`OPENCODE_PROVIDER=opencode`** in `.env` is OpenCode's **Zen provider id** inside the OpenCode config (see [Zen docs](https://opencode.ai/docs/zen/)).

**Host `.env` (typical Zen shape):**

```env
OPENCODE_PROVIDER=opencode
OPENCODE_MODEL=opencode/big-pickle
OPENCODE_SMALL_MODEL=opencode/big-pickle
ANTHROPIC_BASE_URL=https://opencode.ai/zen/v1
```

Use a real Zen model id from the docs; `big-pickle` is one example.

**OneCLI:** register the Zen key with **`x-api-key`**, not Bearer:

```bash
onecli secrets create --name "OpenCode Zen" --type generic \
  --value YOUR_ZEN_KEY --host-pattern opencode.ai \
  --header-name "x-api-key" --value-format "{value}"
```

### Per group

```bash
ncl groups config update --id <group-id> --provider opencode
ncl groups restart --id <group-id>
```

The host materializes this DB-backed configuration for the container at spawn time.

Extra MCP servers still come from **`NANOCLAW_MCP_SERVERS`** / `container_config.mcpServers` on the host; the runner merges them into the same `mcpServers` object passed to **both** Claude and OpenCode providers.

## Operational notes

- OpenCode keeps a local **`opencode serve`** process and SSE subscription; the provider tears down with **`stream.return`** and **SIGKILL** on the server process on **`abort()`** / shared runtime reset to avoid MCP/zombie hangs.
- Session continuation uses UUID format (SDK 1.4.x / CLI 1.4.x). Stale sessions are cleared by `isSessionInvalid` on OpenCode-specific error patterns. If you see UUID-related errors after an accidental CLI upgrade, clear `session_state` in `outbound.db` and wipe the `opencode-xdg` directory under the session folder.
- **`NO_PROXY`** for localhost matters when the OpenCode client talks to `127.0.0.1` inside the container while HTTP(S)_PROXY is set (e.g. OneCLI).

## Verify

```bash
grep -q "./opencode.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./opencode.js" src/providers/index.ts && echo "host barrel: OK"
grep -q "@opencode-ai/sdk" container/agent-runner/package.json && echo "agent-runner dep: OK"
grep -q "opencode-ai@" container/Dockerfile && echo "Dockerfile install: OK"
cd container/agent-runner && bun test src/providers/ && cd -
```
