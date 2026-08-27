const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { AgentEngine } = require('../electron/llm-service')

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}

test('an internal model timeout never leaks raw AbortError as a network failure', async (t) => {
  const sockets = new Set()
  const server = http.createServer(() => {})
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  const port = await listen(server)
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close() })
  const engine = new AgentEngine(null)
  const originalSetTimeout = global.setTimeout
  global.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, [30000, 90000, 120000].includes(ms) ? 15 : ms, ...args)
  t.after(() => { global.setTimeout = originalSetTimeout })

  const result = await engine.chat([
    { role: 'user', content: '请用一句话讲一个雨天故事。' }
  ], {
    providerId: 'bundled-lite', providerName: 'AgentPlay 内置模型', model: 'test-model',
    baseUrl: `http://127.0.0.1:${port}/v1`, requiresKey: false, capabilities: { tools: false }
  }, null, { requestId: 'timeout-regression', mode: 'work' })

  assert.doesNotMatch(result.text, /This operation was aborted|\[网络错误\]/)
  assert.match(result.text, /模型响应超时/)
})

test('identity and capability questions use a deterministic product answer without calling a model', async () => {
  const engine = new AgentEngine(null)
  const result = await engine.chat([{ role: 'user', content: '你是谁？具体都能完成什么任务？' }], {
    providerId: 'bundled-lite', model: 'unused', baseUrl: 'http://127.0.0.1:1/v1', requiresKey: false
  }, null, { requestId: 'capability-regression', mode: 'work' })
  assert.match(result.text, /AgentPlay/)
  assert.match(result.text, /视频|字幕|文档/)
  assert.doesNotMatch(result.text, /网络错误|operation was aborted/)
})
