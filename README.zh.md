# dsh-sub2api

[English](./README.md)

将你的 [sub2api](https://github.com/Wei-Shaw/sub2api) 网关接入 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)，作为模型供应商。

sub2api 是一个把订阅配额转成 OpenAI 兼容 API 的网关。它的模型是：**每个 API key 绑定一个分组，分组决定平台**（OpenAI / Claude / Grok）与可用模型。三个供应商路由（`sub2api-openai`、`sub2api-claude`、`sub2api-grok`）由 harness 自带的 pi-ai 适配器（`dsh-llm-pi-ai`）承载：本插件把 `llm-sub2api` 条目的配置翻译成 `llm-pi-ai` 条目的 provider profiles（共享同一个**裸主机** baseURL，不带 `/v1`），协议序列化、流式、用量统计全部由 pi-ai 完成。同一个网关同时提供 OpenAI、Claude、Grok 模型，harness 按 key 所在分组自动路由请求。

## 功能

- **一个 baseURL，三个供应商路由**：`sub2api-openai`、`sub2api-claude`、`sub2api-grok`——各自配置独立 key 与至少一个模型，两者就绪后即注册为可用的 LLM 供应商。
- **流式对话（由 pi-ai 承载）**：SSE 流式、工具调用、reasoning 增量与 token 用量由 `dsh-llm-pi-ai` 映射到 harness 协议，天然正确处理 Responses API 的 `function_call` 顶层条目等 wire format 细节。
- **模型发现**：一键「获取模型」调用 `GET {baseURL}/v1/models`（携带该 key），每个路由的模型目录与 sub2api 分组实际提供的完全一致。
- **正式模型参数**：设置页按模型 ID 从 [models.dev](https://models.dev/) 自动补全名称、Context Window 与最大输出长度；匹配不到的字段保持为空，可手动填写。
- **推理等级（思考模式）**：对话模型选择器可直接调整 `reasoning_effort`（透传网关）；设置页「思考强度」字段按 [models.dev](https://models.dev/) 的 `reasoning_options` 逐模型填充真实档位（如 `gpt-5.6-sol` 为 none/low/medium/high/xhigh/max，`deepseek-v4-flash` 为 low/high/max），设置页可编辑展示；可在 cordis.patch.yml 中用 `reasoningEfforts: []` 显式关闭。
- **用量查询**：「查看用量」调用 `GET {baseURL}/v1/usage`，汇总配额、余额、限流窗口与订阅周期用量。
- **标准配置**：baseURL 与模型目录存于 `llm-sub2api` 插件条目的 `config`（`$DSH_HOME/profiles/web/cordis.patch.yml`，web 模型页可直接写入）；key 走 harness 凭据存储。
- **供应商图标**来自 [lobehub/lobe-icons](https://lobehub.com/icons)，以 SVG 内嵌在设置页中。

## 安装

要求 DeepSeek Harness **0.2.0-rc.2**。插件 0.2.2 使用 Loader 管理的 `Volatile` 配置和新版设置表单接口；0.1.x 不在本版本的兼容范围内。设置保存在当前 profile 的 `cordis.patch.yml`，浏览器界面使用 `dsh-client-ui-renderer` 服务。

```bash
dsh plugin --profile web add @wxip/dsh-sub2api
```

或直接在本仓库目录：

```bash
dsh plugin --profile web add .
```

## 配置

打开 **设置 → Sub2API 模型**（或直接编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`）：

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

通过凭据服务存储各 key（web 模型页可写入，或导出 `SUB2API_OPENAI_API_KEY=…` 等环境变量）。某平台填了 key 且至少有一个模型后对应路由才激活；清空 key（或清空模型列表）即可移除该路由。

### 网关协议（自动选择）

sub2api 网关的每个分组在上游走**原生协议**，pi-ai 按分组自动选择，无需配置。设置里填**裸主机**（不带 `/v1`）：OpenAI 风格端点会自动补 `/v1`，Anthropic SDK 会自动补 `/v1/messages`：

| 分组 | 自动选择 | 请求端点 |
|---|---|---|
| openai | `openai-responses` | `POST {baseURL}/v1/responses` |
| claude | `anthropic-messages` | `POST {baseURL}/v1/messages` |
| grok | `openai-completions` | `POST {baseURL}/v1/chat/completions` |

这样网关不需要做 chat/completions ↔ 原生协议转换——并行工具调用正是在这种转换中丢失/错位工具名和 ID，导致 `unknown tool ""`、`missing required property` 报错。如某分组网关实际不走原生协议，可在 cordis.patch.yml 中为该 provider 显式声明 `api`（仅 yaml 层支持，设置页不提供该选项）：

```yaml
- id: llm-sub2api
  config:
    baseURL: http://localhost:8080
    providers:
      openai:
        apiKeyEnv: SUB2API_OPENAI_API_KEY
        api: openai-completions   # 可选：openai-completions / openai-responses / anthropic-messages
        models:
          - id: gpt-5.6-sol
```

`api` 可选值：`openai-completions`（`/v1/chat/completions`）、`openai-responses`（`/v1/responses`）、`anthropic-messages`（`/v1/messages`）；省略 = 按上表自动。

### 与 dsh-llm-pi-ai 的关系

本插件不再自己实现 LLM 协议层：三个 `sub2api-*` 路由由 `dsh-llm-pi-ai`（dsh-base 内置、dormant 挂载）通过 `llm-pi-ai` 插件条目的 `providers` 配置承载。插件在每次 `llm-sub2api` 配置变化（及启动）时把裸主机 baseURL、各组模型与 key 引用翻译成 hand-declared profiles 写入 `llm-pi-ai` 条目，路由即时注册 / 撤销。设置页、模型发现（`GET /v1/models`）、用量查询（`GET /v1/usage`）、生图工具仍由本插件提供。

> **升级说明**：0.2.2 不再在启动时修改 DSH 安装目录中的 pi-ai 文件。DSH 0.2.0-rc.2 的适配器负责多轮消息的 usage 数据。历史补丁脚本保留用于旧环境的手动维护，不属于新版启动流程。

### 图片输入 / 思考强度

模型详情支持手动选择图片输入和填写思考档位（逗号分隔）。补全数据保留手动设置。独立识图工具及其模型选择项已移除；生图模型仍可配置。


会话中直接给模型挂图，需要模型声明 `image` 输入模态（否则 harness 在发送前拒绝，提示"当前模型不支持图片"）。**这两个字段可以在模型详情里手动设置**；models.dev 仅用于补全未填写的值：

- **图片输入**：models.dev 的 `attachment` / `modalities.input` 有数据就自动定（如 gpt-5.6-luna → 文本+图片，deepseek-v4-flash → 仅文本）；没数据时按模型 ID 推断（`gpt-*` / `claude-*` / `gemini-*` / `grok-*` / `glm-*` 等默认支持图片），可手动在 cordis.patch.yml 写 `input: [text]` 强制仅文本。
- **思考强度**：models.dev 的 `reasoning_options` 有数据就自动填真实档位（如 deepseek-v4-flash → high/max）；否则默认 low/medium/high，`reasoning: false` 的模型自动标为不支持。

挂图后请求按分组原生协议携带图片：openai → Responses `input_image`，claude → Messages `image`（base64），grok → chat/completions `image_url`。


## 开发

```bash
npm install
npm run build     # tsdown → lib/ + client wrapper
npm run typecheck
```

## 发布到 npm

包名为 `@wxip/dsh-sub2api`，发布地址为 `https://registry.npmjs.org/`。使用 `wxip` 账号（或拥有该包发布权限的其他账号）登录。账号包管理页面为 https://www.npmjs.com/settings/wxip/packages，该页面不是 registry 地址。

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm run release:npm -- --dry-run
npm run release:npm
```

`release:npm` 会先执行类型检查、构建插件和运行测试，然后公开发布到 npm。追加 `-- --dry-run` 会执行相同检查并预览安装包，不上传到 npm。发布使用 `--ignore-scripts`，因为构建已经完成。同一包版本只能发布一次；发布新版本前请同步更新 `package.json` 和 `package-lock.json` 中的版本号。预发布版本使用 `npm run release:npm -- --tag next`。

这是手动 npm 发布命令；下面的 GitHub Release 工作流仍只发布 GitHub 附件。

## 发布到 GitHub Release

推送 `v<版本号>` 标签后，`.github/workflows/release.yml` 自动安装锁定依赖、执行类型检查和测试、生成 npm 安装包，再创建 GitHub Release 并上传 `.tgz` 和 `SHA256SUMS`。标签必须与 `package.json` 和 `package-lock.json` 的版本一致；含预发布标识的版本（如 `v0.2.3-rc.1`）自动标记为 prerelease。重复运行时会更新已有 Release 的同名附件。工作流使用 GitHub 自带的 `GITHUB_TOKEN`，无需 npm 发布令牌。

先提交并推送代码及工作流，再推送标签。以下示例发布到本仓库的 `github` remote；发布到其他仓库时替换 remote 名称：

```bash
git push github HEAD
git tag v0.2.2
git push github v0.2.2
```

也可以在 GitHub 的 **Actions → Release → Run workflow** 中输入已有标签手动发布；手动触发需要工作流已存在于默认分支。工作流只发布 Release 附件，不发布到 npm。

从 Release 的 **Assets** 下载 `.tgz` 安装包，再执行：

```powershell
dsh plugin --profile desktop add "C:\Users\admin\Downloads\wxip-dsh-sub2api-0.2.2.tgz"
```

Web profile 将 `desktop` 替换为 `web`。`.tgz` 包含已构建的插件文件，安装时无需 Git 来源的 `prepare` 构建许可；GitHub 自动生成的 Source code 压缩包不能替代该安装包。

本地生成同样的安装包：

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm pack --ignore-scripts
```

## 许可证

MIT
