// Claude Code hook：讓小克跟著 Claude Code 一起開關。
//   node hook.js start  —— SessionStart：登記會話，小克沒在跑就把她叫起來
//   node hook.js ping   —— UserPromptSubmit：重新整理會話的「線上」時間（順便兜底拉起小克）
//   node hook.js end    —— SessionEnd：登出會話；最後一個會話結束後小克自己下班
// 任何錯誤都靜默退出，絕不影響 Claude Code。
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const dataDir = path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'xiaoke-cc')
const sessDir = path.join(dataDir, 'sessions')
const pidFile = path.join(dataDir, 'pid')

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch (e) { return {} }
}

function alive() {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    if (!pid) return false
    process.kill(pid, 0)
    return true
  } catch (e) {
    return false
  }
}

function launch() {
  const exe = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe')
  const child = spawn(exe, [__dirname], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

try {
  const mode = process.argv[2]
  const input = readStdin()
  const id = String(input.session_id || '').replace(/[^\w-]/g, '')
  if (!id) process.exit(0)
  fs.mkdirSync(sessDir, { recursive: true })
  const file = path.join(sessDir, id + '.json')
  if (mode === 'end') {
    fs.rmSync(file, { force: true })
  } else {
    fs.writeFileSync(file, JSON.stringify({ transcript: input.transcript_path || '', cwd: input.cwd || '', t: Date.now() }))
    if (!alive()) launch()
  }
} catch (e) { /* 靜默 */ }
process.exit(0)
