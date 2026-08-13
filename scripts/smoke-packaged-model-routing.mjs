import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const executable = executableArg
  ? path.resolve(executableArg.slice('--exe='.length))
  : path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-routing-'))
const localAiRoot = path.join(profileDir, 'local-ai')
const fakeKey = 'agentplay-routing-smoke-key-never-send'

if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  if (!port) throw new Error('无法分配验收调试端口')
  return port
}

function stageVerifiedLocalAssets() {
  const manifest = path.join(root, 'resources', 'bundled-ai-manifest.json')
  const runtime = path.join(root, 'resources', 'ai-runtime')
  const models = path.join(root, 'resources', 'models')
  const required = [
    manifest,
    path.join(runtime, 'win-x64', 'llama-server.exe'),
    path.join(models, 'Qwen2.5-0.5B-Instruct-Q4_0.gguf')
  ]
  for (const filePath of required) {
    if (!fs.existsSync(filePath)) throw new Error(`本机模型验收资产缺失：${filePath}`)
  }
  fs.mkdirSync(localAiRoot, { recursive: true })
  fs.copyFileSync(manifest, path.join(localAiRoot, 'bundled-ai-manifest.json'))
  fs.symlinkSync(runtime, path.join(localAiRoot, 'ai-runtime'), 'junction')
  fs.symlinkSync(models, path.join(localAiRoot, 'models'), 'junction')
  fs.writeFileSync(path.join(profileDir, 'model-catalog.json'), JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    providers: {
      deepseek: { models: ['deepseek-chat', 'deepseek-reasoner'], source: 'stale-smoke-fixture' }
    }
  }))
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

