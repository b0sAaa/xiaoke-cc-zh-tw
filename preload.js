const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('xk', {
  setIgnore: v => ipcRenderer.send('set-ignore', v),
  probeNow: () => ipcRenderer.send('probe-now'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragRun: () => ipcRenderer.send('drag-run'),
  moveEnd: () => ipcRenderer.send('move-end'),
  menu: () => ipcRenderer.send('menu'),
  lines: () => ipcRenderer.invoke('lines'),
  mask: () => ipcRenderer.invoke('mask'),
  quickOpen: () => ipcRenderer.send('quick-open'),
  quickSubmit: t => ipcRenderer.send('quick-submit', t),
  quickClose: () => ipcRenderer.send('quick-close'),
  calibrate: pct => ipcRenderer.send('calibrate', pct),
  on: (ch, fn) => ipcRenderer.on(ch, (e, d) => fn(d)),
})
