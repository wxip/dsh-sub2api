import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { boot, evaluatePluginCompatibility, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { Config as PiConfig, supportedProtocols } from '@deepseek-ai/dsh-llm-pi-ai'
import * as Sub2Api from '../lib/index.js'
import { Config, readConfig, translateToPiAi } from '../lib/index.js'

const config = () => readConfig(Config({
  baseURL: 'https://gateway.test/v1',
  providers: Object.fromEntries(['openai', 'claude', 'grok'].map(key => [key, {
    apiKeyEnv: `TEST_${key.toUpperCase()}`,
    models: [{ id: `${key}-test`, reasoningEfforts: ['none', 'high', 'max'] }],
  }])),
}))

test('all gateway routes satisfy the current pi-ai schema', () => {
  const providers = PiConfig({ providers: translateToPiAi(config()) }).providers.get()
  assert.equal(Object.keys(providers).length, 3)
  assert.equal(providers['sub2api-claude'].baseURL, 'https://gateway.test')
  assert.equal(providers['sub2api-claude'].api, 'anthropic-messages')
  assert.equal(providers['sub2api-openai'].baseURL, 'https://gateway.test/v1')
  assert.equal(providers['sub2api-openai'].api, 'openai-responses')
  assert.equal(providers['sub2api-grok'].api, 'openai-completions')
  assert.deepEqual(providers['sub2api-openai'].models[0].reasoningEfforts, {off: 'none', high: 'high', max: 'max'})
})

test('manifest passes the rc.2 runtime preflight and refuses the old 0.1 runtime', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.2'), undefined)
  const oldRuntime = evaluatePluginCompatibility(manifest, {}, '0.1.2-rc.1')
  assert.ok(oldRuntime)
  assert.equal(oldRuntime.exempted, false)
  assert.ok(Object.hasOwn(oldRuntime.peers, '@deepseek-ai/dsh-settings'))
})

test('off-only reasoning declarations disable reasoning under the target pi-ai schema', () => {
  for (const reasoningEfforts of [['none'], ['off'], ['none', 'off']]) {
    const raw = config()
    raw.providers.openai.models[0].reasoningEfforts = reasoningEfforts
    const providers = PiConfig({ providers: translateToPiAi(raw) }).providers.get()
    assert.equal(providers['sub2api-openai'].models[0].reasoningEfforts, false)
    assert.ok(supportedProtocols().includes(providers['sub2api-openai'].api))
  }
})

async function profileFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'sub2api-compat-')))
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'web-server', name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
    { id: 'llm-pi-ai', name: 'cordis:pi', config: { providers: {} } },
    { id: 'llm-sub2api', name: 'cordis:sub2api', config: config() },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const contexts = []
  let activations = 0
  const start = async () => {
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), owner => {
      owner.provide('profileContext', profile)
      owner.provide('appReady', { onReady(listener) { listener(); return () => {} } })
      owner.provide('llm', { listProviders: () => [] })
      owner.provide('credentials', { async resolve() { throw new Error('compat fixture must not resolve credentials') } })
      Object.assign(owner.loader.builtins, {
        editor: ConfigEditor, settings: SettingsProvider, web: WebServer,
        pi: { Config: PiConfig, apply(_ctx, live) { live.providers.get() } },
        sub2api: { ...Sub2Api, apply(child, live) { activations++; Sub2Api.apply(child, live) } },
      })
    })
    contexts.push(ctx)
    return ctx
  }
  return {
    start, profile, get activations() { return activations },
    async close() { for (const ctx of contexts) await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) },
  }
}

async function eventually(check) {
  const deadline = Date.now() + 5000
  for (;;) {
    if (check()) return
    if (Date.now() >= deadline) assert.fail('configuration did not settle within five seconds')
    await new Promise(resolve => setImmediate(resolve))
  }
}

const section = (ctx, ns) => ctx.settings.describe().find(row => row.ns === ns)?.value
const bridge = ctx => section(ctx, 'llm-pi-ai')?.providers ?? {}
const gatewayEntry = ctx => [...ctx.loader.entries()].find(row => row.options.id === 'llm-sub2api')

