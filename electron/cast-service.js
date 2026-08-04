const dgram = require('dgram')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

function xmlEscapeLite(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

class CastService {
  constructor({ stateFile = null } = {}) {
    this.devices = []
    this.fileServer = null
    this.fileServerPort = 18901
    this.servedFiles = new Map()
    this.stateFile = stateFile
    this.lastSuccess = this.loadLastSuccess()
  }

  loadLastSuccess() {
    if (!this.stateFile) return null
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      return data && data.location ? data : null
    } catch {
      return null
    }
  }

  saveLastSuccess(device) {
    this.lastSuccess = { name: device.name, location: device.location, controlUrl: device.controlUrl, at: new Date().toISOString() }
    if (!this.stateFile) return
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
      fs.writeFileSync(this.stateFile, JSON.stringify(this.lastSuccess), 'utf8')
    } catch { /* 缓存失败不影响投屏 */ }
  }

  getLanIp() {
    return require('./utils').getLanIp()
  }

  scan() {
    return new Promise((resolve) => {
      this.devices = []
      const seen = new Set()
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      // 双 ST：很多电视只回 ssdp:all；双轮：慢设备第二轮才回得来
      const targets = ['ssdp:all', 'urn:schemas-upnp-org:device:MediaRenderer:1']
      const send = (st) => socket.send(
        'M-SEARCH * HTTP/1.1\r\n' +
        'HOST: 239.255.255.250:1900\r\n' +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        `ST: ${st}\r\n\r\n`,
        1900, '239.255.255.250'
      )
      socket.on('error', () => {})
      socket.bind(() => {
        socket.setBroadcast(true)
        targets.forEach(send)
        setTimeout(() => targets.forEach(send), 1500)
      })
      socket.on('message', async (data) => {
        const text = data.toString()
        const locMatch = text.match(/LOCATION: (.+)\r?\n/i)
        if (!locMatch) return
        const usn = (text.match(/USN: (.+)\r?\n/i)?.[1] || locMatch[1]).trim()
        if (seen.has(usn)) return
        seen.add(usn)
        const location = locMatch[1].trim()
        const device = await this.parseDevice(location)
        if (device && !this.devices.find((d) => d.id === location)) {
          if (this.lastSuccess && this.lastSuccess.location === location) device.lastSuccess = true
          this.devices.push(device)
        }
      })
      setTimeout(() => {
        socket.close()
        this.devices.sort((a, b) => Number(Boolean(b.lastSuccess)) - Number(Boolean(a.lastSuccess)))
        resolve(this.devices)
      }, 4500)
    })
  }

  async parseDevice(location) {
    try {
      const resp = await fetch(location, { signal: AbortSignal.timeout(5000) })
      const xml = await resp.text()
      const nameMatch = xml.match(/<friendlyName>([^<]+)<\/friendlyName>/)
      const ctrlMatch = xml.match(
        /<service>[\s\S]*?AVTransport[\s\S]*?<controlURL>([^<]+)<\/controlURL>[\s\S]*?<\/service>/
      )
      if (!ctrlMatch) return null
      const baseUrl = new URL(location)
      return {
        id: location,
        name: nameMatch ? nameMatch[1] : 'DLNA设备',
        location,
        controlUrl: new URL(ctrlMatch[1], baseUrl).toString()
      }
    } catch {
      return null
    }
  }

  async startFileServer() {
    if (this.fileServer) return
    this.fileServer = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, 'http://localhost')
      const match = requestUrl.pathname.match(/^\/media\/([a-f0-9-]+)\//i)
      const entry = match ? this.servedFiles.get(match[1]) : null
      if (!entry || entry.expiresAt < Date.now()) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const resolved = entry.path
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        res.writeHead(404)
        res.end()
        return
      }
      const stat = fs.statSync(resolved)
      const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
      const start = range && range[1] ? Number(range[1]) : 0
      const end = range && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
      if (start < 0 || end < start || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        res.end()
        return
      }
      const headers = {
        'Content-Length': end - start + 1,
        'Content-Type': this.mimeType(resolved),
        'Accept-Ranges': 'bytes'
      }
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
      res.writeHead(range ? 206 : 200, headers)
      if (req.method === 'HEAD') res.end()
      else fs.createReadStream(resolved, { start, end }).pipe(res)
    })
    this.fileServerPort = await require('./utils').listenWithFallback(this.fileServer, this.fileServerPort)
  }

  mimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase()
    return ({
      '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
      '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
      '.wav': 'audio/wav', '.m4a': 'audio/mp4'
    })[ext] || 'application/octet-stream'
  }

  registerFile(filePath) {
    const resolved = path.resolve(filePath)
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error('投屏文件不存在')
    }
    const token = crypto.randomUUID()
    this.servedFiles.set(token, { path: resolved, expiresAt: Date.now() + 12 * 60 * 60 * 1000 })
    return `http://${this.getLanIp()}:${this.fileServerPort}/media/${token}/${encodeURIComponent(path.basename(resolved))}`
  }

  // 不少电视拒绝空元数据：DIDL-Lite 里带 protocolInfo 的 res 才肯播
  buildDidlLite(mediaUrl, title, mime) {
    return (
      '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
      '<item id="0" parentID="-1" restricted="1">' +
      `<dc:title>${xmlEscapeLite(title)}</dc:title>` +
      `<res protocolInfo="http-get:*:${mime}:*">${xmlEscapeLite(mediaUrl)}</res>` +
      '<upnp:class>object.item.videoItem</upnp:class>' +
      '</item></DIDL-Lite>'
    )
  }

  async cast(deviceId, filePath, { positionSeconds = 0 } = {}) {
    const device = this.devices.find((d) => d.id === deviceId)
    if (!device) {
      return { success: false, error: '设备未找到，请先扫描' }
    }
    await this.startFileServer()
    let mediaUrl
    try {
      mediaUrl = this.registerFile(filePath)
    } catch (e) {
      return { success: false, error: String(e) }
    }
    const xmlMediaUrl = mediaUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const didl = this.buildDidlLite(mediaUrl, path.basename(filePath), this.mimeType(filePath))
    const xmlDidl = didl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const body =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body>' +
      '<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' +
      '<InstanceID>0</InstanceID>' +
      `<CurrentURI>${xmlMediaUrl}</CurrentURI>` +
      `<CurrentURIMetaData>${xmlDidl}</CurrentURIMetaData>` +
      '</u:SetAVTransportURI></s:Body></s:Envelope>'
    try {
      const resp = await fetch(device.controlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"'
        },
        body,
        signal: AbortSignal.timeout(15000)
      })
      if (resp.ok) {
        const playBody = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play></s:Body></s:Envelope>'
        const playResp = await fetch(device.controlUrl, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: '"urn:schemas-upnp-org:service:AVTransport:1#Play"' }, body: playBody, signal: AbortSignal.timeout(15000) })
        if (!playResp.ok) return { success: false, error: `设备已接收文件但播放失败（HTTP ${playResp.status}）` }
      }
      if (resp.ok) this.saveLastSuccess(device)
      // 定位续播（尽力而为）：电视普遍支持 REL_TIME seek，不支持就从头播
      if (resp.ok && Number(positionSeconds) > 5) {
        try { await this.seekCast(deviceId, positionSeconds) } catch { /* 不支持就从头播 */ }
      }
      return {
        success: resp.ok,
        action: resp.ok ? `已投屏到 ${device.name}` : `投屏失败 ${resp.status}`
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async pauseCast(deviceId) {
    const device = this.devices.find((d) => d.id === deviceId) || this.deviceFromCache(deviceId)
    if (!device) return { success: false, error: '设备未找到，请先扫描' }
    try {
      const resp = await this.soap(device, 'Pause', '')
      return { success: resp.ok, action: resp.ok ? `已暂停 ${device.name}` : `暂停失败 ${resp.status}` }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async resumeCast(deviceId) {
    const device = this.devices.find((d) => d.id === deviceId) || this.deviceFromCache(deviceId)
    if (!device) return { success: false, error: '设备未找到，请先扫描' }
    try {
      const resp = await this.soap(device, 'Play', '<Speed>1</Speed>')
      return { success: resp.ok, action: resp.ok ? `继续播放 ${device.name}` : `继续失败 ${resp.status}` }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async seekCast(deviceId, seconds) {
    const device = this.devices.find((d) => d.id === deviceId) || this.deviceFromCache(deviceId)
    if (!device) return { success: false, error: '设备未找到，请先扫描' }
    const total = Math.max(0, Math.round(Number(seconds) || 0))
    const hms = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60].map((n) => String(n).padStart(2, '0')).join(':')
    const resp = await this.soap(device, 'Seek', `<Unit>REL_TIME</Unit><Target>${hms}</Target>`)
    return { success: resp.ok, action: resp.ok ? `已定位到 ${hms}` : `定位失败 ${resp.status}` }
  }

  async getStatus(deviceId) {
    const device = this.devices.find((d) => d.id === deviceId) || this.deviceFromCache(deviceId)
    if (!device) return { success: false, error: '设备未找到' }
    try {
      const resp = await this.soap(device, 'GetTransportInfo', '')
      const text = await resp.text()
      const state = /<CurrentTransportState>([^<]+)<\/CurrentTransportState>/.exec(text)?.[1] || 'UNKNOWN'
      const label = { PLAYING: '播放中', PAUSED_PLAYBACK: '已暂停', STOPPED: '已停止', TRANSITIONING: '切换中', NO_MEDIA_PRESENT: '无媒体' }[state] || state
      return { success: true, state, label }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  deviceFromCache(deviceId) {
    if (this.lastSuccess && (deviceId === this.lastSuccess.location || deviceId === 'last')) {
      return { id: this.lastSuccess.location, name: this.lastSuccess.name, location: this.lastSuccess.location, controlUrl: this.lastSuccess.controlUrl }
    }
    return null
  }

  async soap(device, action, innerBody) {
    const body =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body>' +
      `<u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
      `<InstanceID>0</InstanceID>${innerBody}</u:${action}>` +
      '</s:Body></s:Envelope>'
    return fetch(device.controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`
      },
      body,
      signal: AbortSignal.timeout(15000)
    })
  }

  async stopCast(deviceId) {
    const device = this.devices.find((d) => d.id === deviceId) || this.deviceFromCache(deviceId)
    if (!device) return { success: false, error: '设备未找到，请先扫描' }
    try {
      const resp = await this.soap(device, 'Stop', '')
      return { success: resp.ok, action: resp.ok ? `已停止 ${device.name} 的播放` : `停止失败 ${resp.status}` }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  stop() {
    if (this.fileServer) this.fileServer.close()
    this.fileServer = null
    this.servedFiles.clear()
  }
}

module.exports = { CastService }
