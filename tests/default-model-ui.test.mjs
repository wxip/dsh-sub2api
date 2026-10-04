import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'

const endpoint = '/plugins/dsh-sub2api/default-model'
const configEndpoint = '/plugins/dsh-sub2api/config'
const first = { provider: 'sub2api-openai', model: 'chat-a', name: 'Chat A', reasoningEfforts: [{ id: 'high', name: 'High' }] }
const second = { provider: 'sub2api-claude', model: 'chat-b', name: 'Chat B', reasoningEfforts: [{ id: 'low', name: 'Low' }] }
const key = candidate => JSON.stringify([candidate.provider, candidate.model])
const defaults = (patch = {}) => ({ available: true, writable: true, candidates: [first, second], selection: { provider: first.provider, model: first.model, reasoningEffort: 'high' }, selectionValid: true, ...patch })
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function fixture({ state = defaults(), onDefault, onConfig } = {}) {
  const calls = [], timers = new Map()
  let plugin, view, timerId = 0
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: {
      __ModuleLoader__: { load({ factory }) { plugin = factory(createRequire(import.meta.url)) } },
      setTimeout(callback) { timers.set(++timerId, callback); return timerId },
      clearTimeout(id) { timers.delete(id) },
    },
    btoa,
    fetch: async (url, init) => {
      const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined }
      calls.push(call)
      if (url === endpoint) {
        if (onDefault) return onDefault(call)
        if (call.method === 'POST') state = { ...state, ok: true, selection: call.body }
        return response(state)
      }
      if (url === configEndpoint) {
        if (onConfig) return onConfig(call)
        return response(call.method === 'POST' ? { ok: true, routes: [first.provider] } : {
          baseURL: 'https://gateway.test', catalogFormat: 'structured-v1', providers: { openai: { keyConfigured: true, models: [{ id: first.model }] } },
        })
      }
      if (url.includes('models.dev')) return response({})
      throw new Error(`Unexpected endpoint: ${url}`)
    },
  })
  const entries = []
  plugin.apply({ slots: { inject(_name, callback) { callback() }, register(options, component) { entries.push({ options, component }) } } })
  await act(async () => { view = create(React.createElement(entries.find(entry => entry.options.name === 'settings.section').component)) })
  const button = label => view.root.findAllByType('button').find(node => node.children.includes(label))
  const select = label => view.root.findAllByType('select').find(node => node.props['aria-label'] === label)
  return {
    view, calls, timers, button, select,
    text: () => JSON.stringify(view.toJSON()),
    setState(next) { state = next },
    click: async label => { await act(async () => { await button(label).props.onClick() }) },
    change: async (label, value) => { await act(async () => { select(label).props.onChange({ target: { value } }) }) },
    close: async () => { await act(async () => view.unmount()) },
  }
}

test('default loading is independent of config and never writes automatically', async () => {
  const pending = deferred()
  const f = await fixture({ onDefault: () => pending.promise })
  try {
    assert.match(f.text(), /正在加载默认聊天模型/)
    assert.equal(f.button('设为默认').props.disabled, true)
    assert.equal(f.button('保存配置').props.disabled, false)
    assert.equal(f.view.root.findByProps({ placeholder: 'http://localhost:8080' }).props.value, 'https://gateway.test')
    await act(async () => { pending.resolve(response(defaults())) })
    assert.equal(f.select('默认聊天模型').props.value, key(first))
    assert.equal(f.select('默认聊天模型思考强度').props.value, 'high')
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
  } finally { await f.close() }
})

test('setting defaults posts full routes independently and clears incompatible or omitted effort', async () => {
  const f = await fixture()
  try {
    await f.change('默认聊天模型', key(second))
    assert.equal(f.select('默认聊天模型思考强度').props.value, '')
    await f.click('设为默认')
    assert.deepEqual(f.calls.filter(call => call.method === 'POST'), [{ url: endpoint, method: 'POST', body: { provider: second.provider, model: second.model } }])
    await f.change('默认聊天模型思考强度', 'low')
    await f.click('设为默认')
    assert.equal(f.calls.at(-1).body.reasoningEffort, 'low')
    await f.change('默认聊天模型思考强度', '')
    await f.click('设为默认')
    assert.equal(Object.hasOwn(f.calls.at(-1).body, 'reasoningEffort'), false)
    assert.match(f.text(), /仅对新建 Agent 生效/)
  } finally { await f.close() }
})