test('profile boot updates gateway config without remounting and persists bridged profiles at restart', async () => {
  const fixture = await profileFixture()
  try {
    const ctx = await fixture.start()
    await eventually(() => Object.keys(bridge(ctx)).length === 3)
    const fiber = gatewayEntry(ctx).fiber
    const activations = fixture.activations
    assert.equal(section(ctx, 'llm-sub2api').baseURL, 'https://gateway.test/v1')
    const unrelated = { api: 'openai-completions', baseURL: 'https://other.test/v1', models: [{ id: 'other' }] }
    await ctx.settings.update('llm-pi-ai', { providers: { external: unrelated, 'sub2api-gemini': unrelated } })
    await ctx.settings.replace('llm-sub2api', { ...config(), baseURL: '' })
    await eventually(() => Object.keys(bridge(ctx)).join(',') === 'external')
    assert.equal(gatewayEntry(ctx).fiber, fiber)
    assert.equal(fixture.activations, activations)
    await ctx.settings.replace('llm-sub2api', { ...config(), baseURL: 'https://new.test' })
    await eventually(() => bridge(ctx)['sub2api-openai']?.baseURL === 'https://new.test/v1')
    assert.ok(bridge(ctx).external)
    assert.equal(gatewayEntry(ctx).fiber, fiber)
    assert.equal(fixture.activations, activations)
    assert.match(readFileSync(fixture.profile.patchPath, 'utf8'), /https:\/\/new\.test/)
    await ctx.fiber.dispose()
    const restored = await fixture.start()
    await eventually(() => bridge(restored)['sub2api-openai']?.baseURL === 'https://new.test/v1')
    assert.equal(section(restored, 'llm-sub2api').baseURL, 'https://new.test')
    assert.ok(bridge(restored).external)
    assert.equal('sub2api-gemini' in bridge(restored), false)
  } finally { await fixture.close() }
})

test('real HTTP routes disappear on plugin disposal and register again after reactivation', async () => {
  const fixture = await profileFixture()
  try {
    const ctx = await fixture.start()
    const url = `http://127.0.0.1:${ctx.webServer.port}/plugins/dsh-sub2api/config`
    assert.equal((await fetch(url)).status, 200)
    const entry = gatewayEntry(ctx)
    await entry.update({ disabled: true })
    assert.equal((await fetch(url)).status, 404)
    await entry.update({ disabled: false })
    assert.equal((await fetch(url)).status, 200)
    const attachmentUrl = `http://127.0.0.1:${ctx.webServer.port}/plugins/dsh-sub2api/attachment`
    assert.equal((await fetch(attachmentUrl)).status, 400)
    await entry.update({ disabled: true })
    assert.equal((await fetch(attachmentUrl)).status, 404)
  } finally { await fixture.close() }
})

test('browser bundle registers settings and renders running/settled image tools', () => {
  const require = createRequire(import.meta.url)
  let plugin
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: {__ModuleLoader__: {load({factory}) { plugin = factory(require) }}},
    btoa,
  })
  const entries = []
  plugin.apply({slots: {inject(_name, callback) { callback() }, register(options, component) { entries.push({options, component}) }}})
  assert.equal(entries[0].options.name, 'settings.section')
  const view = entries.find(entry => entry.options.key === 'generate_image').component
  assert.match(JSON.stringify(view({block: {name: 'generate_image'}})), /生成图片/)
  const result = view({block: {kind: 'tool-result', content: [{type: 'text', text: 'saved'}, {type: 'image', attachment: {attachmentId: 'test', mediaType: 'image/png'}}]}})
  assert.match(JSON.stringify(result), /plugins\/dsh-sub2api\/attachment/)
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer'))
  assert.ok(!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'))
})

test('legacy Gemini and auto-vision settings do not create routes', () => {
  const legacy = readConfig(Config({...config(), autoVision: true, providers: {...config().providers, gemini: {apiKeyEnv: 'OLD', models: [{id: 'old'}]}}}))
  assert.deepEqual(Object.keys(translateToPiAi(legacy)), ['sub2api-openai', 'sub2api-claude', 'sub2api-grok'])
})

