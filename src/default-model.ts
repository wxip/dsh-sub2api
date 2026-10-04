import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-config-editor'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { PROVIDERS, type Config } from './index.ts'

export interface DefaultModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface DefaultModelCandidate {
  provider: string
  model: string
  name: string
  reasoningEfforts: Array<{ id: string; name: string }>
}

export interface DefaultModelState {
  available: boolean
  writable: boolean
  reason?: string
  selection?: DefaultModelSelection
  selectionValid?: boolean
  warning?: string
  candidates: DefaultModelCandidate[]
}

/** Rejected default-model request; `status` is the HTTP code the route returns. */
export class DefaultModelError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = 'DefaultModelError'
  }
}

// The current catalog has no output-modality field. Exclude known dedicated
// media/embedding families; accepting image INPUT must not exclude vision chat.
function isDedicatedNonChatModel(id: string): boolean {
  return /(?:^|[-_/])(image\d*|imagen\d*|dall-e|sora\d*|veo\d*|embedding\w*|whisper\w*|tts\w*|rerank\w*)(?:$|[-_.\/])/i.test(id)
}

/** Read saved configuration intersected with the live adapter catalog. */
async function candidates(ctx: Context, config: Config): Promise<DefaultModelCandidate[]> {
  if (!config.baseURL.trim()) return []
  const registered = new Set(ctx.llm.listProviders().map(provider => provider.id))
  const groups = await Promise.all(PROVIDERS.map(async def => {
    const profile = config.providers[def.key]
    if (!registered.has(def.route) || !profile.apiKeyEnv) return []
    const saved = new Set((profile.models ?? []).map(model => model.id))
    const catalog = await ctx.llm.listModels(def.route)
    const models = catalog.filter(model => saved.has(model.id) && !isDedicatedNonChatModel(model.id))
    return Promise.all(models.map(async model => {
      const resolved = await ctx.llm.resolveModelInfo(def.route, model.id)
      if (resolved.inputModalities !== undefined && !resolved.inputModalities.includes('text')) return undefined
      return {
        provider: def.route,
        model: model.id,
        name: `${def.label} / ${model.name || model.id}`,
        reasoningEfforts: (resolved.reasoning?.efforts ?? []).map(effort => ({ id: String(effort.id), name: effort.name })),
      }
    }))
  }))
  return groups.flat().filter((model): model is DefaultModelCandidate => model !== undefined)
}

export async function readDefaultModel(ctx: Context, config: Config): Promise<DefaultModelState> {
  const service = ctx.get('agentDefaultModel')
  if (service === undefined) return { available: false, writable: false, reason: '当前环境未启用默认模型服务', candidates: [] }
  const selection = service.currentSelection()
  const models = await candidates(ctx, config)
  const writable = ctx.get('configEditor') !== undefined
  const state: DefaultModelState = {
    available: true,
    writable,
    ...(!writable ? { reason: '当前环境缺少配置编辑器，无法持久保存默认模型' } : {}),
    selection,
    candidates: models,
  }
  // External defaults are displayed unchanged; this plugin only validates and
  // offers replacements from the routes it owns.
  if (PROVIDERS.some(def => def.route === selection.provider)) {
    const model = models.find(model => model.provider === selection.provider && model.model === selection.model)
    state.selectionValid = model !== undefined && (selection.reasoningEffort === undefined || model.reasoningEfforts.some(effort => effort.id === selection.reasoningEffort))
    if (!state.selectionValid) state.warning = '当前默认模型或思考强度已不在可用目录中，请重新选择并设为默认'
  }
  return state
}

export async function saveDefaultModel(ctx: Context, config: Config, body: Record<string, unknown>): Promise<DefaultModelState> {
  if (typeof body.provider !== 'string' || !body.provider.trim() || typeof body.model !== 'string' || !body.model.trim()) {
    throw new DefaultModelError('provider 和 model 必须是非空字符串', 400)
  }
  if (body.reasoningEffort !== undefined && (typeof body.reasoningEffort !== 'string' || !body.reasoningEffort.trim())) {
    throw new DefaultModelError('思考强度必须是非空字符串；使用模型默认值时请省略该字段', 400)
  }
  const state = await readDefaultModel(ctx, config)
  if (!state.available || !state.writable) throw new DefaultModelError(state.reason ?? '默认模型暂不可保存', 503)
  const provider = body.provider.trim()
  const model = body.model.trim()
  const candidate = state.candidates.find(candidate => candidate.provider === provider && candidate.model === model)
  if (candidate === undefined) throw new DefaultModelError('请选择已保存并注册的 Sub2API 对话模型；新增模型请先保存配置', 400)
  const reasoningEffort = typeof body.reasoningEffort === 'string' ? body.reasoningEffort.trim() : undefined
  if (reasoningEffort !== undefined && !candidate.reasoningEfforts.some(effort => effort.id === reasoningEffort)) {
    throw new DefaultModelError('所选模型不支持该思考强度，请刷新后重新选择', 400)
  }
  const service = ctx.get('agentDefaultModel')
  if (service === undefined) throw new DefaultModelError('默认模型服务已停用，请刷新后重试', 503)
  await service.saveSelection({ provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort: ReasoningEffortId(reasoningEffort) } : {}) })
  // The profile write publishes the new Config references through the Loader's
  // reload path, which can settle a tick after the save promise resolves. Poll
  // briefly so a slow reload is not reported as "did not take effect"; a write
  // the service skipped (no configuration editor) never converges.
  const applied = () => {
    const actual = service.currentSelection()
    return actual.provider === provider && actual.model === model && actual.reasoningEffort === reasoningEffort
  }
  const deadline = Date.now() + 1000
  while (!applied() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  if (!applied()) throw new DefaultModelError('默认模型保存后未生效或已被其他操作更改，请刷新后重试', 409)
  return readDefaultModel(ctx, config)
}
