/**
 * 模型/渠道目录与选择辅助。
 *
 * 这里把「当前注册的可用渠道」和「配置声明但尚未激活的渠道」分开：
 * - listProviders() 是可立即选择、可立即请求的 provider；
 * - listConfigurableProviders() 只是诊断信息，不能伪装成可用模型。
 *
 * 所有返回值都是 TUI 自己拥有的普通 JSON，不能把 dsh 的 live service 对象
 * 传到渲染层或长期保存。
 */

/** @typedef {{provider:string, model:string, reasoningEffort?:string}} ModelSelection */

export function parseModelRef(value) {
  return parseModelRefCandidates(value)[0]
}

/**
 * 把 `provider/model` 文本解析成**全部可能的拆分**（每个斜杠位置一种）。
 *
 * 为什么需要多个候选：provider id 本身可能含斜杠（`roundrobin/<组id>` 这类
 * 虚拟路由）。`roundrobin/round-glm-5-3f/round-glm-5-3f` 既可能被读成
 * provider=`roundrobin`，也可能被读成 provider=`roundrobin/round-glm-5-3f`。
 * 文本本身没有答案——**只有 llm 目录能裁决**，所以这里只生成候选，
 * 由调用方逐个交给 `resolveCallConfig` 试。
 *
 * 顺序：从第一个斜杠开始（这是 `provider/model` 的文档约定，也是无歧义
 * 输入如 `openrouter/z-ai/glm-5.2:free` 的正确读法）。
 *
 * @param {unknown} value
 * @returns {Array<{provider:string, model:string}>}
 */
export function parseModelRefCandidates(value) {
  if (typeof value !== 'string') return []
  const raw = value.trim()
  if (raw === '') return []
  const candidates = []
  let index = raw.indexOf('/')
  while (index !== -1) {
    const provider = raw.slice(0, index).trim()
    const model = raw.slice(index + 1).trim()
    // 排除空段与「半个斜杠」的垃圾拆分（`a//b`、`a/`、`/b`）——
    // 它们不可能是真实 provider/model，喂给目录只是噪声。
    if (provider !== '' && model !== '' && !provider.endsWith('/') && !model.startsWith('/')) {
      candidates.push({ provider, model })
    }
    index = raw.indexOf('/', index + 1)
  }
  return candidates
}

export function modelRef(selection) {
  if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return undefined
  if (selection.provider.trim() === '' || selection.model.trim() === '') return undefined
  return `${selection.provider}/${selection.model}`
}

function scalar(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function copyModelInfo(provider, model) {
  if (model === null || typeof model !== 'object') return undefined
  const id = scalar(model.id)
  if (id === undefined) return undefined
  return {
    provider,
    id,
    name: scalar(model.name) ?? id,
    ...(scalar(model.description) === undefined ? {} : { description: model.description }),
    ...(Array.isArray(model.inputModalities) ? { inputModalities: [...model.inputModalities].filter((x) => typeof x === 'string') } : {}),
  }
}

/**
 * 读取当前 LLM 拓扑。
 * @param {object|undefined} llm
 * @returns {Promise<{providers:Array, dormant:Array, errors:Array}>}
 */
export async function loadModelCatalog(llm) {
  const providers = []
  const errors = []
  const dormant = []
  if (llm === undefined || llm === null) return { providers, dormant, errors: ['llm 服务不可用'] }

  let live = []
  try {
    live = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  } catch (error) {
    errors.push(`读取已注册渠道失败：${error?.message ?? error}`)
  }

  let declared = []
  try {
    declared = typeof llm.listConfigurableProviders === 'function' ? llm.listConfigurableProviders() : []
  } catch (error) {
    errors.push(`读取可配置渠道失败：${error?.message ?? error}`)
  }

  const declaredById = new Map()
  for (const row of Array.isArray(declared) ? declared : []) {
    const provider = scalar(row?.provider)
    if (provider !== undefined) declaredById.set(provider, {
      provider,
      name: scalar(row?.displayName) ?? provider,
      settingsNs: scalar(row?.settingsNs),
      error: scalar(row?.error),
    })
  }

  for (const row of Array.isArray(live) ? live : []) {
    const provider = scalar(row?.id)
    if (provider === undefined) continue
    const entry = {
      provider,
      name: scalar(row?.name) ?? declaredById.get(provider)?.name ?? provider,
      models: [],
      status: 'active',
      ...(declaredById.get(provider)?.error === undefined ? {} : { error: declaredById.get(provider).error }),
    }
    try {
      const models = typeof llm.listModels === 'function' ? await llm.listModels(provider) : []
      entry.models = (Array.isArray(models) ? models : []).map((model) => copyModelInfo(provider, model)).filter(Boolean)
    } catch (error) {
      entry.error = `读取模型失败：${error?.message ?? error}`
      errors.push(`${provider}：${entry.error}`)
    }
    providers.push(entry)
    declaredById.delete(provider)
  }

  for (const row of declaredById.values()) {
    dormant.push({ ...row, models: [], status: 'dormant' })
  }

  providers.sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider))
  dormant.sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider))
  return { providers, dormant, errors }
}

export function findModel(catalog, selection) {
  const ref = parseModelRef(`${selection?.provider ?? ''}/${selection?.model ?? ''}`)
  if (ref === undefined) return undefined
  const provider = catalog?.providers?.find((row) => row.provider === ref.provider)
  const model = provider?.models?.find((row) => row.id === ref.model)
  return model === undefined ? undefined : { provider, model }
}

export function providerOptions(catalog) {
  return (catalog?.providers ?? []).map((provider) => ({
    value: provider.provider,
    label: `${provider.name}  ·  ${provider.provider}`,
    description:
      provider.error !== undefined
        ? provider.error
        : provider.models.length === 0
          ? '没有可选择的模型'
          : `${provider.models.length} 个模型`,
  }))
}

export function modelOptions(provider) {
  return (provider?.models ?? []).map((model) => ({
    value: model.id,
    label: model.name === model.id ? model.id : `${model.name}  ·  ${model.id}`,
    description: [model.description, model.inputModalities?.join('/')].filter(Boolean).join(' · ') || undefined,
  }))
}

export function reasoningOptions(info) {
  const efforts = info?.reasoning?.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return []
  return efforts.map((effort) => ({
    value: effort.id,
    label: effort.name === effort.id ? effort.id : `${effort.name}  ·  ${effort.id}`,
    description: effort.description,
  }))
}
