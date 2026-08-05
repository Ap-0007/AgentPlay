const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { CastService } = require('../electron/cast-service')

function getLanIpForTest() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item && item.family === 'IPv4' && !item.internal) return item.address
    }
  }
  return '127.0.0.1'
}

// 模拟一台 DLNA 电视：SSDP 应答 + 设备描述 + AVTransport 控制端点 + 像真电视一样按 URL 拉媒体
function startMockRenderer() {
  const calls = []
  let mediaFetchResult = null
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/desc.xml') {
      res.writeHead(200, { 'Content-Type': 'text/xml' })
      res.end('<?xml version="1.0"?><root><device><friendlyName>测试电视</friendlyName><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/ctrl</controlURL></service></serviceList></device></root>')
      return
    }
    if (req.url === '/ctrl' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        calls.push({ action: String(req.headers.soapaction || ''), body })
        if (body.includes('GetTransportInfo')) {
          res.writeHead(200, { 'Content-Type': 'text/xml' })
          res.end('<s:Envelope><s:Body><u:GetTransportInfoResponse><CurrentTransportState>PLAYING</CurrentTransportState></u:GetTransportInfoResponse></s:Body></s:Envelope>')
          return
        }
        if (body.includes('SetAVTransportURI')) {
          const url = (/<CurrentURI>([^<]+)<\/CurrentURI>/.exec(body) || [])[1]
          if (url) {
            mediaFetchResult = new Promise((resolve) => {
              http.get(url.replace(/&amp;/g, '&'), { headers: { Range: 'bytes=0-3' } }, (r) => {
                const chunks = []
                r.on('data', (c) => chunks.push(c))
                r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks), contentRange: r.headers['content-range'] }))
              }).on('error', () => resolve(null))
            })
          }
        }
        res.writeHead(200, { 'Content-Type': 'text/xml' })
        res.end('<ok/>')
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    httpServer.listen(0, '0.0.0.0', () => {
      const port = httpServer.address().port
      const location = `http://${getLanIpForTest()}:${port}/desc.xml`
      const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      udp.on('error', () => {})
      udp.on('message', (msg, rinfo) => {
        if (!/M-SEARCH/i.test(msg.toString())) return
        const resp = Buffer.from(`HTTP/1.1 200 OK\r\nLOCATION: ${location}\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n`)
        udp.send(resp, rinfo.port, rinfo.address)
      })
      udp.bind(1900, () => {
        try { udp.addMembership('239.255.255.250') } catch { /* 单网卡环境可能失败 */ }
      })
      resolve({ httpServer, udp, calls, mediaFetch: () => mediaFetchResult })
    })
  })
}

test('DIDL-Lite metadata carries protocolInfo and escaped fields', () => {
  const service = new CastService()
  const didl = service.buildDidlLite('http://192.168.1.2:18901/media/t/片&amp;名.mp4', '片&名.mp4', 'video/mp4')
  assert.match(didl, /protocolInfo="http-get:\*:video\/mp4:\*"/)
  assert.match(didl, /<dc:title>片&amp;名\.mp4<\/dc:title>/)
  assert.match(didl, /object\.item\.videoItem/)
})

test('full DLNA cast chain against a mock TV: scan, DIDL metadata, play, range fetch, stop', async (t) => {
  const mock = await startMockRenderer()
  t.after(() => {
    mock.httpServer.close()
    mock.udp.close()
    service.stop()
  })
  const service = new CastService()
  const devices = await service.scan()
  const tv = devices.find((d) => d.name === '测试电视')
  assert.ok(tv, `扫描应发现模拟电视，实际: ${JSON.stringify(devices)}`)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-'))
  const mediaPath = path.join(dir, '样片 #1.mp4')
  fs.writeFileSync(mediaPath, Buffer.from('0123456789abcdef'))
  const result = await service.cast(tv.id, mediaPath)
  assert.equal(result.success, true, JSON.stringify(result))

  const setUri = mock.calls.find((c) => c.body.includes('SetAVTransportURI'))
  assert.ok(setUri, '应发出 SetAVTransportURI')
  assert.match(setUri.body, /<CurrentURI>http:\/\/[^<]+\.mp4<\/CurrentURI>/)
  assert.ok(setUri.body.includes('DIDL-Lite'), '元数据必须带 DIDL-Lite（不少电视拒绝空元数据）')
  assert.ok(setUri.body.includes('http-get:*:video/mp4:*'))
  assert.ok(mock.calls.some((c) => c.body.includes('<u:Play')), 'SetURI 成功后应发 Play')

  const fetched = await mock.mediaFetch()
  assert.ok(fetched, '电视应回拉媒体')
  assert.equal(fetched.status, 206)
  assert.deepEqual(fetched.body.toString(), '0123')
  assert.match(fetched.contentRange, /^bytes 0-3\/16$/)

  const stopped = await service.stopCast(tv.id)
  assert.equal(stopped.success, true)
  assert.ok(mock.calls.some((c) => c.body.includes('<u:Stop')), '停止投屏应发 Stop')
})

