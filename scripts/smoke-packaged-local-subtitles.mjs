import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const mediaArg = process.argv.slice(2).find((value) => value.startsWith('--media='))
const screenshotArg = process.argv.slice(2).find((value) => value.startsWith('--screenshot='))
const skipAuthorize = process.argv.includes('--skip-authorize')
const verifyUi = process.argv.includes('--verify-ui')
const verifyPlayerOnly = process.argv.includes('--verify-player-only')
const verifyCancel = process.argv.includes('--verify-cancel')
const verifyRecovery = process.argv.includes('--verify-recovery')
const useAdjacentSubtitle = process.argv.includes('--adjacent-subtitle')
const executable = executableArg
  ? path.resolve(executableArg.slice('--exe='.length))
  : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ai-player', 'AgentPlay.exe')
const userData = path.join(process.env.APPDATA || '', 'ai-player')
const helper = path.join(path.dirname(executable), 'resources', 'bin', 'win', 'ai-player-voice.exe')
const ffmpeg = path.join(userData, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin', 'ffmpeg.exe')
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-local-subtitles-'))
const textPath = path.join(fixtureDir, 'speech.txt')
const audioPath = path.join(fixtureDir, 'speech.wav')
const videoPath = mediaArg ? path.resolve(mediaArg.slice('--media='.length)) : path.join(fixtureDir, 'english-video.mp4')
// Use a per-process port: a killed Electron verifier can leave the fixed
// DevTools port in a stale Windows TCP state and make the next run attach to it.
const port = 20000 + (process.pid % 20000)

for (const required of [executable, helper, ffmpeg]) {
  if (!fs.existsSync(required)) throw new Error(`missing installed component: ${required}`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function makeFixture() {
  if (mediaArg) {
    if (!fs.existsSync(videoPath)) throw new Error(`missing supplied media: ${videoPath}`)
    return
  }
  const speech = 'Welcome to Agent Play. This is an English subtitle test. Artificial intelligence helps people understand videos.'
  fs.writeFileSync(textPath, `\uFEFF${speech}`, 'utf16le')
  await runFile(helper, [textPath, audioPath, '-2'], { windowsHide: true })
  await runFile(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x111827:s=640x360:r=25',
    '-i', audioPath,
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', '+faststart', '-y', videoPath
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 10_000) throw new Error('failed to create English video fixture')
  if (useAdjacentSubtitle || verifyCancel) {
    const adjacentPath = path.join(path.dirname(videoPath), `${path.parse(videoPath).name}.srt`)
    const cues = verifyCancel
      ? Array.from({ length: 160 }, (_, index) => {
          const start = index * 0.25
          const end = start + 0.24
          const stamp = (value) => `00:00:${String(Math.floor(value)).padStart(2, '0')},${String(Math.round((value % 1) * 1000)).padStart(3, '0')}`
          return `${index + 1}\n${stamp(start)} --> ${stamp(end)}\nSubtitle cancellation integration fixture line ${index + 1}.`
        })
      : [
          '1\n00:00:00,000 --> 00:00:06,000\nWelcome to Agent Play. This is an English subtitle test. Artificial intelligence helps people understand videos and complete their work more efficiently.'
        ]
    fs.writeFileSync(adjacentPath, `${cues.join('\n\n')}\n`, 'utf8')
  }
}

async function openSession() {
  const { spawn } = await import('node:child_process')
  const launchArgs = [
    `--remote-debugging-port=${port}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-position=-2400,-2400'
  ]
  if (verifyRecovery) launchArgs.push(`--user-data-dir=${path.join(fixtureDir, 'isolated-profile')}`)
  const child = spawn(executable, launchArgs, { cwd: path.dirname(executable), windowsHide: true, shell: false })

  let page
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) throw new Error(`installed app exited early: ${child.exitCode}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      page = pages.find((item) => item.type === 'page' && (/\/dist\/index\.html(?:$|[?#])/.test(item.url || '') || /^http:\/\/localhost:5173\/?/.test(item.url || '')))
      if (page?.webSocketDebuggerUrl) break
    } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('installed app did not expose its verification page within 60 seconds')

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
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'page expression failed')
    return response.result?.value
  }

  await command('Runtime.enable')
  await command('Page.enable')
  let rendererReady = false
  for (let attempt = 0; attempt < 240; attempt++) {
    if (await evaluate(`document.readyState === 'complete' && Boolean(window.aiPlayer?.subtitleBilingual?.generate) && Boolean(document.querySelector('#root')?.children.length)`)) {
      rendererReady = true
      break
    }
    await delay(250)
  }
  if (!rendererReady) throw new Error('main renderer did not become ready within 60 seconds')
  // The preload bridge can be ready before React effects have registered the
  // ai-player-play-file listener on a heavily loaded Windows machine.
  await delay(2000)
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

let session
try {
  await makeFixture()
  session = await openSession()
  if (verifyPlayerOnly) {
    const playerResult = await session.evaluate(`(async () => {
      window.aiPlayer.menu.confirmOpenFile(${JSON.stringify(videoPath)})
      window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: ${JSON.stringify(videoPath)} }))
      let video = null
      for (let attempt = 0; attempt < 240; attempt++) {
        video = document.querySelector('video[data-ai-player-video="true"]')
        if (video?.videoWidth > 0 && video?.videoHeight > 0) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (!video?.videoWidth) return { success: false, reason: 'video metadata unavailable' }
      await new Promise((resolve) => setTimeout(resolve, 3500))
      const progress = document.querySelector('[data-player-chrome="true"] input[type="range"][max]')
      const controls = progress?.closest('[data-player-chrome="true"]')
      const controlsOpacity = controls ? getComputedStyle(controls).opacity : ''
      const controlsColor = controls ? getComputedStyle(controls).color : ''
      const controlsZIndex = controls ? getComputedStyle(controls).zIndex : ''
      const controlsRect = controls?.getBoundingClientRect()
      const controlsHit = controlsRect
        ? document.elementFromPoint(controlsRect.left + controlsRect.width / 2, controlsRect.top + controlsRect.height / 2)
        : null
      const controlsAreTopmost = Boolean(controls && controlsHit && controls.contains(controlsHit))
      const objectFit = getComputedStyle(video).objectFit
      const topbar = document.querySelector('.workspace-topbar')
      const title = document.querySelector('.workspace-topbar-title strong')
      const journey = document.querySelector('.workspace-journey')
      const titleStyle = title ? getComputedStyle(title) : null
      const titleRect = title?.getBoundingClientRect()
      const journeyRect = journey?.getBoundingClientRect()
      const titleIsContained = Boolean(
        topbar && title && titleRect &&
        topbar.scrollWidth <= topbar.clientWidth &&
        titleStyle?.overflow === 'hidden' &&
        titleStyle?.textOverflow === 'ellipsis' &&
        (!journeyRect || titleRect.right <= journeyRect.left)
      )
      return {
        success: video.videoWidth === 720 && video.videoHeight === 960 && video.dataset.pictureMode === 'fit' && objectFit === 'contain' && controlsOpacity === '1' && controlsColor === 'rgb(248, 250, 252)' && controlsAreTopmost && titleIsContained,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        clientWidth: video.clientWidth,
        clientHeight: video.clientHeight,
        pictureMode: video.dataset.pictureMode,
        objectFit,
        controlsOpacity,
        controlsColor,
        controlsZIndex,
        controlsAreTopmost,
        controlsRect: controlsRect ? { left: controlsRect.left, top: controlsRect.top, width: controlsRect.width, height: controlsRect.height, bottom: controlsRect.bottom } : null,
        controlsHit: controlsHit ? controlsHit.tagName.toLowerCase() + (controlsHit.className ? '.' + String(controlsHit.className).trim().replace(/\s+/g, '.') : '') : '',
        controlsText: controls?.innerText || '',
        titleIsContained,
        titleClientWidth: title?.clientWidth || 0,
        titleScrollWidth: title?.scrollWidth || 0,
        topbarClientWidth: topbar?.clientWidth || 0,
        topbarScrollWidth: topbar?.scrollWidth || 0,
        titleRight: titleRect?.right || 0,
        journeyLeft: journeyRect?.left || 0
      }
    })()`, true)
    if (screenshotArg) {
      const screenshotPath = path.resolve(screenshotArg.slice('--screenshot='.length))
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
      const shot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'))
    }
    if (!playerResult?.success) throw new Error(`installed player experience failed: ${JSON.stringify(playerResult)}`)
    process.stdout.write(`${JSON.stringify({ version: await session.evaluate('window.aiPlayer.version'), videoPath, playerResult }, null, 2)}\n`)
  } else if (verifyRecovery) {
    const recoveryResult = await session.evaluate(`(async () => {
      window.aiPlayer.menu.confirmOpenFile(${JSON.stringify(videoPath)})
      window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: ${JSON.stringify(videoPath)} }))
      for (let attempt = 0; attempt < 240; attempt++) {
        if (document.querySelector('video[data-ai-player-video="true"]')) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'bilingual-subtitle' }))
      let card = null
      for (let attempt = 0; attempt < 240; attempt++) {
        card = document.querySelector('[data-subtitle-recovery="true"]')
        if (card) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      const action = card ? Array.from(card.querySelectorAll('button')).find((button) => /安装并继续/.test(button.textContent || '')) : null
      window.dispatchEvent(new CustomEvent('ai-player-open-model-center', {
        detail: { providerId: 'agnes', model: 'agnes-2.5-flash', reason: '字幕恢复验收' }
      }))
      let intentBanner = null
      let agnesSelected = false
      for (let attempt = 0; attempt < 240; attempt++) {
        intentBanner = document.querySelector('[data-model-center-intent="subtitle-translation"]')
        agnesSelected = Array.from(document.querySelectorAll('select')).some((select) => select.value === 'agnes')
        if (intentBanner && agnesSelected) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return {
        success: Boolean(card && card.dataset.recoveryKind === 'install-whisper' && action && /本地免费/.test(card.textContent || '') && /不上传/.test(card.textContent || '') && intentBanner && agnesSelected && /字幕翻译只发送字幕原文/.test(intentBanner.textContent || '')),
        kind: card?.dataset.recoveryKind || '',
        text: card?.textContent || '',
        actionText: action?.textContent || '',
        hasFullScreenModal: Boolean(document.querySelector('.fixed.inset-0[data-subtitle-recovery]')),
        agnesSelected,
        modelIntentText: intentBanner?.textContent || ''
      }
    })()`, true)
    if (screenshotArg) {
      const screenshotPath = path.resolve(screenshotArg.slice('--screenshot='.length))
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
      const shot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'))
    }
    if (!recoveryResult?.success || recoveryResult.hasFullScreenModal) throw new Error(`installed subtitle recovery card failed: ${JSON.stringify(recoveryResult)}`)
    process.stdout.write(`${JSON.stringify({ version: await session.evaluate('window.aiPlayer.version'), videoPath, recoveryResult }, null, 2)}\n`)
  } else if (verifyCancel) {
    const cancelResult = await session.evaluate(`(async () => {
      const statuses = []
      const requestId = 'installed-subtitle-cancel-smoke'
      const unsubscribe = window.aiPlayer.subtitleBilingual.onStatus((event) => {
        if (event.requestId === requestId) statuses.push(event.status)
      })
      window.aiPlayer.menu.confirmOpenFile(${JSON.stringify(videoPath)})
      try {
        const generation = window.aiPlayer.subtitleBilingual.generate({
          path: ${JSON.stringify(videoPath)},
          requestId,
          engine: 'local'
        })
        for (let attempt = 0; attempt < 240; attempt++) {
          if (statuses.some((status) => /正在翻译成/.test(status))) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const cancelHandled = await window.aiPlayer.subtitleBilingual.cancel(requestId)
        const output = await generation
        return { cancelHandled, output, statuses, cancelBridge: typeof window.aiPlayer.subtitleBilingual.cancel === 'function' }
      } finally {
        unsubscribe()
      }
    })()`, true)
    if (!cancelResult?.cancelBridge || !cancelResult.cancelHandled || !cancelResult.output?.cancelled || cancelResult.output?.success) {
      throw new Error(`installed subtitle cancellation failed: ${JSON.stringify(cancelResult)}`)
    }
    process.stdout.write(`${JSON.stringify({ version: await session.evaluate('window.aiPlayer.version'), videoPath, cancelResult }, null, 2)}\n`)
  } else if (verifyUi) {
    const uiResult = await session.evaluate(`(async () => {
      const statuses = []
      const unsubscribe = window.aiPlayer.subtitleBilingual.onStatus((event) => statuses.push(event.status))
      window.aiPlayer.menu.confirmOpenFile(${JSON.stringify(videoPath)})
      window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: ${JSON.stringify(videoPath)} }))
      try {
        for (let attempt = 0; attempt < 240; attempt++) {
          if (document.querySelector('video[data-ai-player-video="true"]')) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        const video = document.querySelector('video[data-ai-player-video="true"]')
        if (!video) return { success: false, reason: 'player video element was not mounted', statuses }
        window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'bilingual-subtitle' }))
        let track = null
        for (let attempt = 0; attempt < 960; attempt++) {
          track = document.querySelector('video[data-ai-player-video="true"] track[kind="subtitles"]')
          if (track?.track?.cues?.length) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        if (!track) return { success: false, reason: 'subtitle track element was never mounted within 240 seconds', statuses, visibleText: document.body.innerText.slice(-1200) }
        const cues = Array.from(track.track.cues || [])
        if (cues.length) {
          video.currentTime = Math.max(0, (cues[0].startTime + cues[0].endTime) / 2)
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        const activeCueCount = track.track.activeCues?.length || 0
        const cueTexts = cues.map((cue) => cue.text || '')
        const maxCueLines = Math.max(0, ...cueTexts.map((value) => value.split('\\n').length))
        const maxCueLineChars = Math.max(0, ...cueTexts.flatMap((value) => value.split('\\n').map((line) => Array.from(line).length)))
        const containsSourceText = cueTexts.some((value) => value.includes('Welcome to Agent Play'))
        const brandMarkPresent = Boolean(document.querySelector('[aria-label="AgentPlay 首页"] svg'))
        const initialCueLine = Number(cues[0]?.line)
        const upButton = document.querySelector('button[title="字幕上移"]')
        const downButton = document.querySelector('button[title="字幕下移"]')
        const moveButton = upButton && !upButton.disabled ? upButton : downButton
        moveButton?.click()
        await new Promise((resolve) => setTimeout(resolve, 250))
        const movedCueLine = Number(cues[0]?.line)
        await new Promise((resolve) => setTimeout(resolve, 3500))
        const progress = document.querySelector('[data-player-chrome="true"] input[type="range"][max]')
        const controls = progress?.closest('[data-player-chrome="true"]')
        const controlsOpacity = controls ? getComputedStyle(controls).opacity : ''
        const controlsColor = controls ? getComputedStyle(controls).color : ''
        const objectFit = getComputedStyle(video).objectFit
        return {
          success: document.title === 'AgentPlay' && brandMarkPresent && track.track.mode === 'showing' && cues.length > 0 && activeCueCount > 0 && maxCueLines <= 2 && maxCueLineChars <= 16 && !containsSourceText && video.dataset.pictureMode === 'fit' && objectFit === 'contain' && controlsOpacity === '1' && controlsColor === 'rgb(248, 250, 252)' && Boolean(moveButton) && movedCueLine !== initialCueLine,
          pageTitle: document.title,
          brandMarkPresent,
          trackMode: track.track.mode,
          cueCount: cues.length,
          firstCue: cues[0]?.text || '',
          activeCueCount,
          maxCueLines,
          maxCueLineChars,
          containsSourceText,
          pictureMode: video.dataset.pictureMode,
          objectFit,
          controlsOpacity,
          controlsColor,
          initialCueLine,
          movedCueLine,
          hasSubtitleMoveButtons: Boolean(upButton && downButton),
          trackLang: track.srclang,
          trackLabel: track.label,
          readyState: track.readyState,
          subtitleButtonText: Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '字幕')?.textContent || '',
          statuses,
          visibleText: document.body.innerText.slice(-1200)
        }
      } finally {
        unsubscribe()
      }
    })()`, true)
    if (screenshotArg) {
      const screenshotPath = path.resolve(screenshotArg.slice('--screenshot='.length))
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
      const shot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'))
    }
    if (!uiResult?.success) throw new Error(`installed subtitle visibility failed: ${JSON.stringify(uiResult)}`)
    if (!/[\u3400-\u9fff]/.test(uiResult.firstCue || '')) throw new Error(`visible subtitle cue has no Chinese translation: ${JSON.stringify(uiResult)}`)
    process.stdout.write(`${JSON.stringify({ version: await session.evaluate('window.aiPlayer.version'), videoPath, uiResult }, null, 2)}\n`)
    process.exitCode = 0
  } else {
    const result = await session.evaluate(`(async () => {
    const statuses = []
    const unsubscribe = window.aiPlayer.subtitleBilingual.onStatus((event) => statuses.push(event.status))
    if (!${JSON.stringify(skipAuthorize)}) {
      window.aiPlayer.menu.confirmOpenFile(${JSON.stringify(videoPath)})
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    try {
      const output = await window.aiPlayer.subtitleBilingual.generate({
        path: ${JSON.stringify(videoPath)},
        requestId: 'installed-local-subtitle-smoke'
      })
      return { output, statuses, version: window.aiPlayer.version }
    } finally {
      unsubscribe()
    }
  })()`, true)

    if (!result?.output?.success) throw new Error(result?.output?.error || 'installed subtitle generation failed')
    const srtPath = path.resolve(result.output.srtPath || '')
    const expectedOutputDir = path.resolve(path.dirname(videoPath))
    if (!srtPath.startsWith(expectedOutputDir + path.sep) || !fs.existsSync(srtPath)) throw new Error('subtitle output escaped the media directory or is missing')
    const srt = fs.readFileSync(srtPath, 'utf8')
    if (!/[A-Za-z]{4}/.test(srt)) throw new Error('generated subtitle has no English source text')
    if (!/[\u3400-\u9fff]/.test(srt)) throw new Error('generated subtitle has no Chinese translation')
    process.stdout.write(`${JSON.stringify({
      version: result.version,
      videoBytes: fs.statSync(videoPath).size,
      output: result.output,
      statuses: result.statuses,
      subtitleBytes: Buffer.byteLength(srt),
      hasEnglish: true,
      hasChinese: true
    }, null, 2)}\n`)
  }
} finally {
  if (session) await closeSession(session)
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  const resolvedFixture = path.resolve(fixtureDir)
  if (resolvedFixture.startsWith(tempRoot) && path.basename(resolvedFixture).startsWith('agentplay-local-subtitles-')) {
    fs.rmSync(resolvedFixture, { recursive: true, force: true })
  }
}
