// ─────────────────────────────────────────────────────────────
// BOSS Agent 本地网页版后台（取代 Electron，避免透明悬浮窗在 macOS 上闪屏）
// 浏览器打开 http://localhost:8848 即是控制台；自动化引擎跑在这个 Node 进程里。
// 用 SSE 把引擎事件实时推给网页；网页用 fetch 调用 /api/send、/api/invoke。
// ─────────────────────────────────────────────────────────────

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { exec } = require('child_process')
const { BossAgent } = require('./src/engine')

const PORT = 8848
// 沿用原 Electron 的数据目录，保留已存的 config.json / 登录态 / 统计
const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'boss-agent')
fs.mkdirSync(DATA_DIR, { recursive: true })
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')

let agent = null
const sseClients = new Set()

function broadcast(channel, payload) {
  const data = `data: ${JSON.stringify({ channel, payload })}\n\n`
  for (const res of sseClients) { try { res.write(data) } catch (_) {} }
}

function ensureAgent() {
  if (agent) return agent
  agent = new BossAgent(DATA_DIR)
  agent.on('event', (evt) => broadcast('agent-event', evt))
  return agent
}

function buildOpts(cfg = {}) {
  const config = {}
  if (cfg.minSal) config.minSalary = parseInt(cfg.minSal, 10)
  if (cfg.maxSal) config.targetSalary = parseInt(cfg.maxSal, 10)
  if (cfg.daily) config.dailyLimit = parseInt(cfg.daily, 10)
  if (Array.isArray(cfg.areas) && cfg.areas.length) config.areas = cfg.areas
  if (Array.isArray(cfg.keywords) && cfg.keywords.length) config.jobKeywords = cfg.keywords
  if (cfg.model) config.model = cfg.model
  if (cfg.hrInactiveDays) config.hrInactiveDays = parseInt(cfg.hrInactiveDays, 10)
  if (cfg.activeStart !== undefined && cfg.activeStart !== '') config.activeStart = parseInt(cfg.activeStart, 10)
  if (cfg.activeEnd !== undefined && cfg.activeEnd !== '') config.activeEnd = parseInt(cfg.activeEnd, 10)
  config.skipWeekend = !!cfg.skipWeekend
  config.continuous = !!cfg.continuous
  return { apiKey: cfg.apiKey, profile: cfg.profile, portfolio: cfg.portfolio, resumePath: cfg.resumePath, config }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch (_) { resolve({}) } })
  })
}
function sendJson(res, obj) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

function handleSend(ch, data) {
  const a = ensureAgent()
  try {
    switch (ch) {
      case 'save-config': fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2)); break
      case 'load-config': if (fs.existsSync(CONFIG_PATH)) broadcast('config-loaded', JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); break
      case 'boss-login': a.login(); break
      case 'start-flow1': a.startFlow1(buildOpts(data)); break
      case 'stop-flow1': a.stopFlow1(); break
      case 'start-flow2': a.startFlow2(buildOpts(data)); break
      case 'stop-flow2': a.stopFlow2(); break
      case 'open-boss': exec('open "https://www.zhipin.com/web/geek/jobs"'); break
      case 'open-msg': exec('open "https://www.zhipin.com/web/geek/chat"'); break
      case 'close-app': case 'hide-app': break
      default: break
    }
  } catch (e) { broadcast('agent-event', { type: 'log', flow: 1, level: 'warn', text: e.message }) }
}

async function handleInvoke(ch, data) {
  const a = ensureAgent()
  try {
    switch (ch) {
      case 'login-status': return a.isLoggedIn()
      case 'get-stats': return a.statsSummary()
      case 'generate-advice': {
        const o = buildOpts(data)
        return await a.generateAdvice({ apiKey: o.apiKey, profile: o.profile, resumePath: o.resumePath, model: data.model })
      }
      case 'test-llm': return await a.testLLM({ apiKey: data.apiKey, model: data.model })
      case 'pick-resume': return null // 网页版不能开系统文件框，简历路径请直接粘贴
      default: return null
    }
  } catch (e) { return '错误：' + e.message }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost')
  const p = u.pathname

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(fs.readFileSync(path.join(__dirname, 'src', 'index.html')))
  }
  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write('retry: 3000\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    // SSE 一连上就主动把已存配置推给它，避免「请求早于连接」的竞态导致配置漏回填
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        res.write(`data: ${JSON.stringify({ channel: 'config-loaded', payload: JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) })}\n\n`)
      }
    } catch (_) {}
    return
  }
  if (p.startsWith('/api/send/')) {
    handleSend(decodeURIComponent(p.slice('/api/send/'.length)), await readBody(req))
    return sendJson(res, { ok: true })
  }
  if (p.startsWith('/api/invoke/')) {
    const result = await handleInvoke(decodeURIComponent(p.slice('/api/invoke/'.length)), await readBody(req))
    return sendJson(res, { result })
  }
  res.writeHead(404); res.end('not found')
})

server.listen(PORT, () => {
  console.log(`\n✅ BOSS Agent 控制台已启动：http://localhost:${PORT}\n   浏览器会自动打开；没打开就手动访问上面这个地址。\n`)
  exec(`open "http://localhost:${PORT}"`)
})