test('settings save manual capabilities, preserve edits during metadata fill, and dismiss errors', async () => {
  const { create, act } = await import('react-test-renderer')
  const React = await import('react')
  const require = createRequire(import.meta.url)
  let plugin, saved
  const footerStyles = {}
  const scroller = {overflowY: 'auto', paddingBottom: '24px'}
  let observerDisconnected = false
  const timers = new Map()
  let timerId = 0
  const fixture = {baseURL: 'https://gateway.test', catalogFormat: 'structured-v1', providers: {openai: {keyConfigured: true, models: [{id: 'test-model', input: ['text'], reasoningEfforts: ['low']}]}}}
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: {__ModuleLoader__: {load({factory}) { plugin = factory(require) }}, setTimeout(callback) { timers.set(++timerId, callback); return timerId }, clearTimeout(id) {timers.delete(id)}},
    getComputedStyle: element => element,
    ResizeObserver: class { observe() {} disconnect() {observerDisconnected = true} },
    fetch: async (url, init) => ({ok: true, json: async () => {
      if (url.includes('models.dev')) return {openai: {models: {'test-model': {attachment: true, reasoning: true}}}}
      if (init?.method === 'POST') {saved = JSON.parse(init.body); return {ok: true, routes: ['sub2api-openai']}}
      return fixture
    }}), btoa,
  })
  const entries = []
  plugin.apply({slots: {inject(_name, callback) {callback()}, register(options, component) {entries.push({options, component})}}})
  let view
  await act(async () => { view = create(React.createElement(entries[0].component), {createNodeMock: () => ({parentElement: scroller, style: {setProperty(key, value) {footerStyles[key] = value}}})}) })
  try {
    assert.equal(footerStyles['--s2a-footer-inset'], '24px')
    assert.equal(view.root.findAllByProps({className: 's2a_rowTag'}).some(n => n.children.includes('sub2api-gemini')), false)
    await act(async () => {view.root.findAllByProps({className: 's2a_iconBtn s2a_expandBtn'})[0].props.onClick()})
    const field = label => view.root.findByProps({'aria-label': `OpenAI test-model ${label}`})
    await act(async () => {field('图片输入').props.onChange({target: {value: 'text-image'}}); field('思考强度档位').props.onChange({target: {value: 'none, high, max'}})})
    const button = text => view.root.findAllByType('button').find(n => n.children.includes(text))
    await act(async () => {await button('补全数据').props.onClick()})
    await act(async () => {await button('保存配置').props.onClick()})
    assert.deepEqual(saved.providers.openai.models[0].input, ['text', 'image'])
    assert.deepEqual(saved.providers.openai.models[0].reasoningEfforts, ['none', 'high', 'max'])
    assert.deepEqual(Object.keys(saved.providers), ['openai', 'claude', 'grok'])
    assert.equal('analyze' in saved.tools, false)
    assert.equal(view.root.findAllByProps({'aria-label': '识图模型'}).length, 0)
    await act(async () => {field('思考强度档位').props.onChange({target: {value: 'invalid'}})})
    await act(async () => {await button('保存配置').props.onClick()})
    assert.ok(view.root.findByProps({role: 'status'}))
    assert.match(view.root.findByProps({className: 's2a_status s2a_statusErr'}).children.join(''), /思考强度支持/)
    await act(async () => {view.root.findByProps({'aria-label': '关闭提示'}).props.onClick()})
    assert.equal(view.root.findAllByProps({role: 'status'}).length, 0)
    await act(async () => {field('思考模式').props.onChange({target: {value: 'off'}})})
    await act(async () => {await button('保存配置').props.onClick()})
    assert.deepEqual(saved.providers.openai.models[0].reasoningEfforts, [])
    await act(async () => {for (const callback of timers.values()) callback()})
    assert.equal(view.root.findAllByProps({role: 'status'}).length, 0)
  } finally {await act(async () => view.unmount())}
  assert.equal(observerDisconnected, true)
})

test('only the image-generation tool and prompt are registered', async () => {
  const { registerImageTools } = await import('../src/image-tools.ts')
  const tools = [], prompts = []
  registerImageTools({inject(_deps, callback) {callback({tools: {register(tool) {tools.push(tool)}}, systemPrompt: {section(prompt) {prompts.push(prompt)}}})}}, {})
  assert.deepEqual(tools.map(tool => tool.name), ['generate_image'])
  assert.deepEqual(prompts.map(prompt => prompt.name), ['tool:generate_image'])
})

test('generated image output accepts normalized attachments with original dimensions', async () => {
  const { registerImageTools } = await import('../src/image-tools.ts')
  let tool
  registerImageTools({ inject(_deps, callback) {
    callback({ tools: { register(value) { tool = value } }, systemPrompt: { section() {} } })
  } }, {})
  const attachment = {
    attachmentId: 'sha256:test-image', mediaType: 'image/png', bytes: 80,
    width: 1024, height: 768, name: 'generated.png',
    originalDimensions: { width: 4096, height: 3072 },
  }
  const value = { path: 'generated.png', model: 'sub2api-openai/image', mediaType: 'image/png', bytes: 200, attachment }
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), [])
  const content = tool.output.render({ prompt: 'test' }, value)
  assert.deepEqual(content.find(block => block.type === 'image').attachment, attachment)
  assert.ok(validateJsonSchemaValue(tool.output.schema, {
    ...value, attachment: { ...attachment, originalDimensions: { width: 4096 } },
  }, 'value').length > 0)
})
