const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { UsageTracker } = require('./usage')

if (!app.requestSingleInstanceLock()) app.quit()

const W = 300
const H = 440
let curH = H // 目前視窗高度：氣泡顯示時會往上加高（底部不動），收起後還原
const cfgFile = () => path.join(app.getPath('userData'), 'config.json')
const DEFAULTS = {
  x: null, y: null, scale: 1, sound: true, volume: 0.5,
  turnBubble: true, turnSound: true, turnSeconds: 8,
  currency: 'USD', cnyRate: 7.1,
  followClaude: true,
  // 每週額度：週四 1:00 重置；weeklyBudget 為空時，用 calibrateUsedPct（當前已用百分比）自動反推
  resetDay: 4, resetHour: 1, weeklyBudget: null, calibrateUsedPct: null,
  useReal: true,    // 讀 Claude Code /usage 的官方額度（較準）
  showFive: false,  // 顯示 5 小時量槽
  showUsed: true,   // 量槽顯示「已用」（同 Claude）；false 則顯示「剩餘」
}
let cfg = { ...DEFAULTS }
try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) } } catch (e) { /* 首次啟動 */ }
const saveCfg = () => { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 1)) } catch (e) { /* ignore */ } }

let win
let tray
let tracker
let lastStats = null

// 最近一次重置時刻（本地時間 resetDay 星期幾 resetHour 點）
function periodStart(now = Date.now()) {
  const d = new Date(now)
  d.setHours(cfg.resetHour, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() - cfg.resetDay + 7) % 7))
  if (d.getTime() > now) d.setDate(d.getDate() - 7)
  return d.getTime()
}

// ---------- 官方額度：用 scripts/probe-usage.js 讀 Claude Code /usage 畫面 ----------
// 開一個隱藏的 claude 看一眼就關（約 4 秒、不花 token）。啟動時、每輪結束後（至少隔 5 分鐘）、點量槽時各讀一次。
const { spawn } = require('child_process')
const PROBE_GAP = 5 * 60e3
let real = null, probing = false, lastProbe = 0, probeTimer = null, probeErr = null
const realFile = () => path.join(app.getPath('userData'), 'real-usage.json')
try { real = JSON.parse(fs.readFileSync(realFile(), 'utf8')) } catch (e) { /* 還沒讀過 */ }

// 目前還有效（重置時間還沒過）的官方數字；沒有就回傳 null，畫面退回估算
function liveReal() {
  if (!cfg.useReal || !real) return null
  const pick = w => (w && w.resetsAt > Date.now()) ? { used: w.pct, resetsAt: w.resetsAt } : null
  const week = pick(real.week), five = pick(real.session)
  return week || five ? { at: real.at, week, five } : null
}

function probeUsage(force) {
  if (!cfg.useReal || probing) return
  const since = Date.now() - lastProbe
  if (force ? since < 20e3 : since < PROBE_GAP) {
    // 太頻繁就排一次延後的重讀，讓最後的數字一定會更新
    if (!force && !probeTimer) probeTimer = setTimeout(() => { probeTimer = null; probeUsage(false) }, PROBE_GAP - since + 500)
    return
  }
  probing = true
  lastProbe = Date.now()
  let out = ''
  const finish = () => {
    if (!probing) return
    probing = false
    try {
      const r = JSON.parse(out.trim().split(String.fromCharCode(10)).pop())
      if (r.ok) { real = r; probeErr = null; fs.writeFileSync(realFile(), JSON.stringify(r)); onRealUpdate() }
      else { probeErr = r.error; refreshStats() }
    } catch (e) { probeErr = '讀取失敗'; refreshStats() }
  }
  try {
    const child = spawn('node', [path.join(__dirname, 'scripts', 'probe-usage.js')], { windowsHide: true })
    child.stdout.on('data', d => { out += d })
    child.on('error', () => { probeErr = '找不到 node'; probing = false; refreshStats() })
    child.on('close', finish)
    setTimeout(() => { try { child.kill() } catch (e) { /* ignore */ } }, 40e3)
  } catch (e) { probing = false }
}

