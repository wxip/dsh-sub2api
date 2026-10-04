/**
 * dsh-sub2api → dsh-llm-pi-ai profile bridge.
 *
 * The LLM routes this plugin used to own (`sub2api-openai` / `sub2api-claude`
 * / `sub2api-grok`) are now served by the harness's pi-ai
 * adapter (`dsh-llm-pi-ai`, mounted dormant by dsh-base): protocol
 * serialization, streaming, usage mapping, replay, and retry handling all live
 * in pi-ai. This module is the translation layer — it turns this plugin's
 * `llm-sub2api:` settings section (gateway baseURL + per-group model catalogs
 * + keys) into `llm-pi-ai:` provider profiles and writes them through the
 * settings service, so routes register the moment the section lands and drop
 * again when a key is cleared.
 *
 * Every sub2api group is translated as a *hand-declared* route — pi-ai ships
 * no provider under these keys — with `api` naming the group's native wire
 * protocol (openai→responses, claude→messages, grok→chat-completions),
 * `baseURL` set to the shared gateway, `reasoning` carrying the group's default
 * thinking level (declared only when every model on the route offers it, since
 * llm-pi-ai refuses an unsupported effective level), and `models` carrying the
 * configured catalog with each model's capacity, modalities, and reasoning
 * levels mapped onto pi-ai's vocabulary (`none` becomes `off` with wire
 * spelling `none`).
 *
 * @module dsh-sub2api/pi-ai
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type { PiAiModelProfile, PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { CatalogModel, Config, ProviderKey, ProviderProfile, ReasoningLevel } from './index.ts'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  PROVIDERS,
  apiProtocolForKey,
  gatewayAnthropicRoot,
  gatewayApiRoot,
} from './index.ts'

/** The settings namespace owned by dsh-llm-pi-ai. */
export const PI_AI_NS = 'llm-pi-ai'

/** Route prefix this plugin's groups own in the llm-pi-ai profile dict. */
export const ROUTE_PREFIX: string = 'sub2api-'

