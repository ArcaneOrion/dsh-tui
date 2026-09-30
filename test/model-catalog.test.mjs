/**
 * 模型目录 / 渠道选择辅助测试。
 *
 * 只测纯函数与「数据源缺失时的降级」：这一层没有 TTY、没有内核，
 * dsh 的 live service 对象全部用 detach 过的假数据模拟。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  findModel,
  loadModelCatalog,
  modelOptions,
  modelRef,
  parseModelRef,
  parseModelRefCandidates,
  providerOptions,
  reasoningOptions,
} from '../src/model-catalog.js'

// ── parseModelRef / modelRef ─────────────────────────────────────────────

test('parseModelRef：provider/model 拆分', () => {
  assert.deepEqual(parseModelRef('my-opencode-go/deepseek-v4.1-flash'), {
    provider: 'my-opencode-go',
    model: 'deepseek-v4.1-flash',
  })
})

test('parseModelRef：模型 id 内含斜杠时第一段才是 provider', () => {
  assert.deepEqual(parseModelRef('openrouter/z-ai/glm-5.2:free'), {
    provider: 'openrouter',
    model: 'z-ai/glm-5.2:free',
  })
})

test('parseModelRef：非法形式返回 undefined', () => {
  assert.equal(parseModelRef('no-slash'), undefined)
  assert.equal(parseModelRef('/leading'), undefined)
  assert.equal(parseModelRef('trailing/'), undefined)
  assert.equal(parseModelRef(''), undefined)
  assert.equal(parseModelRef(undefined), undefined)
  assert.equal(parseModelRef(42), undefined)
})

test('parseModelRef：两端空白被修剪', () => {
  assert.deepEqual(parseModelRef('  p / m '), { provider: 'p', model: 'm' })
})

// ── parseModelRefCandidates（含斜杠 provider id 的裁决候选）────────────────

test('候选：单斜杠只有一种拆分', () => {
  assert.deepEqual(parseModelRefCandidates('p/m'), [{ provider: 'p', model: 'm' }])
})

test('候选：provider 含斜杠时给出全部拆分，第一斜杠优先', () => {
  // 这是实机事故的形状：记住的 roundrobin 组被「第一个斜杠」读成 provider=roundrobin。
  assert.deepEqual(parseModelRefCandidates('roundrobin/round-glm-5-3f/round-glm-5-3f'), [
    { provider: 'roundrobin', model: 'round-glm-5-3f/round-glm-5-3f' },
    { provider: 'roundrobin/round-glm-5-3f', model: 'round-glm-5-3f' },
  ])
})

test('候选：模型 id 含斜杠时同样给出两种，交由目录裁决', () => {
  assert.deepEqual(parseModelRefCandidates('openrouter/z-ai/glm-5.2:free'), [
    { provider: 'openrouter', model: 'z-ai/glm-5.2:free' },
    { provider: 'openrouter/z-ai', model: 'glm-5.2:free' },
  ])
})

test('候选：非法与空输入给空数组，不产出半截候选', () => {
  assert.deepEqual(parseModelRefCandidates('no-slash'), [])
  assert.deepEqual(parseModelRefCandidates('/leading'), [])
  assert.deepEqual(parseModelRefCandidates('trailing/'), [])
  assert.deepEqual(parseModelRefCandidates('a//b'), [])
  assert.deepEqual(parseModelRefCandidates(undefined), [])
  assert.deepEqual(parseModelRefCandidates(42), [])
})

test('候选：parseModelRef 恒等于第一个候选（文档约定不变）', () => {
  for (const ref of ['p/m', 'openrouter/z-ai/glm-5.2:free', 'roundrobin/g/g']) {
    assert.deepEqual(parseModelRef(ref), parseModelRefCandidates(ref)[0])
  }
})

test('modelRef：从 selection 拼回 provider/model', () => {
  assert.equal(modelRef({ provider: 'p', model: 'm' }), 'p/m')
  assert.equal(modelRef(undefined), undefined)
  assert.equal(modelRef({ provider: 'p' }), undefined)
})

// ── loadModelCatalog ─────────────────────────────────────────────────────

function fakeLlm({ providers = [], configurable = [], models = {} } = {}) {
  return {
    listProviders: () => providers,
    listConfigurableProviders: () => configurable,
    listModels: async (provider) => models[provider] ?? [],
  }
}

test('loadModelCatalog：服务缺失时给空目录加错误，不抛错', async () => {
  const catalog = await loadModelCatalog(undefined)
  assert.deepEqual(catalog.providers, [])
  assert.deepEqual(catalog.dormant, [])
  assert.ok(catalog.errors.length > 0)
})

test('loadModelCatalog：活跃渠道列出模型，且数据被 detach', async () => {
  const liveModel = { provider: 'p', id: 'm', name: 'Model M' }
  const catalog = await loadModelCatalog(
    fakeLlm({ providers: [{ id: 'p', name: 'P' }], models: { p: [liveModel] } }),
  )
  assert.equal(catalog.providers.length, 1)
  assert.equal(catalog.providers[0].provider, 'p')
  assert.equal(catalog.providers[0].status, 'active')
  assert.deepEqual(catalog.providers[0].models, [liveModel])
  assert.notEqual(catalog.providers[0].models[0], liveModel, '必须拷贝，不能把 live 对象交出去')
})

test('loadModelCatalog：单渠道 listModels 抛错只标记该渠道，其它渠道不受影响', async () => {
  const llm = {
    listProviders: () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    listConfigurableProviders: () => [],
    listModels: async (provider) => {
      if (provider === 'a') throw new Error('boom')
      return [{ provider: 'b', id: 'm2', name: 'M2' }]
    },
  }
  const catalog = await loadModelCatalog(llm)
  assert.equal(catalog.providers.find((row) => row.provider === 'a').error, '读取模型失败：boom')
  assert.equal(catalog.providers.find((row) => row.provider === 'b').models.length, 1)
  assert.ok(catalog.errors.some((line) => line.includes('a：')))
})

test('loadModelCatalog：声明未激活的渠道归入 dormant，不混进可选列表', async () => {
  const catalog = await loadModelCatalog(
    fakeLlm({
      providers: [{ id: 'live', name: 'Live' }],
      configurable: [{ provider: 'ghost', displayName: 'Ghost', settingsNs: 'llm-pi-ai' }],
    }),
  )
  assert.deepEqual(catalog.providers.map((row) => row.provider), ['live'])
  assert.deepEqual(catalog.dormant.map((row) => row.provider), ['ghost'])
})

test('loadModelCatalog：providerInfo 的 id 不匹配的行被跳过，不产出脏数据', async () => {
  const catalog = await loadModelCatalog(fakeLlm({ providers: [{ id: '', name: 'broken' }, { id: 'ok', name: 'Ok' }] }))
  assert.deepEqual(catalog.providers.map((row) => row.provider), ['ok'])
})

// ── 查找与选项 ───────────────────────────────────────────────────────────

const catalog = {
  providers: [
    {
      provider: 'p',
      name: 'P',
      status: 'active',
      models: [
        { provider: 'p', id: 'm1', name: 'M1' },
        { provider: 'p', id: 'm2', name: 'M2', inputModalities: ['text', 'image'] },
      ],
    },
  ],
  dormant: [],
  errors: [],
}

test('findModel：命中返回 provider 行与 model 行', () => {
  const found = findModel(catalog, { provider: 'p', model: 'm2' })
  assert.equal(found.provider.provider, 'p')
  assert.equal(found.model.id, 'm2')
})

test('findModel：未命中返回 undefined', () => {
  assert.equal(findModel(catalog, { provider: 'p', model: 'nope' }), undefined)
  assert.equal(findModel(catalog, { provider: 'x', model: 'm1' }), undefined)
  assert.equal(findModel(undefined, { provider: 'p', model: 'm1' }), undefined)
})

test('providerOptions：带渠道名与模型计数', () => {
  const options = providerOptions(catalog)
  assert.equal(options.length, 1)
  assert.equal(options[0].value, 'p')
  assert.match(options[0].label, /P/)
  assert.match(options[0].description, /2 个模型/)
})

test('providerOptions：出错渠道把错误当 description，不编造计数', () => {
  const broken = { providers: [{ provider: 'x', name: 'X', status: 'active', models: [], error: '读取模型失败：boom' }], dormant: [], errors: [] }
  assert.equal(providerOptions(broken)[0].description, '读取模型失败：boom')
})

test('modelOptions：name 与 id 都如实显示（大小写不同也不吞信息），模态进 description', () => {
  const options = modelOptions(catalog.providers[0])
  assert.match(options[0].label, /M1/)
  assert.match(options[0].label, /m1/)
  assert.match(options[1].label, /M2/)
  assert.equal(options[1].description, 'text/image')
})

test('reasoningOptions：空 efforts 给空数组', () => {
  assert.deepEqual(reasoningOptions(undefined), [])
  assert.deepEqual(reasoningOptions({}), [])
  assert.deepEqual(reasoningOptions({ reasoning: { efforts: [] } }), [])
})

test('reasoningOptions：列出 id 与展示名', () => {
  const options = reasoningOptions({
    reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max', description: '最深思考' }] },
  })
  assert.equal(options[0].value, 'low')
  assert.match(options[1].label, /Max/)
  assert.equal(options[1].description, '最深思考')
})
