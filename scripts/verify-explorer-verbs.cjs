// 一次性复验：右键"打开"与"用 AgentPlay 智能处理"端到端（CDP 实测）
const { spawn } = require('child_process')

const EXE = 'C:\\Program Files\\ai-player\\AI播放器.exe'
const MEDIA = 'D:\\Backup\\Documents\\My Videos\\AgentPlay 下载\\右键复验-test.mp4'
const DOC = 'D:\\Backup\\Documents\\My Videos\\AgentPlay 下载\\右键复验-test.txt'

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function getTarget(port) {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch { /* 未就绪 */ }
    await wait(1000)
  }
  throw new Error(`CDP 目标未就绪: ${port}`)
}

async function evaluate(ws, expr) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const onMessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id === id) {
        ws.removeEventListener('message', onMessage)
        resolve(msg.result?.result?.value)
      }
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
    setTimeout(() => reject(new Error('evaluate 超时')), 10000)
  })
}

async function runCase(name, port, args, expect) {
  const child = spawn(EXE, [`--remote-debugging-port=${port}`, ...args], { windowsHide: false })
  try {
    const target = await getTarget(port)
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    })
    await wait(6000)
    const raw = await evaluate(ws, `JSON.stringify({
      hasVideo: !!document.querySelector('[data-ai-player-video]'),
      hasMpv: !!document.querySelector('video'),
      text: document.body.innerText.slice(0, 3000)
    })`)
    const state = JSON.parse(raw || '{}')
    const results = expect(state)
    console.log(`[${name}] ${results.map((r) => r.join(':')).join(' | ')}`)
    if (results.some((r) => r[1] === 'MISS')) console.log('  页面头 400 字:', String(state.text || '').slice(0, 400).replace(/\n/g, ' '))
    ws.close()
    return results.every((r) => r[1] === 'OK')
  } finally {
    try { child.kill() } catch { /* 忽略 */ }
  }
}

;(async () => {
  const playOk = await runCase('右键打开播放', 9223, [MEDIA], (s) => [
    ['视频在播', s.hasVideo || s.hasMpv ? 'OK' : 'MISS'],
    ['进度条在走', /[0-9]+:[0-9]{2}/.test(String(s.text)) ? 'OK' : 'MISS']
  ])
  await wait(1500)
  const docOk = await runCase('用 AgentPlay 智能处理', 9224, ['--agentplay-documents', DOC], (s) => [
    ['对话窗打开', String(s.text).includes('AI Agent') ? 'OK' : 'MISS'],
    ['附件芯片', String(s.text).includes('右键复验-test') ? 'OK' : 'MISS']
  ])
  console.log(playOk && docOk ? 'ALL PASS' : 'SOME FAIL')
  process.exit(0)
})().catch((e) => {
  console.log('FAIL:', e.message)
  process.exit(1)
})
