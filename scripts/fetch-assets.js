// 下載角色圖和音效。
// 這些素材來自 aklnaaw/dsh-xiaoke-widget（及其上游 MeteorNOX/DeepSeek-Balance-Whale-Widget），
// 原作者宣告它們不適用 MIT、不授予再分發許可，所以本倉庫不附帶，安裝時從原倉庫直接下載，僅供個人使用。
const fs = require('fs')
const path = require('path')
const https = require('https')

const REPO = 'aklnaaw/dsh-xiaoke-widget'
const REF = '4822bac4acc742ad91787495b9dd9ec32a38b1b7' // 固定版本，避免原倉庫改動導致下載到不對的檔案
const FILES = ['xiaoke1.png', 'D1.mp3', 'D2.mp3', 'Ya1.mp3', 'Ya2.mp3', 'task-end-a.wav']
const dir = path.join(__dirname, '..', 'assets')

function get(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'xiaoke-cc' } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume()
        return resolve(get(res.headers.location, dest, redirects - 1))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}: ${url}`)) }
      const tmp = dest + '.part'
      const out = fs.createWriteStream(tmp)
      res.pipe(out)
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve() }))
      out.on('error', reject)
    }).on('error', reject)
  })
}

;(async () => {
  fs.mkdirSync(dir, { recursive: true })
  for (const f of FILES) {
    const dest = path.join(dir, f)
    if (fs.existsSync(dest)) continue
    const url = `https://raw.githubusercontent.com/${REPO}/${REF}/assets/${f}`
    try {
      await get(url, dest)
      console.log('  ✓', f)
    } catch (e) {
      console.warn('  ✗', f, e.message)
      process.exitCode = 1
    }
  }
  if (process.exitCode) console.warn('有素材沒下載成功，可稍後執行 `npm run assets` 重試。')
})()
