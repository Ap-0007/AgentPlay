// 互投接收窗口的极简桥：只暴露逐帧画面通道
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mirrorView', {
  onFrame: (cb) => {
    const handler = (_event, base64) => cb(base64)
    ipcRenderer.on('mirror:frame', handler)
    return () => ipcRenderer.removeListener('mirror:frame', handler)
  }
})
