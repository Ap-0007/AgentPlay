// 订阅账号模型后端：Codex CLI（ChatGPT 订阅）与 Claude Code（Claude 订阅）经只读子进程调用。
// 设计红线：不读/不写用户凭证文件（官方 CLI 自己管 OAuth 与刷新）；只读模式（-s read-only），不执行任何工具命令；
// prompt 一律走 stdin（中文走 argv 会触发 C 运行时崩溃——whisper-cli 教训）。
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const CLI_TIMEOUT_MS = 180000

// prompt 拼装：system + 最近 6 轮（CLI 后端没有多轮协议，压成单文本）
function buildPrompt(messages, systemPrompt) {
  const parts = []
  if (systemPrompt) parts.push(`【系统设定】${systemPrompt}`)
  const history = (Array.isArray(messages) ? messages : []).slice(-6)
  for (const message of history) {
    const role = message.role === 'user' ? '用户' : '助手'
    parts.push(`${role}：${String(message.content || '').slice(0, 4000)}`)
  }
  if (!history.length || history[history.length - 1]?.role !== 'user') parts.push('请继续。')
  return parts.join('\n\n')
}

function extractCodexAnswer(stdout) {
  // codex --json 输出 JSONL：取 item.completed 且 item.type === 'agent_message' 的 text 拼接；
  // 非 JSON 行（models_manager 报错日志等）一律忽略——它们不代表失败（以退出码+有无答案为准）
  const texts = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const event = JSON.parse(trimmed)
      if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
        texts.push(String(event.item.text))
      }
    } catch { /* 非 JSON 日志行 */ }
  }
  return texts.join('\n').trim()
}

function extractClaudeAnswer(stdout) {
  const raw = String(stdout || '').trim()
  try {
    const body = JSON.parse(raw)
    return String(body.result || body.message || '').trim()
  } catch {
    return raw
  }
}

// Windows 的 npm/scoop CLI 是 .cmd/.exe shim：spawn 无扩展名会 ENOENT，按 PATH 逐个扩展名解析
function resolveCliCommand(name) {
  if (process.platform !== 'win32') return name
  for (const dir of String(process.env.PATH || '').split(';')) {
    if (!dir) continue
    for (const ext of ['.cmd', '.exe', '.bat', '']) {
      const candidate = path.join(dir, name + ext)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return name
}


function runCli(command, args, { stdinText, signal, timeoutMs = CLI_TIMEOUT_MS, onEvent }) {
  return new Promise((resolve, reject) => {
    // shell:true 由 Node 处理 .cmd 宿主与引号；args 全是我们构造的固定值，prompt 只走 stdin，无注入面
    const child = spawn(resolveCliCommand(command), args, { windowsHide: true, shell: true })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(reject, new Error('模型响应超时'))
    }, timeoutMs)
    const finish = (fn, value) => {
      if (finish.done) return
      finish.done = true
      clearTimeout(timer)
      fn(value)
    }
    const onAbort = () => {
      try { child.kill() } catch { /* 已退出 */ }
      finish(reject, new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let streamBuf = ''
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stdout += text
      // 增量解析 JSONL 事件（codex --json：thread.started/turn.started/item.completed）
      if (onEvent) {
        streamBuf += text
        const lines = streamBuf.split(/\r?\n/)
        streamBuf = lines.pop()
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('{')) continue
          try { onEvent(JSON.parse(trimmed)) } catch { /* 非 JSON 日志行 */ }
        }
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => finish(resolve, { code, stdout, stderr }))
    child.stdin.on('error', () => { /* 子进程提前关闭 stdin */ })
    child.stdin.end(stdinText, 'utf8')
  })
}

async function completeViaCodex({ messages, systemPrompt, model, signal, timeoutMs, onStatus }) {
  const prompt = buildPrompt(messages, systemPrompt)
  const selectedModel = model || 'gpt-5.5'
  onStatus?.('cli-connecting')
  // -s read-only：安全红线——订阅后端只做对话，绝不允许 CLI 在本机执行命令
  const { code, stdout, stderr } = await runCli('codex', [
    'exec', '--skip-git-repo-check', '-s', 'read-only',
    '--model', selectedModel, '-c', 'model_reasoning_effort=low',
    '--color', 'never', '--json', '-'
  ], {
    stdinText: prompt, signal, timeoutMs,
    // codex exec --json 没有 token 级增量，但有阶段事件：转成真实进度给用户看（不再干等）
    onEvent: (event) => {
      if (event?.type === 'thread.started') onStatus?.('cli-connected')
      else if (event?.type === 'turn.started') onStatus?.('cli-generating')
    }
  })
  const text = extractCodexAnswer(stdout)
  if (text) return { text }
  if (/401|expired|未登录|login required/i.test(stderr)) {
    throw new Error('Codex CLI 登录态失效：请在终端运行 `codex login` 重新登录后重试')
  }
  throw new Error(`Codex CLI 没有返回回答（退出码 ${code}）：${String(stderr).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 200) || '未知原因'}`)
}

async function completeViaClaude({ messages, systemPrompt, model, signal, timeoutMs }) {
  const prompt = buildPrompt(messages, systemPrompt)
  const args = ['-p', '--output-format', 'json']
  if (model && model !== 'default') args.push('--model', model)
  const { code, stdout, stderr } = await runCli('claude', args, { stdinText: prompt, signal, timeoutMs })
  if (/401|expired|authenticate/i.test(stderr + stdout)) {
    throw new Error('Claude Code 登录态已过期：请在终端运行 `claude auth login` 重新登录后重试')
  }
  const text = extractClaudeAnswer(stdout)
  if (text) return { text }
  throw new Error(`Claude Code 没有返回回答（退出码 ${code}）：${String(stderr).trim().slice(0, 200) || '未知原因'}`)
}

// 状态检测（ModelCenter 用）：CLI 是否安装、是否已登录
async function cliModelStatus() {
  const status = { codex: { installed: false, loggedIn: false, note: '' }, claude: { installed: false, loggedIn: false, note: '' } }
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json')
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
      status.codex.installed = true
      status.codex.loggedIn = Boolean(auth?.tokens?.access_token)
      if (!status.codex.loggedIn) status.codex.note = '请在终端运行 `codex login` 登录 ChatGPT 账号'
    } else {
      status.codex.note = '未安装 Codex CLI 或未登录（安装后运行 `codex login`）'
    }
  } catch { status.codex.note = 'Codex CLI 凭证读取失败' }
  try {
    const { stdout } = await runCli('claude', ['auth', 'status'], { stdinText: '', timeoutMs: 15000 })
    const body = JSON.parse(String(stdout).trim())
    status.claude.installed = true
    status.claude.loggedIn = Boolean(body?.loggedIn)
    if (!status.claude.loggedIn) status.claude.note = '登录态已过期：请在终端运行 `claude auth login` 重新登录'
  } catch {
    status.claude.note = '未安装 Claude Code（安装后运行 `claude auth login`）'
  }
  return status
}

module.exports = { completeViaCodex, completeViaClaude, cliModelStatus, buildPrompt, extractCodexAnswer }