test('config save only refreshes defaults and new unsaved models never become candidates', async () => {
  const f = await fixture()
  try {
    await f.click('添加模型')
    const inputs = f.view.root.findAllByProps({ 'aria-label': 'OpenAI 模型 ID' })
    await act(async () => inputs.at(-1).props.onChange({ target: { value: 'new-unsaved' } }))
    assert.equal(f.select('默认聊天模型').findAllByType('option').some(option => option.children.join('').includes('new-unsaved')), false)
    await f.change('默认聊天模型', key(second))
    const oldGets = f.calls.filter(call => call.url === endpoint).length
    await f.click('保存配置')
    assert.equal(f.calls.filter(call => call.url === endpoint).length, oldGets + 1)
    const posts = f.calls.filter(call => call.method === 'POST')
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url, configEndpoint)
    assert.deepEqual(Object.keys(posts[0].body).sort(), ['baseURL', 'providers', 'tools'])
    assert.equal(f.select('默认聊天模型').props.value, key(first))
  } finally { await f.close() }
})

test('external and removed current models remain display-only without a fallback selection', async () => {
  const f = await fixture({ state: defaults({ selection: { provider: 'external', model: 'outside', reasoningEffort: 'max' } }) })
  try {
    assert.match(f.text(), /external \/ outside · max/)
    assert.equal(f.select('默认聊天模型').props.value, '')
    assert.equal(f.select('默认聊天模型').findAllByType('option').length, 3)
    assert.equal(f.button('设为默认').props.disabled, true)
    f.setState(defaults({ candidates: [second], selectionValid: false, warning: '模型已被删除' }))
    await f.click('刷新默认模型')
    assert.match(f.text(), /模型已被删除/)
    assert.match(f.text(), /当前默认模型已失效/)
    assert.equal(f.select('默认聊天模型').props.value, '')
    assert.equal(f.calls.some(call => call.method === 'POST'), false)
  } finally { await f.close() }
})

test('absent service, read-only state and empty candidates disable writes without blocking config', async () => {
  for (const state of [
    defaults({ available: false, writable: false, candidates: [], reason: '未安装默认模型服务' }),
    defaults({ writable: false, reason: '配置只读' }),
    defaults({ candidates: [] }),
  ]) {
    const f = await fixture({ state })
    try {
      assert.equal(f.button('设为默认').props.disabled, true)
      assert.equal(f.button('保存配置').props.disabled, false)
      if (state.reason) assert.ok(f.text().includes(state.reason))
      await f.click('保存配置')
      assert.equal(f.calls.filter(call => call.method === 'POST')[0].url, configEndpoint)
    } finally { await f.close() }
  }
})

test('load and save errors persist inside the card until successful retry', async () => {
  let mode = 'load-error'
  const f = await fixture({ onDefault: call => {
    if (mode === 'load-error') return response({ error: '默认服务离线' }, 503)
    if (call.method === 'POST' && mode === 'save-error') return response({ error: '默认模型保存失败' }, 409)
    return response(defaults({ ...(call.method === 'POST' ? { ok: true, selection: call.body } : {}) }))
  } })
  try {
    assert.match(f.text(), /默认服务离线/)
    assert.equal(f.button('保存配置').props.disabled, false)
    await act(async () => { for (const callback of f.timers.values()) callback() })
    assert.match(f.text(), /默认服务离线/)
    mode = 'save-error'
    await f.click('刷新默认模型')
    assert.doesNotMatch(f.text(), /默认服务离线/)
    await f.click('设为默认')
    assert.match(f.text(), /默认模型保存失败/)
    await f.change('默认聊天模型', key(second))
    await act(async () => { for (const callback of f.timers.values()) callback() })
    assert.match(f.text(), /默认模型保存失败/)
    mode = 'success'
    await f.click('设为默认')
    assert.doesNotMatch(f.text(), /默认模型保存失败/)
  } finally { await f.close() }
})

test('a failed config load does not prevent loading or saving defaults', async () => {
  const f = await fixture({ onConfig: () => response({ error: '配置加载失败' }, 500) })
  try {
    assert.equal(f.select('默认聊天模型').props.value, key(first))
    assert.equal(f.button('设为默认').props.disabled, false)
    await f.click('设为默认')
    assert.equal(f.calls.filter(call => call.method === 'POST')[0].url, endpoint)
  } finally { await f.close() }
})