async function openSession() {
  const port = await freePort()
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-position=-2400,-2400'
  ], { cwd: path.dirname(executable), windowsHide: true, shell: false })

  let page
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`待验收应用提前退出：${child.exitCode}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) break
    } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('待验收应用未在 60 秒内开放调试页')

  const websocket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 0
  websocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  await new Promise((resolve, reject) => {
    websocket.addEventListener('open', resolve, { once: true })
    websocket.addEventListener('error', reject, { once: true })
  })

  const command = (method, params = {}) => {
    const id = ++nextId
    websocket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  const evaluate = async (expression, awaitPromise = false) => {
    const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || '页面表达式执行失败')
    }
    return response.result?.value
  }

  await command('Runtime.enable')
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await evaluate(`document.readyState === 'complete' && Boolean(window.aiPlayer?.models?.routingStatus)`)) break
    await delay(250)
  }
  return { child, websocket, command, evaluate }
}

async function closeSession(session) {
  try { await Promise.race([session.command('Browser.close'), delay(1500)]) } catch {}
  await waitForChildExit(session.child, 8000)
  if (session.child.exitCode === null) {
    session.child.kill()
    await waitForChildExit(session.child, 5000)
  }
  try { session.websocket.close() } catch {}
}

function cleanProfile() {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  const resolvedProfile = path.resolve(profileDir)
  if (!resolvedProfile.startsWith(tempRoot) || !path.basename(resolvedProfile).startsWith('agentplay-model-routing-')) {
    throw new Error(`拒绝清理非验收临时目录：${resolvedProfile}`)
  }
  for (const link of [path.join(localAiRoot, 'ai-runtime'), path.join(localAiRoot, 'models')]) {
    try {
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link)
    } catch {}
  }
  fs.rmSync(resolvedProfile, { recursive: true, force: true })
}

let session
try {
  stageVerifiedLocalAssets()
  session = await openSession()
  const result = await session.evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (probe, label, timeoutMs = 12000) => {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        const value = await probe()
        if (value) return value
        await wait(80)
      }
      throw new Error('等待超时：' + label)
    }
    const buttons = () => [...document.querySelectorAll('button')]
    const buttonWith = (text) => buttons().find((button) => button.textContent?.includes(text))
    const preference = async () => (await window.aiPlayer.models.routingStatus()).settings.preference
    const providers = await window.aiPlayer.models.providers()
    const deepseek = providers.find((provider) => provider.id === 'deepseek')

    let migratedDeepSeek = null

    const openModelCenter = () => {
      window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'model-center' }))
      window.dispatchEvent(new CustomEvent('ai-player-open-model-center'))
      return document.querySelector('[data-model-routing-simple="true"]')
    }
    // readyState 与 preload 就绪可能早于 React 注册全局事件；重发幂等打开事件，消除冷启动竞态。
    const section = await waitFor(openModelCenter, '模型使用方式加载')
    await waitFor(() => !buttonWith('只在本机')?.disabled, '三种方式可操作')
    const optionTitles = ['智能选择（推荐）', '只在本机', '优先效果']
    const loadedOptions = optionTitles.filter((title) => [...section.querySelectorAll('button')].some((button) => button.textContent?.includes(title)))

    buttonWith('只在本机').click()
    const localState = await waitFor(async () => {
      const [routing, config] = await Promise.all([
        window.aiPlayer.models.routingStatus(),
        window.aiPlayer.models.config('chat')
      ])
      return routing.settings.preference === 'local' && config.providerId === 'bundled-lite'
        ? { routing, config }
        : null
    }, '真正切换到本机')

    buttonWith('优先效果').click()
    await waitFor(() => document.body.innerText.includes('要优先效果，先在下方选择 Key 来源并粘贴验证'), '未接入云端的诚实提示')
    const afterMissingCloud = {
      preference: await preference(),
      config: await window.aiPlayer.models.config('chat'),
      statusVisible: document.body.innerText.includes('要优先效果，先在下方选择 Key 来源并粘贴验证')
    }

    const noProviderProbe = await window.aiPlayer.models.autoDetect({
      apiKey: ${JSON.stringify(fakeKey)},
      providerId: ''
    })

    await window.aiPlayer.models.save({
      role: 'chat',
      providerId: 'deepseek',
      model: 'deepseek-reasoner',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: ${JSON.stringify(fakeKey)}
    })
    migratedDeepSeek = await window.aiPlayer.models.config('chat')

    await window.aiPlayer.models.save({
      role: 'chat',
      providerId: 'agnes',
      model: 'agnes-2.5-flash',
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      apiKey: ${JSON.stringify(fakeKey)}
    })
    await window.aiPlayer.models.quickSwitch({ role: 'chat', target: 'bundled' })
    await window.aiPlayer.models.routingSettings({ preference: 'local', objective: 'economy' })

    let localCloudBlock = ''
    try {
      await Promise.race([
        window.aiPlayer.studio.creativePlan({ title: '路由验收，不应上传' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('云端调用未被本机模式及时阻止')), 3000))
      ])
    } catch (error) {
      localCloudBlock = String(error?.message || error)
    }

    // 上面的凭证由验收桥直接写入，不经过 ModelCenter 自己的保存按钮；
    // 重新挂载一次面板，让组件从主进程读取最新候选后再验证真实断开入口。
    const closeModelCenter = buttons().find((button) => button.textContent?.trim() === '✕')
    closeModelCenter?.click()
    await waitFor(() => !document.querySelector('[data-model-routing-simple="true"]'), '模型使用方式关闭')
    await waitFor(openModelCenter, '模型使用方式重新加载')
    await waitFor(() => !buttonWith('高级设置')?.disabled, '高级设置可操作')
    buttonWith('高级设置').click()
    const disconnect = await waitFor(() => buttons().find((button) => button.textContent?.trim() === '断开'), '已接入服务断开入口')
    const localPacksToggle = await waitFor(() => buttonWith('本地组件与下载'), '本地组件折叠入口')
    localPacksToggle.click()
    await waitFor(() => document.querySelector('[data-unlimited-ocr-config="true"]'), '高级 OCR 配置入口')
    const advancedOcrStatus = await window.aiPlayer.unlimitedOcr.status({ probe: false })
    const advancedOcrCardVisible = document.body.innerText.includes('高级文档解析 · Unlimited-OCR')
    const candidatesWithoutApproval = (await window.aiPlayer.models.routingStatus()).candidates

    return {
      version: window.aiPlayer.version,
      deepseekCatalog: deepseek ? {
        models: deepseek.models,
        pricingVerifiedAt: deepseek.pricingVerifiedAt,
        flashPricing: deepseek.modelProfiles?.['deepseek-v4-flash']?.pricing
      } : null,
      migratedDeepSeek: {
        model: migratedDeepSeek.model,
        thinkingMode: migratedDeepSeek.thinkingMode,
        hasApiKey: migratedDeepSeek.hasApiKey
      },
      loadedOptions,
      localPreference: localState.routing.settings.preference,
      localProvider: localState.config.providerId,
      localConfigured: localState.config.configured,
      missingCloud: afterMissingCloud,
      noProviderProbe,
      localCloudBlock,
      disconnectEntryVisible: Boolean(disconnect),
      advancedOcrStatus,
      advancedOcrCardVisible,
      credentialUntouchedWithoutApproval: candidatesWithoutApproval.some((candidate) => candidate.providerId === 'agnes')
    }
  })()`, true)

  const configPath = path.join(profileDir, 'model-config.json')
  const rawConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
  const failures = []
  if (JSON.stringify(result.deepseekCatalog?.models) !== JSON.stringify(['deepseek-v4-flash', 'deepseek-v4-pro'])) {
    failures.push(`旧缓存未安全迁移 DeepSeek 型号：${JSON.stringify(result.deepseekCatalog?.models)}`)
  }
  if (result.deepseekCatalog?.pricingVerifiedAt !== '2026-08-13' || result.deepseekCatalog?.flashPricing?.inputUsdPerMillion !== 0.14) {
    failures.push(`DeepSeek 官方价格元数据未进入安装包：${JSON.stringify(result.deepseekCatalog)}`)
  }
  if (result.migratedDeepSeek?.model !== 'deepseek-v4-flash' || result.migratedDeepSeek?.thinkingMode !== 'enabled' || !result.migratedDeepSeek?.hasApiKey) {
    failures.push(`旧 DeepSeek 配置未保留思考行为或凭证：${JSON.stringify(result.migratedDeepSeek)}`)
  }
  if (result.loadedOptions.length !== 3) failures.push(`三种使用方式未完整加载：${result.loadedOptions.join(', ')}`)
  if (result.localPreference !== 'local' || result.localProvider !== 'bundled-lite' || !result.localConfigured) {
    failures.push(`本机模式没有真正切换配置：${JSON.stringify({ preference: result.localPreference, provider: result.localProvider, configured: result.localConfigured })}`)
  }
  if (result.missingCloud.preference !== 'local' || result.missingCloud.config.providerId !== 'bundled-lite' || !result.missingCloud.statusVisible) {
    failures.push('未接入云端时“优先效果”被误报为成功')
  }
  if (!result.noProviderProbe?.needsProvider || result.noProviderProbe?.success !== false) {
    failures.push('未选择 Key 来源时没有在发网前失败关闭')
  }
  if (!/只在本机/.test(result.localCloudBlock)) failures.push(`本机模式没有在上传前阻止云能力：${result.localCloudBlock}`)
  if (!result.disconnectEntryVisible) failures.push('高级设置中没有断开入口')
  if (result.advancedOcrStatus?.enabled !== false || result.advancedOcrStatus?.ready !== false || !/未启用/.test(result.advancedOcrStatus?.reason || '')) {
    failures.push(`高级 OCR 默认状态不安全：${JSON.stringify(result.advancedOcrStatus)}`)
  }
  if (!result.advancedOcrCardVisible) failures.push('高级设置中没有 Unlimited-OCR 可选接入入口')
  if (!result.credentialUntouchedWithoutApproval) failures.push('未发起统一审批时凭证被意外删除')
  if (rawConfig.includes(fakeKey)) failures.push('模型配置文件包含明文 Key')
  if (!/encryptedApiKey/.test(rawConfig)) failures.push('模型配置文件没有系统加密凭证记录')
  if (failures.length) throw new Error(failures.join('；'))

  process.stdout.write(`${JSON.stringify({
    executable,
    version: result.version,
    deepseekV4CatalogVerified: true,
    legacyDeepSeekMigrationVerified: true,
    verifiedPricingMetadataPresent: true,
    threeChoicesLoaded: true,
    localSwitchVerified: true,
    missingCloudFailsHonestly: true,
    noProviderProbeFailsBeforeNetwork: true,
    localOnlyCloudBlock: result.localCloudBlock,
    disconnectEntryVerifiedWithoutBypassingApproval: true,
    advancedOcrDefaultDisabled: true,
    advancedOcrEntryPresent: true,
    encryptedAtRest: true
  }, null, 2)}\n`)
} finally {
  if (session) await closeSession(session)
  cleanProfile()
}