test('cast stop wiring: main IPC, preload bridge and library stop button exist', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const library = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MediaLibrary.tsx'), 'utf8')
  assert.ok(main.includes("ipcMain.handle('cast:stop'"))
  assert.ok(preload.includes("invoke('cast:stop'"))
  assert.match(library, /停止投屏/)
  assert.match(library, /stopCastNow/)
})

test('smart discovery: last-success device is remembered, badged and cached for controls', async (t) => {
  const mock = await startMockRenderer()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-cache-'))
  const stateFile = path.join(dir, 'cast-last.json')
  const service = new CastService({ stateFile })
  t.after(() => {
    mock.httpServer.close()
    mock.udp.close()
    service.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const mediaPath = path.join(dir, '片.mp4')
  fs.writeFileSync(mediaPath, Buffer.from('0123456789abcdef'))
  const devices = await service.scan()
  const tv = devices.find((d) => d.name === '测试电视')
  const result = await service.cast(tv.id, mediaPath)
  assert.equal(result.success, true)

  // 成功设备已落盘记忆
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(saved.name, '测试电视')
  assert.ok(saved.location && saved.controlUrl)

  // 新实例读到记忆：扫描置顶打标
  const service2 = new CastService({ stateFile })
  t.after(() => service2.stop())
  assert.equal(service2.lastSuccess.name, '测试电视')
  const devices2 = await service2.scan()
  const tv2 = devices2.find((d) => d.name === '测试电视')
  assert.equal(tv2.lastSuccess, true, '上次成功设备必须打标')
  assert.equal(devices2[0].lastSuccess, true, '上次成功设备必须置顶')

  // 缓存兜底：不扫描也能控制
  const paused = await service2.pauseCast('last')
  assert.equal(paused.success, true)
  assert.ok(mock.calls.some((c) => c.body.includes('<u:Pause')), '暂停必须发 Pause')
  const resumed = await service2.resumeCast('last')
  assert.equal(resumed.success, true)
  const sought = await service2.seekCast('last', 95)
  assert.equal(sought.success, true)
  assert.ok(mock.calls.some((c) => c.body.includes('<Target>00:01:35</Target>')), 'seek 必须换算成 hh:mm:ss')
  const status = await service2.getStatus('last')
  assert.equal(status.success, true)
  assert.equal(status.label, '播放中')
})

test('cast wiring: control IPC and preload bridge exist', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  for (const verb of ['cast:pause', 'cast:resume', 'cast:seek', 'cast:status']) {
    assert.ok(main.includes(`ipcMain.handle('${verb}'`), verb)
    assert.ok(preload.includes(`invoke('${verb}'`), verb)
  }
  const library = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MediaLibrary.tsx'), 'utf8')
  assert.match(library, /上次成功/)
  assert.match(library, /pauseCastNow|resumeCastNow/)
})

test('firewall one-time allow: check + elevated rule add wired, only our cast port', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const library = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MediaLibrary.tsx'), 'utf8')
  assert.match(main, /cast:ensure-firewall/)
  assert.match(main, /cast:allow-firewall/)
  assert.match(main, /LocalPort 18901/, '只放行投屏端口')
  assert.match(main, /Start-Process powershell -Verb RunAs/, '提权加规则（一次 UAC，用户可见可控）')
  assert.match(preload, /ensureFirewall/)
  assert.match(preload, /allowFirewall/)
  assert.match(library, /现在放行/)
  assert.match(library, /needFirewall/)
})

test('smart cast: unified scan merges DLNA and AgentPlay devices, panel one-tap wired', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const sidebar = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Sidebar.tsx'), 'utf8')
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'SmartCastPanel.tsx'), 'utf8')
  assert.match(main, /cast:smart-scan/)
  assert.match(main, /castService\.scan\(\)\.catch/, 'DLNA 扫描失败不得拖垮 AgentPlay 发现')
  assert.match(main, /mirrorDiscovery = new MirrorDiscovery/, 'AgentPlay 设备必须同扫')
  assert.match(preload, /smartScan/)
  assert.match(sidebar, /onOpenSmartCast/, '侧栏投屏直连智能面板')
  assert.match(panel, /kind === 'tv'/)
  assert.match(panel, /startSender/, 'AgentPlay 设备走屏幕镜像')
  assert.match(panel, /openAny/, '没在播视频时一键选文件')
  assert.match(panel, /上次成功/)
})
