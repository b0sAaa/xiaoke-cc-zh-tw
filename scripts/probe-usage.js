// 讀取 Claude Code `/usage` 畫面上的 5 小時（Current session）與每週（Current week）額度，輸出一行 JSON。
//   node scripts/probe-usage.js [工作資料夾]
// 做法：用虛擬終端機（node-pty）開一個互動的 claude（停用 hook），送 /usage，讀畫面文字後關掉。
// 只開畫面、不送對話，所以不花 token。由 main.js 以子程序呼叫；任何失敗都輸出 {ok:false,error}。
const pty = require('node-pty')
const { execSync } = require('child_process')
const path = require('path')

const TIMEOUT = 30000
const cwd = process.argv[2] || path.resolve(__dirname, '..')
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function out(o) { process.stdout.write(JSON.stringify(o) + '\n') }

function findClaude() {
  try { return execSync('where claude', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map(s => s.trim()).find(Boolean) || 'claude' } catch (e) { return 'claude' }
}

// 去掉終端機控制碼（游標移動會把空格吃掉，所以後面的比對都要容忍沒有空格）
const strip = s => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\x5c)/g, '')

// 「6:10pm (Asia/Taipei)」「Oct 13, 2pm (Asia/Taipei)」→ 毫秒時間戳（以本機時區計）
function parseReset(text, now = new Date()) {
  const t = String(text).replace(/\(.*?\)/g, '').trim()
  const m = t.match(/^(?:([A-Za-z]{3})[a-z]*\.?\s*(\d{1,2}),?\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (!m) return null
  let h = Number(m[3]) % 12
  if (m[5].toLowerCase() === 'pm') h += 12
  const min = Number(m[4] || 0)
  let d
  if (m[1]) {
    const mon = MONTHS.indexOf(m[1].toLowerCase())
    if (mon < 0) return null
    d = new Date(now.getFullYear(), mon, Number(m[2]), h, min)
    if (d.getTime() < now.getTime() - 86400e3) d = new Date(now.getFullYear() + 1, mon, Number(m[2]), h, min)
  } else {
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min)
    if (d.getTime() <= now.getTime()) d = new Date(d.getTime() + 86400e3)
  }
  return d.getTime()
}

const SESSION = String.raw`Current\s*session`
const WEEK = String.raw`Current\s*week\s*\(all\s*models\)`
function grab(text, label) {
  const m = text.match(new RegExp(label + String.raw`[^%]*?(\d+)\s*%\s*used\s*Resets\s*(.+?\))`, 'i'))
  if (!m) return null
  const resetsAt = parseReset(m[2])
  return resetsAt ? { pct: Number(m[1]), resetsAt } : null
}

let buf = '', done = false, sent = false, p
function finish(o) {
  if (done) return
  done = true
  out(o)
  try { p.kill() } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 200)
}

try {
  p = pty.spawn(findClaude(), ['--settings', '{"disableAllHooks":true}'], { name: 'xterm-256color', cols: 120, rows: 40, cwd, env: process.env })
} catch (e) { finish({ ok: false, error: 'spawn: ' + e.message }); return }
p.onData(d => { buf += d })
p.onExit(() => finish({ ok: false, error: 'claude 提早結束' }))

const timer = setInterval(() => {
  const t = strip(buf)
  if (/trust\s*this\s*folder|Do\s*you\s*trust|trust\s*the\s*files/i.test(t)) return finish({ ok: false, error: 'untrusted: 請先在 ' + cwd + ' 開一次 claude 並信任該資料夾' })
  if (/OAuth\s*token\s*has\s*expired|Please\s*run\s*\/login|Not\s*logged\s*in|Invalid\s*API\s*key/i.test(t)) return finish({ ok: false, error: 'login: 請在終端機執行 claude 並 /login' })
  if (!sent && /❯|\? for shortcuts|for\s*shortcuts/.test(t)) {
    sent = true
    setTimeout(() => p.write('/usage'), 300)
    setTimeout(() => p.write('\r'), 1100)
  }
  const session = grab(t, SESSION), week = grab(t, WEEK)
  if (session && week) {
    clearInterval(timer)
    // 再等一下讓畫面更新完，取最後一次的數字
    setTimeout(() => {
      const t2 = strip(buf)
      finish({ ok: true, at: Date.now(), session: grab(t2, SESSION) || session, week: grab(t2, WEEK) || week })
    }, 700)
  }
}, 250)
setTimeout(() => { clearInterval(timer); finish({ ok: false, error: 'timeout' }) }, TIMEOUT)
