// AgentPlay 互投（屏幕镜像）：发送端采集+TCP 推流，接收端校验 PIN + UDP 广播被发现。
// 协议：首帧 JSON {"pin":"123456"}（type 0），随后 [type 1][4B BE 长度][JPEG] 逐帧。
// 本文件不含 electron 依赖（采集/窗口由 main.js 装配），协议与收发逻辑可纯 node 测试。
const dgram = require('dgram')
const net = require('net')
const os = require('os')
const { getLanIp, listenWithFallback } = require('./utils')

const FRAME_JSON = 0
const FRAME_JPEG = 1
const DISCOVERY_PORT = 18911
const DEFAULT_PORT = 18910
const BEACON_PREFIX = 'AGENTPLAY_MIRROR'

function encodeFrame(type, payload) {
  const head = Buffer.alloc(5)
  head.writeUInt8(type, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

function encodeJson(obj) {
  return encodeFrame(FRAME_JSON, Buffer.from(JSON.stringify(obj), 'utf8'))
}

// 粘包/拆包处理：攒到够一个完整帧才回调
class FrameParser {
  constructor(onMessage) {
    this.buf = Buffer.alloc(0)
    this.onMessage = onMessage
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    while (this.buf.length >= 5) {
      const type = this.buf.readUInt8(0)
      const len = this.buf.readUInt32BE(1)
      if (len > 32 * 1024 * 1024) {
        // 明显错乱的流（协议不对），直接丢弃缓冲防内存爆
        this.buf = Buffer.alloc(0)
        return
      }
      if (this.buf.length < 5 + len) break
      const payload = this.buf.subarray(5, 5 + len)
      this.buf = this.buf.subarray(5 + len)
      this.onMessage(type, payload)
    }
  }
}

function parseBeacon(text) {
  const parts = String(text || '').split('|')
  if (parts[0] !== BEACON_PREFIX || parts.length < 3) return null
  const port = Number(parts[2])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { name: parts[1] || 'AgentPlay', port }
}

class MirrorReceiver {
  constructor({ port = DEFAULT_PORT, pin, name, onFrame, onClientsChange } = {}) {
    this.port = port
    this.pin = pin || String(Math.floor(100000 + Math.random() * 900000))
    this.name = name || os.hostname()
    this.onFrame = onFrame || (() => {})
    this.onClientsChange = onClientsChange || (() => {})
    this.server = null
    this.beacon = null
    this.beaconTimer = null
    this.clients = new Set()
  }

  info() {
    return { port: this.port, pin: this.pin, name: this.name, url: `agentplay://${getLanIp()}:${this.port}` }
  }

  async start() {
    if (this.server) return this.info()
    this.server = net.createServer((socket) => this.handleClient(socket))
    this.port = await listenWithFallback(this.server, this.port)
    this.beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.beacon.on('error', () => {})
    this.beacon.bind(() => {
      try { this.beacon.setBroadcast(true) } catch { /* 某些网卡不支持广播 */ }
      this.announce()
    })
    this.beaconTimer = setInterval(() => this.announce(), 3000)
    return this.info()
  }

  announce() {
    if (!this.beacon) return
    const msg = Buffer.from(`${BEACON_PREFIX}|${this.name}|${this.port}`)
    try { this.beacon.send(msg, DISCOVERY_PORT, '255.255.255.255') } catch { /* 忽略 */ }
  }

  handleClient(socket) {
    let authed = false
    const parser = new FrameParser((type, payload) => {
      if (!authed) {
        if (type !== FRAME_JSON) {
          socket.destroy()
          return
        }
        let msg = {}
        try { msg = JSON.parse(payload.toString('utf8')) } catch { /* 按错误处理 */ }
        if (String(msg.pin || '') !== this.pin) {
          socket.write(encodeJson({ ok: false, error: 'PIN 不正确' }))
          socket.end()
          return
        }
        authed = true
        this.clients.add(socket)
        this.onClientsChange(this.clients.size)
        socket.write(encodeJson({ ok: true, name: this.name }))
        return
      }
      if (type === FRAME_JPEG) this.onFrame(payload)
    })
    socket.on('data', (chunk) => parser.feed(chunk))
    const drop = () => {
      if (this.clients.delete(socket)) this.onClientsChange(this.clients.size)
    }
    socket.on('close', drop)
    socket.on('error', () => {})
  }

  stop() {
    if (this.beaconTimer) clearInterval(this.beaconTimer)
    this.beaconTimer = null
    try { this.beacon?.close() } catch { /* 忽略 */ }
    this.beacon = null
    for (const socket of this.clients) {
      try { socket.destroy() } catch { /* 忽略 */ }
    }
    this.clients.clear()
    try { this.server?.close() } catch { /* 忽略 */ }
    this.server = null
  }
}

class MirrorSender {
  constructor({ host, port, pin } = {}) {
    this.host = host
    this.port = port
    this.pin = pin
    this.socket = null
  }

  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })
      this.socket = socket
      let settled = false
      const done = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      const timer = setTimeout(() => {
        socket.destroy()
        done(reject, new Error('连接互投设备超时'))
      }, timeoutMs)
      const parser = new FrameParser((type, payload) => {
        if (type !== FRAME_JSON) return
        let msg = {}
        try { msg = JSON.parse(payload.toString('utf8')) } catch { /* 忽略 */ }
        if (msg.ok) done(resolve, msg)
        else done(reject, new Error(msg.error || '配对失败'))
      })
      socket.on('data', (chunk) => parser.feed(chunk))
      socket.on('error', (error) => done(reject, error))
      socket.on('close', () => done(reject, new Error('连接被关闭')))
      socket.on('connect', () => socket.write(encodeJson({ pin: this.pin })))
    })
  }

  sendJpeg(jpeg) {
    if (this.socket && !this.socket.destroyed) this.socket.write(encodeFrame(FRAME_JPEG, jpeg))
  }

  close() {
    try { this.socket?.end() } catch { /* 忽略 */ }
    this.socket = null
  }
}

// 监听局域网里的互投接收端（UDP 广播）
class MirrorDiscovery {
  constructor() {
    this.socket = null
    this.found = new Map()
  }

  listen(durationMs = 2500) {
    this.found.clear()
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      this.socket = socket
      socket.on('error', () => {})
      socket.on('message', (msg, rinfo) => {
        const beacon = parseBeacon(msg.toString())
        if (!beacon) return
        this.found.set(`${rinfo.address}:${beacon.port}`, { name: beacon.name, host: rinfo.address, port: beacon.port })
      })
      socket.bind(DISCOVERY_PORT, () => {
        setTimeout(() => {
          this.stop()
          resolve([...this.found.values()])
        }, durationMs)
      })
    })
  }

  stop() {
    try { this.socket?.close() } catch { /* 忽略 */ }
    this.socket = null
  }
}

module.exports = {
  MirrorReceiver,
  MirrorSender,
  MirrorDiscovery,
  FrameParser,
  encodeFrame,
  encodeJson,
  parseBeacon,
  FRAME_JSON,
  FRAME_JPEG,
  DISCOVERY_PORT,
  DEFAULT_PORT
}