function refreshStats() {
  if (!tracker) return
  lastStats = withQuota(tracker.stats())
  send('stats', lastStats)
}

function onRealUpdate() {
  const w = real.week
  if (w) {
    // 重置時間直接跟官方一致（分鐘四捨五入到整點，例如 13:59 → 14:00）
    const d = new Date(w.resetsAt + 30 * 60e3)
    if (d.getDay() !== cfg.resetDay || d.getHours() !== cfg.resetHour) { cfg.resetDay = d.getDay(); cfg.resetHour = d.getHours() }
    // 順便用官方百分比校準估算，讀不到官方數字時退回估算也比較準
    if (tracker && w.pct >= 10) {
      const period = tracker.stats().period
      if (period > 0) cfg.weeklyBudget = Math.round(period / (w.pct / 100))
    }
    saveCfg()
  }
  refreshStats()
}

function withQuota(st) {
  if (!cfg.weeklyBudget && cfg.calibrateUsedPct && st.period > 0) {
    cfg.weeklyBudget = Math.round(st.period / (cfg.calibrateUsedPct / 100))
    cfg.calibrateUsedPct = null
    saveCfg()
  }
  return { ...st, budget: cfg.weeklyBudget, nextReset: periodStart() + 7 * 86400e3, rl: liveReal(), rlErr: cfg.useReal ? probeErr : null }
}

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data) }

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea
  // 存下來的位置如果已經不在任何螢幕內（拔了螢幕、拖到畫面外），就回到右下角
  const cx = (cfg.x ?? 0) + W / 2, cy = (cfg.y ?? 0) + H / 2
  const visible = cfg.x != null && cfg.y != null && screen.getAllDisplays().some(d => {
    const b = d.workArea
    return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height
  })
  const x = visible ? cfg.x : wa.x + wa.width - W - 20
  const y = visible ? cfg.y : wa.y + wa.height - H
  win = new BrowserWindow({
    width: W, height: H, x, y,
    frame: false, transparent: true, resizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadFile('index.html')
  win.webContents.on('did-finish-load', () => {
    send('config', cfg)
    if (lastStats) send('stats', lastStats)
  })
}

function setCfg(patch) {
  Object.assign(cfg, patch)
  saveCfg()
  send('config', cfg)
  rebuildTray()
}

const DAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']
// 改額度重置時間：存設定、用新的週期重算本週已花，馬上更新量槽
function setReset(patch) {
  setCfg(patch)
  if (tracker) { lastStats = withQuota(tracker.stats()); send('stats', lastStats) }
}

function menuTemplate() {
  const autostart = app.getLoginItemSettings(loginArgs()).openAtLogin
  return [
    { label: '看看賬本', click: () => send('show-stats') },
    { label: '問 Claude…（雙擊小克）', click: () => openQuick() },
    // 讀得到官方數字時會自動校準估算，這項只在讀不到時才需要
    { label: '校準每週額度…', visible: !liveReal(), click: () => send('calibrate-ui') },
    { label: '讀取官方額度（Claude Code /usage）', type: 'checkbox', checked: cfg.useReal, click: m => { setCfg({ useReal: m.checked }); if (m.checked) probeUsage(true); else refreshStats() } },
    { label: '顯示 5 小時量槽', type: 'checkbox', checked: cfg.showFive, click: m => setCfg({ showFive: m.checked }) },
    {
      label: '量槽顯示方式', submenu: [
        { label: '已用（同 Claude）', type: 'radio', checked: cfg.showUsed !== false, click: () => setCfg({ showUsed: true }) },
        { label: '剩餘', type: 'radio', checked: cfg.showUsed === false, click: () => setCfg({ showUsed: false }) },
      ],
    },
    { label: '立即更新官方額度', enabled: cfg.useReal, click: () => probeUsage(true) },
    {
      label: `額度重置時間（${DAYS[cfg.resetDay]} ${String(cfg.resetHour).padStart(2, '0')}:00）`, submenu: [
        { label: '星期', submenu: DAYS.map((n, i) => ({ label: n, type: 'radio', checked: cfg.resetDay === i, click: () => setReset({ resetDay: i }) })) },
        { label: '時間', submenu: Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, '0')}:00`, type: 'radio', checked: cfg.resetHour === h, click: () => setReset({ resetHour: h }) })) },
      ],
    },
    { label: '戳一下', click: () => send('poke') },
    { type: 'separator' },
    {
      label: '大小', submenu: [0.7, 0.85, 1, 1.2, 1.4].map(s => ({
        label: `${Math.round(s * 100)}%`, type: 'radio', checked: cfg.scale === s, click: () => setCfg({ scale: s }),
      })),
    },
    {
      label: '貨幣', submenu: [
        { label: '美元 $', type: 'radio', checked: cfg.currency === 'USD', click: () => setCfg({ currency: 'USD' }) },
        { label: `人民幣 ¥（匯率 ${cfg.cnyRate}）`, type: 'radio', checked: cfg.currency === 'CNY', click: () => setCfg({ currency: 'CNY' }) },
      ],
    },
    { label: '按壓音效', type: 'checkbox', checked: cfg.sound, click: m => setCfg({ sound: m.checked }) },
    { label: '每輪結束冒泡', type: 'checkbox', checked: cfg.turnBubble, click: m => setCfg({ turnBubble: m.checked }) },
    { label: '每輪結束提示音', type: 'checkbox', checked: cfg.turnSound, click: m => setCfg({ turnSound: m.checked }) },
    { label: '跟著 Claude Code 開關', type: 'checkbox', checked: cfg.followClaude, click: m => setCfg({ followClaude: m.checked }) },
    { label: '開機自啟', type: 'checkbox', checked: autostart, click: m => { app.setLoginItemSettings({ ...loginArgs(), openAtLogin: m.checked }); rebuildTray() } },
    { type: 'separator' },
    { label: '編輯臺詞 (lines.json)', click: () => shell.openPath(path.join(__dirname, 'lines.json')) },
    { label: '編輯價格 (pricing.json)', click: () => shell.openPath(path.join(__dirname, 'pricing.json')) },
    { label: '重新載入臺詞和價格', click: () => { tracker.loadPricing(); tracker.entries = {}; tracker.files = {}; tracker.live = false; tracker.scan(); send('reload-lines') } },
    { label: '回到右下角', click: () => { const wa = screen.getPrimaryDisplay().workArea; curH = H; win.setBounds({ x: wa.x + wa.width - W - 20, y: wa.y + wa.height - H, width: W, height: H }); setCfg({ x: null, y: null }) } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]
}

function loginArgs() {
  // 開發模式下 execPath 是 electron.exe，需要把應用目錄作為引數傳進去
  return app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(__dirname)] }
}

function rebuildTray() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()))
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'xiaoke1.png')).resize({ width: 16, height: 16 })
  tray = new Tray(img)
  tray.setToolTip('小克 · Claude Code 記賬')
  tray.on('click', () => { win.show(); send('poke') })
  rebuildTray()
}

// ---------- 雙擊小克：仿 Claude 快捷輸入框，回車後交給 Claude 桌面版開新對話 ----------
let quick = null
function openQuick() {
  if (quick && !quick.isDestroyed()) { quick.show(); quick.focus(); return }
  const wa = screen.getDisplayMatching(win.getBounds()).workArea
  const QW = 640, QH = 96
  quick = new BrowserWindow({
    width: QW, height: QH, x: Math.round(wa.x + (wa.width - QW) / 2), y: Math.round(wa.y + wa.height * 0.32),
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  quick.setAlwaysOnTop(true, 'screen-saver')
  quick.loadFile('quick.html')
  let shownAt = Infinity
  quick.once('ready-to-show', () => { quick.show(); quick.focus(); shownAt = Date.now() })
  // 點到別處就收起；剛彈出時 Windows 可能搶不到焦點，前 0.6 秒的失焦忽略
  quick.on('blur', () => { if (Date.now() - shownAt > 600 && quick && !quick.isDestroyed()) quick.close() })
  quick.on('closed', () => { quick = null })
}
ipcMain.on('probe-now', () => probeUsage(true))
ipcMain.on('quick-open', () => openQuick())
ipcMain.on('quick-close', () => { if (quick && !quick.isDestroyed()) quick.close() })
ipcMain.on('quick-submit', (e, text) => {
  if (quick && !quick.isDestroyed()) quick.close()
  text = String(text || '').trim()
  if (!text) return
  shell.openExternal('claude://claude.ai/new?q=' + encodeURIComponent(text.slice(0, 8000)))
  send('asked')
})
ipcMain.on('calibrate', (e, pct) => {
  pct = Number(pct)
  if (!(pct > 0 && pct <= 100) || !lastStats || !(lastStats.period > 0)) return
  cfg.weeklyBudget = Math.round(lastStats.period / (pct / 100))
  saveCfg()
  lastStats = withQuota(lastStats)
  send('stats', lastStats)
})

ipcMain.on('set-ignore', (e, ignore) => {
  if (win) win.setIgnoreMouseEvents(ignore, { forward: true })
})
// 拖動：由主程序直接讀滑鼠的真實螢幕座標，不靠網頁事件的 screenX（縮放比例非整數、多螢幕時會越拖越偏）
let dragTimer = null, dragFrom = null
function stopDrag() { if (dragTimer) { clearInterval(dragTimer); dragTimer = null } }
ipcMain.on('drag-start', () => { const [x, y] = win.getPosition(); stopDrag(); dragFrom = { c: screen.getCursorScreenPoint(), x, bottom: y + curH } })
ipcMain.on('drag-run', () => {
  if (!dragFrom) return
  stopDrag()
  const { c, x, bottom } = dragFrom
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return stopDrag()
    const n = screen.getCursorScreenPoint()
    // 不能用 setPosition：Windows 非整數縮放（如 125%）下它每呼叫一次視窗就會多長幾個像素，小克就越拖越往下掉。setBounds 連同寬高一起指定才不會漂。
    // 以視窗底部為基準，拖動中氣泡收起造成高度變化也不會跳
    win.setBounds({ x: x + n.x - c.x, y: bottom + n.y - c.y - curH, width: W, height: curH })
  }, 8)
})
ipcMain.on('move-end', () => { stopDrag(); dragFrom = null; const [x, y] = win.getPosition(); cfg.x = x; cfg.y = y + curH - H; saveCfg() })
// 氣泡太高放不下時，視窗往上加高（need 為需要的總高度，0 = 還原）
ipcMain.on('fit-height', (e, need) => {
  if (!win || win.isDestroyed()) return
  const wa = screen.getDisplayMatching(win.getBounds()).workArea
  const target = Math.min(Math.max(H, Math.ceil(Number(need) || 0)), wa.height)
  if (target === curH) return
  const b = win.getBounds()
  win.setBounds({ x: b.x, y: b.y + curH - target, width: W, height: target })
  curH = target
})
ipcMain.on('menu', () => Menu.buildFromTemplate(menuTemplate()).popup({ window: win }))
// 角色圖的不透明區域（降取樣成 1/4 網格），用來判斷滑鼠是否點在小克身上
ipcMain.handle('mask', () => {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'xiaoke1.png'))
  const { width, height } = img.getSize()
  const bmp = img.toBitmap() // BGRA
  const step = 4
  const w = Math.ceil(width / step), h = Math.ceil(height / step)
  const data = new Array(w * h).fill(0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y * step) * width + x * step) * 4 + 3
      data[y * w + x] = bmp[i] > 30 ? 1 : 0
    }
  }
  return { w, h, data }
})
ipcMain.handle('lines', () => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'lines.json'), 'utf8')) } catch (e) { return [{ text: '臺詞檔案壞掉了...', weight: 1 }] }
})

// ---------- 跟著 Claude Code 開關 ----------
// hook.js 在 sessions/ 下為每個 Claude Code 會話放一個檔案，會話結束時刪掉。
// 檔案和對話記錄都超過 STALE_MS 沒動靜的，當作已關閉（兜底 Claude Code 異常退出沒觸發 SessionEnd）。
// 曾經有過會話、現在一個都不剩 → 小克下班。手動啟動且從沒有會話時不會自動退出。
const STALE_MS = 2 * 3600e3
const sessDir = () => path.join(app.getPath('userData'), 'sessions')
let hadSession = false
let emptyChecks = 0
let leaving = false

function liveSessions() {
  let files = []
  try { files = fs.readdirSync(sessDir()).filter(f => f.endsWith('.json')) } catch (e) { return 0 }
  let n = 0
  for (const f of files) {
    const p = path.join(sessDir(), f)
    try {
      let last = fs.statSync(p).mtimeMs
      const info = JSON.parse(fs.readFileSync(p, 'utf8'))
      try { if (info.transcript) last = Math.max(last, fs.statSync(info.transcript).mtimeMs) } catch (e) { /* 記錄還沒生成 */ }
      if (Date.now() - last > STALE_MS) fs.rmSync(p, { force: true })
      else n++
    } catch (e) { /* 檔案正被寫 */ }
  }
  return n
}

function checkSessions() {
  if (leaving) return
  const n = liveSessions()
  if (n > 0) { hadSession = true; emptyChecks = 0; return }
  if (!cfg.followClaude || !hadSession) return
  if (++emptyChecks < 2) return
  leaving = true
  send('bye')
  setTimeout(() => app.quit(), 2500)
}

app.whenReady().then(() => {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'pid'), String(process.pid)) } catch (e) { /* ignore */ }
  setInterval(checkSessions, 5000)
  createWindow()
  createTray()
  tracker = new UsageTracker({
    pricingFile: path.join(__dirname, 'pricing.json'),
    cacheFile: path.join(app.getPath('userData'), 'usage-cache.json'),
  })
  tracker.periodStart = () => periodStart()
  tracker.on('stats', s => { lastStats = withQuota(s); send('stats', lastStats) })
  tracker.on('turn', t => { send('turn', t); probeUsage(false) })
  tracker.start(3000)
  setTimeout(() => probeUsage(true), 3000)
})

app.on('second-instance', () => { if (win) { win.show(); send('poke') } })
app.on('before-quit', () => {
  if (tracker) tracker.stop()
  try { const p = path.join(app.getPath('userData'), 'pid'); if (fs.readFileSync(p, 'utf8') === String(process.pid)) fs.rmSync(p) } catch (e) { /* ignore */ }
})
app.on('window-all-closed', () => app.quit())

// 自檢：XK_SELFTEST=1 時依次截圖「待機 / 戳一下 / 賬本 / 一輪結束」，存到 selftest/ 後退出
if (process.env.XK_SELFTEST) {
  app.whenReady().then(async () => {
    const dir = path.join(__dirname, 'selftest')
    fs.mkdirSync(dir, { recursive: true })
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const shot = async name => fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG())
    for (let i = 0; i < 60 && !lastStats; i++) await wait(1000)
    await wait(1500); await shot('1-idle')
    send('poke'); await wait(800); await shot('2-poke')
    send('show-stats'); await wait(800); await shot('3-stats')
    send('turn', { cost: 0.4213, cwd: 'D:/projects/demo', model: 'claude-opus-5-5' }); await wait(800); await shot('4-turn')
    openQuick(); await wait(400); if (quick) fs.writeFileSync(path.join(dir, '5-quick.png'), (await quick.webContents.capturePage()).toPNG())
    app.quit()
  })
}