/** pi-ai thinking levels a profile may declare (catalog `THINKING_LEVELS`). */
const THINKING_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// Use the adapter's public contract so schema changes cannot silently drift.
export type { PiAiModelProfile, PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'

/** The llm-pi-ai settings section value this plugin writes. */
export interface PiAiSettingsSection {
  providers?: Record<string, PiAiProviderProfile>
}

/**
 * Request modalities a catalog model declares to the harness. An explicit
 * `input` wins; absent/empty falls back to a family guess — frontier
 * multimodal families accept images, everything else stays text-only (the
 * official harness posture: a hand-entered model is text-only until it says
 * otherwise).
 */
function catalogInputModalities(model: { id: string; input?: Array<'text' | 'image'> }): Array<'text' | 'image'> {
  if (model.input !== undefined && model.input.length > 0) return [...model.input]
  return /^(gpt|o[1-9]|claude|gemini|grok|glm|qwen|kimi|moonshot|minimax|mistral|llama|phi|command|jamba|codex|sora|veo|imagen|dall-e)/i.test(model.id)
    ? ['text', 'image']
    : ['text']
}

/**
 * Map this plugin's reasoning-effort ids (OpenAI vocabulary — `none`,
 * `xhigh`, `max`, …) onto pi-ai's level keys. `none` is not a pi-ai level; it
 * becomes `off` with wire spelling `none`, which pi-ai dispatches as
 * `reasoning_effort: "none"` (chat/completions) or `reasoning:{effort:"none"}`
 * (responses) — exactly what this plugin used to send. An empty list declares
 * a non-reasoning model, as does a list containing only off/none; unmappable
 * ids are dropped.
 */
function translateReasoningEfforts(model: CatalogModel): false | Partial<Record<string, string | null>> | undefined {
  const ids = model.reasoningEfforts
  if (ids === undefined) {
    // The plugin's old default: every non-image model exposes low/medium/high.
    if (/image/i.test(model.id)) return false
    return { low: 'low', medium: 'medium', high: 'high' }
  }
  if (ids.length === 0) return false
  const efforts: Record<string, string | null> = {}
  for (const id of ids) {
    if (id === 'none') efforts.off = 'none'
    else if (THINKING_LEVELS.includes(id)) efforts[id] = id
  }
  if (Object.keys(efforts).length === 0) return undefined
  return Object.keys(efforts).some(level => level !== 'off') ? efforts : false
}

/** One configured catalog model, translated onto pi-ai's per-model fields. */
function translateModel(model: CatalogModel): PiAiModelProfile {
  const reasoningEfforts = translateReasoningEfforts(model)
  return {
    id: model.id,
    ...(model.name !== undefined && model.name.length > 0 ? { name: model.name } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    input: catalogInputModalities(model),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
  }
}

/**
 * The thinking levels one translated model ends up offering: `false` (a
 * non-reasoning model) and a list no level survived offer none, otherwise the
 * mapped dict's keys ARE the levels llm-pi-ai reports for it.
 */
function modelReasoningLevels(model: PiAiModelProfile): readonly string[] {
  const efforts = model.reasoningEfforts
  if (efforts === undefined || efforts === false) return []
  return Object.keys(efforts)
}

/**
 * The route-level default level to declare, or undefined when it must not be
 * declared at all.
 *
 * llm-pi-ai resolves a request that names no level to the profile's
 * `reasoning` and REFUSES a level the model does not offer
 * (`UNSUPPORTED_REASONING_EFFORT`), so a route default some model on the route
 * cannot take would break every such request to that model. The level is
 * therefore declared only when every configured model offers it; otherwise the
 * route keeps its previous behaviour (and the settings page reports why).
 *
 * @param profile - the configured provider profile.
 * @param models - the translated catalog of the same route.
 * @returns the level to declare, or undefined to declare none.
 */
function routeReasoning(profile: ProviderProfile, models: PiAiModelProfile[]): ReasoningLevel | undefined {
  const level = profile.reasoning
  if (level === undefined) return undefined
  return models.every(model => modelReasoningLevels(model).includes(level)) ? level : undefined
}

/**
 * Translate one sub2api group into a hand-declared llm-pi-ai provider profile.
 * `apiKeyEnv` passes through verbatim (the harness resolves it per request
 * through `ctx.credentials`); routes without a key are skipped by the caller.
 *
 * The settings store the bare gateway host; the protocols join it differently.
 * OpenAI-compatible SDKs append their endpoint to the `/v1` API root, while
 * `@anthropic-ai/sdk` treats the given URL as the bare host and appends
 * `/v1/messages` itself — so OpenAI-style routes get the `/v1`-rooted URL and
 * the anthropic route gets the bare host.
 */
function translateProfile(key: ProviderKey, profile: ProviderProfile, baseURL: string, label: string): PiAiProviderProfile {
  const api = apiProtocolForKey(key, profile)
  const models = (profile.models ?? []).map(translateModel)
  const reasoning = routeReasoning(profile, models)
  return {
    ...(profile.apiKeyEnv !== undefined ? { apiKeyEnv: profile.apiKeyEnv } : {}),
    displayName: `Sub2API ${label}`,
    api,
    baseURL: api === 'anthropic-messages' ? gatewayAnthropicRoot(baseURL) : gatewayApiRoot(baseURL),
    // The route default removes the picker's "Default" entry: the model menu
    // only offers it while the model reports no default effort of its own.
    ...(reasoning !== undefined ? { reasoning } : {}),
    models,
    // Route-level fallbacks mirror the plugin's old adapter defaults, so a
    // catalog entry that omits a size keeps sizing like before.
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    defaultInput: ['text'],
    // Sub2api acts as a proxy to upstream providers that may enforce their own
    // rate limits (HTTP 429). The default normal policy (2 retries, max 10s)
    // is too short for upstream throttling windows; raise to 5 retries / 120s
    // so transient rate limits resolve before the agent gives up.
    retryPolicy: {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
      backoff: { initialDelayMs: 1000, maxDelayMs: 120000, jitterRatio: 0.2 },
    },
  }
}

/**
 * Build the `llm-pi-ai` provider profile dict for every configured sub2api
 * group. A group is emitted only when it has both a key and at least one
 * model — a hand-declared pi-ai route needs a non-empty `models` list, and a
 * keyless group would otherwise surface as an unauthenticated route.
 */
export function translateToPiAi(config: Config): Record<string, PiAiProviderProfile> {
  const baseURL = (config.baseURL ?? '').trim().replace(/\/+$/, '')
  if (baseURL.length === 0) return {}
  const profiles: Record<string, PiAiProviderProfile> = {}
  for (const def of PROVIDERS) {
    const profile = config.providers[def.key]
    if (profile.apiKeyEnv === undefined) continue
    const models = (profile.models ?? []).filter((model) => model.id.length > 0)
    if (models.length === 0) continue
    profiles[def.route] = translateProfile(def.key, { ...profile, models }, baseURL, def.label)
  }
  return profiles
}

/**
 * Write the translated profiles into the `llm-pi-ai` settings section. Routes
 * under this plugin's `sub2api-` prefix are replaced wholesale; any other
 * route the user configured (e.g. through the built-in Models page) is
 * preserved. The write goes through the settings service, so dsh-llm-pi-ai's
 * own validation (schema + `assertServiceable`) refuses an unserviceable
 * profile at the write site and the section keeps its last good value.
 */
export async function syncPiAiProfiles(ctx: Context, config: Config): Promise<void> {
  const settings = ctx.get('settings')
  if (settings === undefined) return
  const current = settings.describe().find(section => section.ns === PI_AI_NS)?.value as PiAiSettingsSection | undefined
  const providers: Record<string, PiAiProviderProfile> = { ...(current?.providers ?? {}) }
  for (const route of Object.keys(providers)) {
    if (route.startsWith(ROUTE_PREFIX)) delete providers[route]
  }
  const translated = translateToPiAi(config)
  for (const def of PROVIDERS) {
    const emitted = translated[def.route]
    const declared = config.providers[def.key].reasoning
    if (emitted === undefined || declared === undefined || emitted.reasoning === declared) continue
    ctx.logger.warn(`llm-sub2api: route ${def.route} declares no default thinking level for "${declared}": a configured model does not offer it, so the model menu keeps its "Default" entry`)
  }
  Object.assign(providers, translated)
  const next: PiAiSettingsSection = { providers }
  const before = JSON.stringify(current?.providers ?? {})
  if (JSON.stringify(providers) === before) return
  await settings.replace(PI_AI_NS, next)
}
