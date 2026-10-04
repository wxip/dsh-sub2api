# dsh-sub2api

[中文文档](./README.zh.md)

Connect your [sub2api](https://github.com/Wei-Shaw/sub2api) gateway to [DeepSeek Harness](https://github.com/deepseek-ai/dsh) as model providers.

Sub2API is an AI API gateway that turns subscription quota into OpenAI-compatible endpoints. In its model, **each API key is bound to a group, and the group decides the platform** (OpenAI / Claude / Grok) and the models that key can serve. The three provider routes (`sub2api-openai`, `sub2api-claude`, `sub2api-grok`) are served by the harness's own pi-ai adapter (`dsh-llm-pi-ai`): this plugin translates its `llm-sub2api:` settings into `llm-pi-ai:` provider profiles (all sharing one **bare-host** base URL, no `/v1`), and protocol serialization, streaming, and usage accounting all live in pi-ai. The same gateway serves OpenAI, Claude, and Grok models side by side, and the harness routes each request to the key whose group owns the requested model.

## Features

- **Image generation**: select a generation model in settings. `generate_image` saves images to the workspace and returns an inline attachment. The separate image-analysis tool and its model selector have been removed.

- **One base URL, three provider routes**: `sub2api-openai`, `sub2api-claude`, `sub2api-grok` — each configured with its own key and at least one model, registered as a live LLM provider as soon as both are set.
- **Streaming chat (backed by pi-ai)**: SSE streaming, tool calls, reasoning deltas, and token usage are mapped to the harness protocol by `dsh-llm-pi-ai`, which natively handles wire-format details like top-level `function_call` items in the Responses API.
- **Model discovery**: one-click "fetch models" calls `GET {baseURL}/v1/models` with the key, so each route's catalog matches exactly what the sub2api group serves.
- **Reasoning effort (thinking mode)**: `reasoning_effort` is passed straight through to the gateway and adjustable right in the chat model selector; the settings page's per-model "reasoning strength" field fills each model's real levels from [models.dev](https://models.dev/) `reasoning_options` (e.g. `gpt-5.6-sol` → none/low/medium/high/xhigh/max, `deepseek-v4-flash` → low/high/max), editable in the settings page; `reasoningEfforts: []` opts a model out.
- **Usage lookup**: "view usage" calls `GET {baseURL}/v1/usage` and summarizes quota, balance, rate limits, and subscription windows.
- **Standards-based config**: base URL and model catalogs live in the `llm-sub2api` plugin entry's `config` (`$DSH_HOME/profiles/web/cordis.patch.yml`, written by the web Models page); keys go through the harness credential store.
- **Provider icons** from [lobehub/lobe-icons](https://lobehub.com/icons), embedded as SVG in the settings page.

## Install

Requires DeepSeek Harness **0.2.0-rc.2**. Plugin 0.2.2 uses Loader-owned `Volatile` configuration and the new settings forms API; DSH 0.1.x is outside this release's compatibility range. Settings are persisted in the active profile's `cordis.patch.yml`; the browser UI uses `dsh-client-ui-renderer`.

```bash
dsh plugin --profile web add @godd6366/dsh-sub2api
```

or, from this repository:

```bash
dsh plugin --profile web add .
```

## Configure

Open **Settings → Sub2API 模型** (or edit `$DSH_HOME/profiles/web/cordis.patch.yml` directly):

```yaml
- id: llm-sub2api
  config:
    baseURL: http://localhost:8080
    providers:
      openai:
        apiKeyEnv: SUB2API_OPENAI_API_KEY
        models:
          - id: gpt-5.6-sol
      claude:
        apiKeyEnv: SUB2API_CLAUDE_API_KEY
      grok:
        apiKeyEnv: SUB2API_GROK_API_KEY
    tools:
      generate:
        provider: openai
        model: gpt-image-1
```

Store each key through the credentials service (the web Models page writes it, or export `SUB2API_OPENAI_API_KEY=…` etc.). A route activates only when its platform has a key and at least one model; clear the key (or empty the model list) to drop the route again.

### Wire protocol (automatic per group)

The gateway serves each platform group upstream through its NATIVE protocol, and pi-ai picks the endpoint automatically from the key's group — no configuration needed. Configure the **bare host** (no `/v1`): OpenAI-style endpoints get `/v1` appended automatically, and the Anthropic SDK appends `/v1/messages` itself:

| Group | Protocol used | Endpoint |
|---|---|---|
| openai | `openai-responses` | `POST {baseURL}/v1/responses` |
| claude | `anthropic-messages` | `POST {baseURL}/v1/messages` |
| grok | `openai-completions` | `POST {baseURL}/v1/chat/completions` |

Speaking the native protocol means the gateway never has to convert chat/completions — that conversion is what drops/misaligns tool-call names and ids for parallel calls (`unknown tool ""`, `missing required property …`). To force a different endpoint for a group whose gateway does not serve it natively, declare `api` on the provider in `$DSH_HOME/profiles/web/cordis.patch.yml` (advanced; no settings-page control):

```yaml
- id: llm-sub2api
  config:
    baseURL: http://localhost:8080
    providers:
      openai:
        apiKeyEnv: SUB2API_OPENAI_API_KEY
        api: openai-completions   # optional: openai-completions / openai-responses / anthropic-messages
        models:
          - id: gpt-5.6-sol
```

`api` accepts `openai-completions` (`/v1/chat/completions`), `openai-responses` (`/v1/responses`), or `anthropic-messages` (`/v1/messages`); omitted means the automatic group default above.

### Relationship to dsh-llm-pi-ai

This plugin no longer implements the LLM protocol layer itself: the three `sub2api-*` routes are served by `dsh-llm-pi-ai` (shipped dormant with dsh-base) through the `llm-pi-ai` plugin entry's `providers` configuration. On every `llm-sub2api:` change (and at boot) the plugin translates the bare-host base URL, per-group models, and key references into hand-declared profiles and writes them to the `llm-pi-ai` entry, so routes register/drop live. The settings page, model discovery (`GET /v1/models`), usage lookup (`GET /v1/usage`), the image-generation tool remain this plugin's own.

> **Upgrade note**: 0.2.2 no longer patches pi-ai files in the DSH installation at startup. The DSH 0.2.0-rc.2 adapter owns reconstructed message usage. The legacy patch script remains available for manual maintenance of older environments.

### Image input & reasoning effort

Attaching an image to the session model requires that model to declare the `image` input modality — otherwise the harness refuses before sending ("model does not support images"). **Both fields are editable in model details**: select image input and enter comma-separated reasoning levels, or disable reasoning. models.dev fills missing values without overriding manual choices:

- **Image input**: derived from models.dev `attachment` / `modalities.input` when present (e.g. gpt-5.6-luna → text+image, deepseek-v4-flash → text); otherwise guessed from the model id (`gpt-*`, `claude-*`, `gemini-*`, `grok-*`, `glm-*`, … default to text+image). Pin a model to text-only with `input: [text]` in `$DSH_HOME/profiles/web/cordis.patch.yml`.
- **Reasoning effort**: derived from models.dev `reasoning_options` when present (e.g. deepseek-v4-flash → high/max); otherwise the default low/medium/high, and models with `reasoning: false` are marked unsupported.

When the model accepts images, the request carries the image in the group's native protocol: openai → Responses `input_image`, claude → Messages `image` (base64), grok → chat-completions `image_url`.


## Development

```bash
npm install
npm run build     # tsdown → lib/ + client wrapper
npm run typecheck
```

## GitHub Releases

Pushing a `v<version>` tag runs `.github/workflows/release.yml`: install locked dependencies, typecheck, build and test, then package the prebuilt plugin and publish a GitHub Release with the `.tgz` and `SHA256SUMS` assets. The tag must match the versions in `package.json` and `package-lock.json`. Versions containing a prerelease identifier, such as `v0.2.3-rc.1`, create prereleases. Reruns update assets on the existing release. The workflow uses GitHub's built-in `GITHUB_TOKEN`; no npm publishing token is required.

Commit and push the code and workflow before pushing the tag. This example uses this checkout's `github` remote; substitute the remote for your target repository:

```bash
git push github HEAD
git tag v0.2.2
git push github v0.2.2
```

To release an existing tag manually, open **Actions → Release → Run workflow** and enter the tag. Manual dispatch requires the workflow on the default branch. The workflow publishes Release assets only, not to npm.

Download the `.tgz` from the Release's **Assets**, then install it:

```powershell
dsh plugin --profile desktop add "C:\Users\admin\Downloads\godd6366-dsh-sub2api-0.2.2.tgz"
```

Replace `desktop` with `web` for the Web profile. The package includes compiled plugin files and does not require permission to run a Git dependency's `prepare` script. GitHub's automatically generated Source code archives are not substitutes for this installation package.

To create the same package locally:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm pack --ignore-scripts
```

## License

MIT
