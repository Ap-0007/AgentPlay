const assert = require('node:assert/strict')
const test = require('node:test')

const {
  MirrorReceiver,
  MirrorSender,
  FrameParser,
  encodeFrame,
  encodeJson,
  parseBeacon,
  FRAME_JPEG
} = require('../electron/mirror-service')

test('frame parser handles split and coalesced frames', () => {
  const seen = []
  const parser = new FrameParser((type, payload) => seen.push({ type, payload: payload.toString() }))
  const a = encodeJson({ hello: 'world' })
  const b = encodeFrame(FRAME_JPEG, Buffer.from('jpeg-bytes'))
  const whole = Buffer.concat([a, b])
  for (const chunk of [whole.subarray(0, 3), whole.subarray(3, 10), whole.subarray(10)]) parser.feed(chunk)
  assert.deepEqual(seen, [
    { type: 0, payload: '{"hello":"world"}' },
    { type: 1, payload: 'jpeg-bytes' }
  ])
})

test('frame parser drops garbage streams instead of leaking memory', () => {
  const parser = new FrameParser(() => {})
  const junk = Buffer.alloc(5)
  junk.writeUInt8(9, 0)
  junk.writeUInt32BE(64 * 1024 * 1024, 1)
  parser.feed(junk)
  assert.equal(parser.buf.length, 0)
})

test('beacon parsing accepts valid announcements and rejects junk', () => {
  assert.deepEqual(parseBeacon('AGENTPLAY_MIRROR|客厅电脑|18910'), { name: '客厅电脑', port: 18910 })
  assert.equal(parseBeacon('AGENTPLAY_MIRROR|x|abc'), null)
  assert.equal(parseBeacon('SSDP:something'), null)
  assert.equal(parseBeacon('AGENTPLAY_MIRROR|x|99999'), null)
})

test('receiver rejects wrong PIN, accepts right PIN and relays frames', async () => {
  const frames = []
  const receiver = new MirrorReceiver({ port: 0, pin: '246810', name: '测试机', onFrame: (buf) => frames.push(buf) })
  // listenWithFallback 以偏好端口起跳；port 0 时直接用系统分配
  receiver.server = null
  await receiver.start()
  const address = receiver.server.address()
  const port = typeof address === 'object' && address ? address.port : receiver.port
  assert.ok(port > 0)

  await assert.rejects(
    new MirrorSender({ host: '127.0.0.1', port, pin: '000000' }).connect(3000),
    /PIN 不正确/
  )

  const sender = new MirrorSender({ host: '127.0.0.1', port, pin: '246810' })
  const hello = await sender.connect(3000)
  assert.equal(hello.ok, true)
  assert.equal(hello.name, '测试机')
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  sender.sendJpeg(jpeg)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(frames.length, 1)
  assert.deepEqual([...frames[0]], [...jpeg])
  sender.close()
  receiver.stop()
})

test('mirror wiring: main IPC, preload bridge and library card exist', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const library = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MediaLibrary.tsx'), 'utf8')
  for (const channel of ['mirror:start-receiver', 'mirror:stop-receiver', 'mirror:scan', 'mirror:start-sender', 'mirror:stop-sender', 'mirror:status']) {
    assert.ok(main.includes(channel), `main 缺少 ${channel}`)
  }
  assert.match(preload, /mirror:\s*\{/)
  assert.match(library, /AgentPlay 互投/)
  assert.match(library, /开启接收（显示 PIN）/)
  // 桌面采集必须走 desktopCapturer 全屏源，而不是只截应用窗口
  assert.match(main, /desktopCapturer\.getSources\(\{ types: \['screen'\]/)
})
