// ─────────────────────────────────────────────────────────────
// BOSS 直聘 Auto-Agent · Playwright 自动化引擎（主进程内运行）
//
// 流程一：搜索 → 三层筛选 → HR活跃度过滤 → Claude 10维评分 → 拟人打招呼
// 流程二：轮询 IM → 检测 HR 回复 → 秒发简历 + 作品集 → 通知 → 标记交接
//
// 为西沙本人定制：读简历PDF全文做评分/建议；行业回复率统计反推适配性；
// 24h 持续运行 + 每日额度自动重置；HR活跃时段闸门；全程拟人物理操作避风控。
// 每一步通过 EventEmitter 实时上报，由 main.js 经 IPC 推到界面。
// ─────────────────────────────────────────────────────────────

const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')

// 懒加载：没装依赖时 App 仍能打开，点“启动”才提示
let chromium = null
let Anthropic = null
let pdfParse = null

// ── 默认配置（界面可覆盖）─────────────────────────────
const DEFAULTS = {
  areas: ['南山', '前海', '宝安'],
  minSalary: 13,        // k/月，低于直接跳过（可向下兼容到 13k）
  targetSalary: 20,
  jobKeywords: [
    '海外新媒体运营', '海外营销', '新媒体运营', '海外运营',
    '出海运营', '社媒运营', '内容营销', '品牌营销'
  ],
  minScore: 60,
  dailyLimit: 50,
  delayMin: 8,
  delayMax: 15,
  searchKeywords: [
    '海外新媒体运营', '海外营销', '海外运营', '社媒运营'
  ],
  model: 'deepseek-chat',   // 默认用 DeepSeek（便宜·国内可用）；填 claude-* 则走 Anthropic
  pollInterval: 8000,

  // 新增：HR 活跃度 / 活跃时段 / 24h 持续
  hrInactiveDays: 3,       // HR 超过 N 天未活跃则跳过
  activeStart: 9,          // HR 活跃时段起始（整点）
  activeEnd: 20,           // HR 活跃时段结束（整点）
  skipWeekend: false,      // 周末是否暂停
  continuous: false,       // 24h 持续运行
  cycleGapMin: 40,         // 持续模式下两轮全量扫描的间隔（分钟）
}

// ── 10 个匹配维度 ─────────────────────────────────────
const DIMENSIONS = [
  { key: 'skill',          label: '技能匹配' },
  { key: 'industry',       label: '行业匹配' },
  { key: 'experience',     label: '经验年限' },
  { key: 'salary',         label: '薪资匹配' },
  { key: 'location',       label: '地点匹配' },
  { key: 'responsibility', label: '职责契合' },
  { key: 'company',        label: '公司团队' },
  { key: 'overseas',       label: '出海方向' },
  { key: 'growth',         label: '成长空间' },
  { key: 'success',        label: '成功概率' },
]

const MY_PROFILE_DEFAULT = `姓名：林志豪（西沙）
求职方向：海外新媒体运营 / 海外营销
核心能力：
  - 海外社媒矩阵运营（Instagram / YouTube / TikTok / Facebook 等）内容策划与增长
  - 海外品牌营销、KOL/红人合作、内容营销、社媒投放与数据复盘
  - 约18个月海外市场实操经验（美国 + 巴西双市场），英文可作工作语言
所在地：深圳南山
目标薪资：15-28k，具体面谈`

const GREETING_TEMPLATES = {
  tiktok_focused: (title) =>
    `您好，看到贵司在招${title}，我有约18个月TikTok Shop实操经验（美国+巴西双市场），` +
    `熟悉达人矩阵、短视频AI工作流和Shop Ads。目前在深圳，可随时沟通～`,
  ai_agent_focused: (title) =>
    `Hi，关注到贵司${title}职位，我在跨境运营中深度落地了AI Agent工作流——` +
    `从产品选品、短视频脚本到自动发布全链路自动化。欢迎了解具体案例 :)`,
  general: (title) =>
    `您好！看到${title}职位很感兴趣，我有跨境电商运营和AI自动化工作流实战经验，` +
    `坐标深圳南山，欢迎进一步沟通～`,
}

class BossAgent extends EventEmitter {
  constructor(userDataDir) {
    super()
    this.userDataDir = userDataDir
    this.statePath = path.join(userDataDir, 'storage_state.json')
    this.profileDir = path.join(userDataDir, 'chrome-profile')  // 持久化真实 Chrome 配置档（登录态留这里）
    this.sentResumePath = path.join(userDataDir, 'sent_resume.json')
    this.sessionsPath = path.join(userDataDir, 'sessions.json')
    this.statsPath = path.join(userDataDir, 'stats.json')

    this.browser = null
    this.context = null

    this.flow1Running = false
    this.flow2Running = false
    this._flow2Timer = null
    this._today = new Date().toDateString()

    this.metrics = { sent: 0, hrReply: 0, resumeSent: 0, skip: 0 }

    this.sessions = this._loadJson(this.sessionsPath, {})
    this.sentResume = this._loadJson(this.sentResumePath, {})
    // 累计统计：按行业/关键词的打招呼与回复数 + 最近评分
    this.stats = this._loadJson(this.statsPath, { categories: {}, evals: [] })

    this._resumeCache = null
  }

  // ── 事件辅助 ───────────────────────────────────────
  log(text, level = 'info', flow = 1) { this.emit('event', { type: 'log', flow, level, text }) }
  pushMetrics() { this.emit('event', { type: 'metric', ...this.metrics }) }
  status(flow, state) { this.emit('event', { type: 'status', flow, state }) }
  pushStats() { this.emit('event', { type: 'stats', ...this.statsSummary() }) }

  _loadJson(p, fb) { try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) {} return fb }
  _saveJson(p, d) { try { fs.writeFileSync(p, JSON.stringify(d, null, 2)) } catch (_) {} }

  _ensurePlaywright() {
    if (!chromium) {
      try { chromium = require('playwright').chromium }
      catch (e) { throw new Error('未安装 Playwright，请先运行：npm install && npx playwright install chromium') }
    }
  }
  _ensureAnthropic() {
    if (!Anthropic) {
      try { Anthropic = require('@anthropic-ai/sdk') }
      catch (e) { throw new Error('未安装 @anthropic-ai/sdk，请先运行：npm install') }
    }
  }

  // 连接态：调试端口 9222 是否可达（= 你已用调试模式开了 Chrome，可被驱动）
  async isLoggedIn() {
    const endpoint = (process.env.BOSS_CDP || 'http://127.0.0.1:9222') + '/json/version'
    try { const r = await fetch(endpoint); return r.ok } catch (_) { return false }
  }

  /** 「连接 Chrome」按钮：连上你调试模式的 Chrome 并确认已登录 BOSS */
  async login() {
    try {
      this.emit('event', { type: 'login', state: 'opening' })
      this.log('连接你的 Chrome 并检查 BOSS 登录态...', 'info')
      const page = await this._newPage()
      const ok = await this.ensureLoggedIn(page)
      this.emit('event', { type: 'login', state: ok ? 'logged-in' : 'failed' })
      if (ok) this.log('✅ 已连接 Chrome 且 BOSS 已登录，可以开始投递了', 'ok')
      await page.waitForTimeout(1200)
      try { await page.close() } catch (_) {}
      return ok
    } catch (e) {
      this.log('登录失败：' + e.message, 'warn')
      this.emit('event', { type: 'login', state: 'failed' })
      return false
    }
  }

  // ── 简历 PDF 读取（缓存）────────────────────────────
  async loadResume(resumePath) {
    if (!resumePath || !fs.existsSync(resumePath)) return ''
    if (this._resumeCache && this._resumeCache.path === resumePath) return this._resumeCache.text
    try {
      if (!pdfParse) pdfParse = require('pdf-parse')
      const data = await pdfParse(fs.readFileSync(resumePath))
      const text = (data.text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000)
      this._resumeCache = { path: resumePath, text }
      this.log('📄 已读取简历 PDF 全文，将用于评分与建议', 'ok')
      return text
    } catch (e) {
      this.log('读取简历 PDF 失败：' + e.message, 'warn')
      return ''
    }
  }
  _candidateContext(profile, resumeText) {
    let c = profile || MY_PROFILE_DEFAULT
    if (resumeText) c += `\n\n【简历全文】\n${resumeText}`
    return c
  }

  // ── 连接你「已经打开的真实 Chrome」（核心反爬手段）─────────────
  // BOSS 会把 Playwright 自己启动的浏览器整页屏蔽成空白；但连接到你正常启动、
  // 已登录的 Chrome（调试端口 9222）就是真实会话，BOSS 不屏蔽。
  // 用前先双击「启动Chrome-调试模式.command」。
  async ensureBrowser() {
    this._ensurePlaywright()
    if (this.context && this.browser && this.browser.isConnected()) return
    const endpoint = process.env.BOSS_CDP || 'http://127.0.0.1:9222'
    this.log(`连接你已打开的 Chrome（${endpoint}）...`, 'info')
    try {
      this.browser = await chromium.connectOverCDP(endpoint, { timeout: 6000 })
    } catch (e) {
      throw new Error('连不上 Chrome 调试端口。请先双击「启动Chrome-调试模式.command」用调试模式打开 Chrome（并登录 BOSS），再回来启动。')
    }
    const contexts = this.browser.contexts()
    this.context = contexts[0] || (await this.browser.newContext())
    try { await this.context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) }) } catch (_) {}
    this.browser.on('disconnected', () => {
      this.browser = null; this.context = null
      this.flow1Running = false; this.flow2Running = false
      if (this._flow2Timer) { clearInterval(this._flow2Timer); this._flow2Timer = null }
      this.status(1, 'stopped'); this.status(2, 'stopped')
      this.log('与 Chrome 的连接已断开', 'warn')
    })
  }
  async _newPage() {
    await this.ensureBrowser()
    // 在你的 Chrome 里另开一个标签给 Agent 用，不打扰你正在看的标签
    return this.context.newPage()
  }

  async ensureLoggedIn(page) {
    await page.goto('https://www.zhipin.com/web/geek/job-recommend', { waitUntil: 'domcontentloaded' })
    await this._humanPause(2500, 4000)
    let text = ''
    try { text = await page.locator('body').innerText() } catch (_) {}
    const url = page.url()
    // 登录态判定：URL 不含 login + 页面真的渲染了内容（避免被反爬返回的空白页误判为已登录）
    if (!url.includes('login') && !url.includes('/web/user') && text.replace(/\s+/g, '').length > 80) {
      this.log('✅ 已是登录状态', 'ok'); return true
    }
    this.log('⚠️ BOSS 未登录（或页面空白）：请在你这个 Chrome 里登录 BOSS（zhipin.com），最多等 120 秒...', 'warn')
    this.emit('event', { type: 'need-login' })
    await page.goto('https://www.zhipin.com/web/user/', { waitUntil: 'domcontentloaded' })
    try {
      await page.waitForURL((u) => !u.toString().includes('login') && u.toString().includes('zhipin.com'), { timeout: 120000 })
    } catch (e) { this.log('登录超时，请重试', 'warn'); return false }
    await this._humanPause(1500, 2500)
    this.log('✅ BOSS 已登录', 'ok')
    return true
  }
  async _saveState() { /* 持久配置档自动保存登录态，无需手动导出 */ }

  // ── 拟人物理操作 ───────────────────────────────────
  _rand(a, b) { return a + Math.random() * (b - a) }
  async _humanPause(a = 600, b = 1600) { await new Promise((r) => setTimeout(r, this._rand(a, b))) }

  /** 真实鼠标轨迹移动到元素并点击（trusted 输入事件，非 JS click） */
  async _humanClick(page, el) {
    try {
      await el.scrollIntoViewIfNeeded()
      const box = await el.boundingBox()
      if (box) {
        const x = box.x + box.width * this._rand(0.3, 0.7)
        const y = box.y + box.height * this._rand(0.3, 0.7)
        await page.mouse.move(x, y, { steps: Math.floor(this._rand(12, 28)) })
        await this._humanPause(120, 350)
        await page.mouse.down(); await this._humanPause(40, 110); await page.mouse.up()
        return true
      }
    } catch (_) {}
    try { await el.click(); return true } catch (_) { return false }
  }

  /** 变速逐字输入，偶尔停顿“思考” */
  async _humanType(page, text) {
    for (const ch of text) {
      await page.keyboard.type(ch, { delay: 0 })
      await this._humanPause(45, 140)
      if (Math.random() < 0.06) await this._humanPause(300, 700)
    }
  }

  /** 列表页随机滚动，像在浏览 */
  async _humanScroll(page) {
    const n = Math.floor(this._rand(2, 5))
    for (let i = 0; i < n; i++) {
      await page.mouse.wheel(0, this._rand(250, 600))
      await this._humanPause(500, 1200)
    }
  }

  // ── 工具 ───────────────────────────────────────────
  static parseSalary(text) {
    if (!text) return [0, 0]
    const t = String(text).toUpperCase().replace(/[，,]/g, '')
    const nums = (t.match(/\d+\.?\d*/g) || []).map(Number)
    if (nums.length >= 2) {
      let [lo, hi] = nums
      if (text.includes('年') || (lo > 100 && hi > 100)) return [Math.round(lo / 12), Math.round(hi / 12)]
      return [Math.round(lo), Math.round(hi)]
    }
    if (nums.length === 1) return [Math.round(nums[0]), Math.round(nums[0])]
    return [0, 0]
  }
  _checkArea(loc, cfg) { return cfg.areas.length === 0 || cfg.areas.some((a) => (loc || '').includes(a)) }
  _checkKeywords(title, cfg) { const t = (title || '').toLowerCase(); return cfg.jobKeywords.some((kw) => t.includes(kw.toLowerCase())) }

  /** HR 活跃文案 → 估算“几天未活跃” */
  static activityToDays(text) {
    if (!text) return 0
    const s = String(text)
    if (/(在线|刚刚|分钟前|小时前|今日|今天)/.test(s)) return 0
    if (/(昨日|昨天)/.test(s)) return 1
    let m = s.match(/(\d+)\s*天/); if (m) return parseInt(m[1], 10)
    m = s.match(/(\d+)\s*周/); if (m) return parseInt(m[1], 10) * 7
    m = s.match(/(\d+)\s*月/); if (m) return parseInt(m[1], 10) * 30
    if (/(本周|这周|近一周)/.test(s)) return 3
    if (/(本月|这个月|近一月)/.test(s)) return 20
    if (/(半年|一年|年前)/.test(s)) return 999
    return 0
  }

  // ── 活跃时段闸门 ───────────────────────────────────
  _withinActive(cfg) {
    const now = new Date(); const day = now.getDay()
    if (cfg.skipWeekend && (day === 0 || day === 6)) return false
    const h = now.getHours()
    return h >= cfg.activeStart && h < cfg.activeEnd
  }
  _isRunning(flow) { return flow === 1 ? this.flow1Running : this.flow2Running }
  async _sleep(ms, flow) {
    let waited = 0
    while (waited < ms) {
      if (!this._isRunning(flow)) return
      const step = Math.min(2000, ms - waited)
      await new Promise((r) => setTimeout(r, step)); waited += step
    }
  }
  async _waitForActive(cfg, flow) {
    let warned = false
    while (this._isRunning(flow) && !this._withinActive(cfg)) {
      if (!warned) {
        this.log(`⏸ 当前不在 HR 活跃时段（${cfg.activeStart}:00–${cfg.activeEnd}:00${cfg.skipWeekend ? '，周末暂停' : ''}），自动等待...`, 'info', flow)
        this.status(flow, 'waiting'); warned = true
      }
      await this._sleep(5 * 60 * 1000, flow)
    }
    if (warned && this._isRunning(flow)) { this.log('▶ 进入 HR 活跃时段，继续作业', 'ok', flow); this.status(flow, 'running') }
  }
  _resetDailyIfNeeded() {
    const d = new Date().toDateString()
    if (this._today !== d) {
      this._today = d
      this.metrics.sent = 0; this.metrics.skip = 0
      this.pushMetrics()
      this.log('🌅 新的一天，今日投递额度已重置', 'info', 1)
    }
  }

  // ── 行业回复率统计 ─────────────────────────────────
  _recordGreet(cat) {
    if (!cat) return
    const c = this.stats.categories[cat] || { greeted: 0, replied: 0 }
    c.greeted++; this.stats.categories[cat] = c
    this._saveJson(this.statsPath, this.stats); this.pushStats()
  }
  _recordReply(cat) {
    if (!cat) return
    const c = this.stats.categories[cat] || { greeted: 0, replied: 0 }
    c.replied++; this.stats.categories[cat] = c
    this._saveJson(this.statsPath, this.stats); this.pushStats()
  }
  _recordEval(ev) {
    this.stats.evals.unshift(ev)
    this.stats.evals = this.stats.evals.slice(0, 60)
    this._saveJson(this.statsPath, this.stats)
    this.emit('event', { type: 'eval', eval: ev })
  }
  statsSummary() {
    const rates = Object.entries(this.stats.categories).map(([cat, v]) => ({
      cat, greeted: v.greeted, replied: v.replied,
      rate: v.greeted ? Math.round((v.replied / v.greeted) * 100) : 0,
    })).sort((a, b) => b.rate - a.rate)
    const lastEval = this.stats.evals[0] || null
    return { rates, lastEval }
  }

  // ── 测试 API Key/模型是否可用（DeepSeek 或 Claude）───
  async testLLM({ apiKey, model }) {
    if (!apiKey) return { ok: false, msg: '未填 API Key' }
    const m = model || DEFAULTS.model
    const who = /^deepseek/i.test(m) ? 'DeepSeek' : 'Claude'
    try {
      const t = await this._chat({ apiKey, model: m, prompt: '只回复两个字：可用', maxTokens: 16 })
      const txt = (t || '').trim()
      return { ok: !!txt, msg: `${who} 返回「${txt.slice(0, 12) || '空'}」` }
    } catch (e) {
      return { ok: false, msg: `${who} 调用失败：${String(e.message || e).slice(0, 90)}` }
    }
  }

  // ── 统一 LLM 调用：按模型名自动选 DeepSeek 或 Claude ───
  async _chat({ apiKey, model, prompt, maxTokens = 600, json = false }) {
    const m = model || DEFAULTS.model
    if (/^deepseek/i.test(m)) {
      // DeepSeek（OpenAI 兼容）。Electron 主进程是 Node 20，自带 fetch。
      const body = { model: m, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.3 }
      if (json) body.response_format = { type: 'json_object' }
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      })
      if (!resp.ok) { const t = await resp.text(); throw new Error(`DeepSeek ${resp.status}: ${t.slice(0, 120)}`) }
      const data = await resp.json()
      return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
    }
    // Claude / Anthropic
    this._ensureAnthropic()
    const client = new Anthropic({ apiKey })
    const r = await client.messages.create({ model: m, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
    const tb = r.content.find((b) => b.type === 'text')
    return tb ? tb.text : ''
  }

  // ── 10 维度评分（DeepSeek / Claude 通用）──────────────
  async scoreJob(job, cfg, apiKey, candidate) {
    const dimLines = DIMENSIONS.map((d) => `  "${d.key}": 0-100,   // ${d.label}`).join('\n')
    const prompt = `你是资深求职顾问。请基于【候选人】对【职位】做 10 个维度的匹配度打分（每项 0-100），并给出综合分和投递建议。
候选人方向是「海外新媒体运营 / 海外营销」，越贴近这个方向分越高；偏纯跨境电商/TikTok Shop带货/亚马逊运营则降分。

【候选人】
${candidate}

【职位】
- 名称：${job.title || ''}
- 公司：${job.company || ''}
- 薪资：${job.salary || ''}
- 地点：${job.location || ''}
- 标签：${(job.tags || []).join('、') || '（无）'}
- 描述：${job.description || '（仅列表信息）'}

只输出一个 JSON（不要任何额外文字、不要代码块）：
{
  "dimensions": {
${dimLines}
  },
  "score": 0-100,
  "recommend": true,
  "reason": "20字内中文，点明最关键的匹配/不匹配点",
  "priority": "high | medium | low"
}`
    try {
      const text = await this._chat({ apiKey, model: cfg.model, prompt, maxTokens: 600, json: true })
      const m = (text || '').match(/\{[\s\S]*\}/)
      if (m) {
        const r = JSON.parse(m[0])
        if (!r.dimensions) r.dimensions = {}
        return r
      }
    } catch (e) {
      this.log(`AI 评分失败：${e.message}`, 'warn', 1)
    }
    return { dimensions: {}, score: 50, recommend: false, reason: '评分失败', priority: 'low' }
  }

  // ── AI 求职建议（DeepSeek / Claude 通用）────────────
  async generateAdvice(opts) {
    const apiKey = opts.apiKey
    if (!apiKey) throw new Error('未配置 API Key')
    const resumeText = await this.loadResume(opts.resumePath)
    const candidate = this._candidateContext(opts.profile, resumeText)
    const { rates, lastEval } = this.statsSummary()

    const ratesText = rates.length
      ? rates.map((r) => `- ${r.cat}：打招呼 ${r.greeted}，回复 ${r.replied}，回复率 ${r.rate}%`).join('\n')
      : '（暂无投递数据）'
    const evalText = this.stats.evals.length
      ? this.stats.evals.slice(0, 10).map((e) => `- ${e.title}（${e.company}）综合 ${e.score}`).join('\n')
      : '（暂无评分数据）'

    const prompt = `你是资深求职教练。候选人求职方向是「海外新媒体运营 / 海外营销」。基于以下真实数据，给一份**可执行**的求职建议。

【候选人/简历】
${candidate}

【各方向回复率】（反映市场对该方向的真实反馈）
${ratesText}

【近期评分较高的职位】
${evalText}

请输出中文建议，分这几块（用简短小标题，控制在 600 字内）：
1. 最该聚焦的方向（结合回复率，哪类岗位最值得集中火力）
2. 简历待优化点（具体到改哪里、怎么改）
3. 薪资定位建议
4. 投递节奏/筛选建议
5. 一句话总结今天该做什么`

    const text = await this._chat({ apiKey, model: opts.model, prompt, maxTokens: 1500 })
    return (text || '').trim() || '（未生成建议）'
  }

  // ── 流程一：打招呼（支持 24h 持续）─────────────────
  async startFlow1(opts) {
    if (this.flow1Running) return
    const cfg = { ...DEFAULTS, ...(opts.config || {}) }
    const apiKey = opts.apiKey
    if (!apiKey) { this.log('⚠️ 未填 API Key，先去「设置」填 DeepSeek key 并测试连接', 'warn', 1); this.status(1, 'stopped'); return }
    // 先确认连上了调试 Chrome，避免一直卡在连接上
    const connected = await this.isLoggedIn()
    if (!connected) {
      this.log('⚠️ 没连上 Chrome！请先双击「启动Chrome-调试模式.command」开调试 Chrome（并登录 BOSS），再点蓝色「连接 Chrome」，然后再点流程一', 'warn', 1)
      this.status(1, 'stopped')
      return
    }

    this.flow1Running = true
    this.status(1, 'running')
    this.log(`🤖 流程一启动${cfg.continuous ? '（24h 持续模式）' : ''}：搜索→筛选→活跃度→10维评分→拟人打招呼`, 'ok', 1)

    const resumeText = await this.loadResume(opts.resumePath)
    const candidate = this._candidateContext(opts.profile, resumeText)

    let page
    try {
      page = await this._newPage()
      const ok = await this.ensureLoggedIn(page)
      if (!ok) { this.flow1Running = false; this.status(1, 'stopped'); return }

      do {
        this._resetDailyIfNeeded()
        await this._waitForActive(cfg, 1)
        if (!this.flow1Running) break

        await this._runOneCycle(page, cfg, apiKey, candidate)

        if (this.flow1Running && cfg.continuous) {
          this.log(`💤 本轮扫描完成，${cfg.cycleGapMin} 分钟后再扫一遍新职位...`, 'info', 1)
          this.status(1, 'waiting')
          await this._sleep(cfg.cycleGapMin * 60 * 1000, 1)
          this.status(1, 'running')
        }
      } while (this.flow1Running && cfg.continuous)

      if (this.flow1Running && !cfg.continuous) this.log(`流程一完成：本次投递 ${this.metrics.sent} 个`, 'ok', 1)
    } catch (e) {
      this.log(`流程一异常：${e.message}`, 'warn', 1)
    } finally {
      this.flow1Running = false
      this.status(1, 'stopped')
      await this._saveState()
      if (page) { try { await page.close() } catch (_) {} }
    }
  }

  // MVP：从能正常渲染的「推荐页」读职位（自带薪资），筛选→评分→打招呼。
  // 不走被 BOSS 反爬屏蔽的关键词搜索页；打招呼在后台标签进行，前台不闪。
  async _runOneCycle(page, cfg, apiKey, candidate) {
    const detailPage = await this.context.newPage()
    await page.bringToFront()
    try {
      this.log('🔍 读取推荐职位列表...', 'info', 1)
      const jobs = await this._listRecommendedJobs(page)
      await page.bringToFront()
      this.log(`   找到 ${jobs.length} 个职位`, jobs.length ? 'info' : 'warn', 1)

      for (const job of jobs) {
        if (!this.flow1Running) break
        if (this.metrics.sent >= cfg.dailyLimit) { this.log(`⚠️ 已达今日上限 ${cfg.dailyLimit}，停止`, 'warn', 1); break }
        await this._waitForActive(cfg, 1)
        if (!this.flow1Running) break

        const key = job.company || job.title
        // 三层筛选（推荐卡片自带这些信息，无需翻详情）
        if (!this._checkKeywords(job.title, cfg)) { this._skip(); continue }
        if (!this._checkArea(job.location, cfg)) { this.log(`⏭ 区域不符：${job.title}（${job.location}）`, 'skip', 1); this._skip(); continue }
        if (this.sessions[key] && this.sessions[key].greeted) continue
        const [, hi] = BossAgent.parseSalary(job.salary)
        if (hi > 0 && hi < cfg.minSalary) { this.log(`⏭ 薪资不达标：${job.title}（${job.salary}）`, 'skip', 1); this._skip(); continue }
        const days = BossAgent.activityToDays(job.activity)
        if (days > cfg.hrInactiveDays) { this.log(`⏭ HR 不活跃(${job.activity})：${job.title}`, 'skip', 1); this._skip(); continue }

        const cat = cfg.jobKeywords.find((k) => job.title.toLowerCase().includes(k.toLowerCase())) || '推荐'
        this.log(`🤔 评分中：${job.title} · ${job.salary || '薪资未知'} · ${job.location || '?'}`, 'info', 1)
        const r = await this.scoreJob(job, cfg, apiKey, candidate)
        this._recordEval({
          title: job.title, company: job.company || '', salary: job.salary || '', location: job.location || '',
          score: r.score || 0, dimensions: r.dimensions || {}, reason: r.reason || '', cat, replied: false, at: new Date().toISOString(),
        })
        if ((r.score || 0) < cfg.minScore) { this.log(`⏭ 评分过低(${r.score}分)：${job.title} — ${r.reason || ''}`, 'skip', 1); this._skip(); continue }

        const topDims = DIMENSIONS.map((d) => `${d.label}${r.dimensions[d.key] ?? '-'}`).slice(0, 4).join(' ')
        this.log(`⭐ 综合 ${r.score}/100 — ${r.reason || ''}（${topDims}）`, 'ok', 1)

        // 打招呼：后台标签打开详情页 → 立即沟通（BOSS 默认招呼语）
        let sent = false
        if (job.detailUrl) {
          await this._loadDetail(detailPage, job)
          sent = await this._sendGreeting(detailPage, job)
        } else {
          this.log(`  无详情链接，跳过打招呼：${job.title}`, 'warn', 1)
        }
        if (sent) {
          this.metrics.sent++; this.pushMetrics()
          this.log(`✅ 已打招呼 · ${job.company || job.title}（${job.salary || '?'}｜${job.location || '?'}）`, 'ok', 1)
          this._markSession(job, { greeted: true, company: job.company, salary: job.salary, location: job.location, category: cat }, key)
          this._recordGreet(cat)
        }
        await this._sleep(this._rand(cfg.delayMin, cfg.delayMax) * 1000, 1)
      }
    } finally { try { await detailPage.close() } catch (_) {} }
  }

  /** 读「推荐页」职位卡片（推荐页不被反爬屏蔽，且卡片自带薪资）。带诊断日志。 */
  async _listRecommendedJobs(page) {
    await page.goto('https://www.zhipin.com/web/geek/job-recommend', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.job-card-wrapper, .job-card-box', { timeout: 15000 }).catch(() => {})
    await this._humanPause(1500, 2500)
    for (let i = 0; i < 4; i++) { try { await page.mouse.wheel(0, 900) } catch (_) {} await this._humanPause(700, 1400) }

    const jobs = []
    try {
      const cards = await page.$$('.job-card-wrapper, .job-card-box')
      if (cards.length === 0) {
        let hint = ''
        try { hint = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 80) } catch (_) {}
        try { await page.screenshot({ path: path.join(this.userDataDir, 'last_search.png') }) } catch (_) {}
        this.log(`   推荐页 0 卡片（提示：${hint || '空'}）。已存截图`, 'warn', 1)
        return []
      }
      let logged = false
      for (const card of cards.slice(0, 40)) {
        const pick = async (sels) => { for (const s of sels) { const e = await card.$(s); if (e) return (await e.innerText()).trim() } return '' }
        const title = await pick(['.job-name', 'a.job-name', '.job-title'])
        const salary = await pick(['.salary', '.job-salary', 'span.salary', '.job-card-footer .salary'])
        const company = await pick(['.company-name', '.boss-name', '.company-text .name'])
        const location = await pick(['.job-area', '.company-location', '.job-area-wrapper'])
        const activity = await pick(['.boss-active-time', '.job-card-footer .gold', '.active-time'])
        let href = ''
        const link = await card.$('a.job-card-left, a.job-name, a[href*="/job_detail/"]')
        if (link) href = await link.getAttribute('href')
        if (!logged) { this.log(`   样例卡片｜标题:${title || '?'}｜薪资:${salary || '?'}｜公司:${company || '?'}｜地点:${location || '?'}`, 'info', 1); logged = true }
        if (!title) continue
        jobs.push({ title, salary, company, location, activity, tags: [], description: '', detailUrl: href ? (href.startsWith('http') ? href : 'https://www.zhipin.com' + href) : '' })
      }
    } catch (e) { this.log(`解析推荐列表失败：${e.message}`, 'warn', 1) }
    return jobs
  }

  stopFlow1() {
    if (!this.flow1Running) return
    this.flow1Running = false
    this.log('⏹ 流程一已手动停止', 'warn', 1)
    this.status(1, 'stopped')
  }
  _skip() { this.metrics.skip++; this.pushMetrics() }

  /**
   * 搜索列表：抓 标题/公司/地区/详情链接。
   * ⚠️ 真机实测：搜索结果页卡片是 .job-card-box，且**薪资在列表里隐藏为「-K」**，
   * 所以薪资/JD/HR活跃度要到详情页（/job_detail/xxx.html）再读，见 _loadDetail。
   */
  async _searchJobs(page, keyword) {
    const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(keyword)}&city=101280600`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    // 等职位卡真正渲染出来（最多 15s），比固定 sleep 稳；BOSS 列表是 XHR 异步加载的
    await page.waitForSelector('.job-card-box, .job-card-wrapper', { timeout: 15000 }).catch(() => {})
    await this._humanPause(1500, 2500)
    await this._humanScroll(page)

    const jobs = []
    try {
      let cards = await page.$$('.job-card-box, .job-card-wrapper, li.job-card-wrapper')
      if (cards.length === 0) {
        // 诊断 0 结果的原因：安全验证？登录墙？还是没加载出来
        let bodyHint = ''
        try { bodyHint = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 120) } catch (_) {}
        const cur = page.url()
        try { await page.screenshot({ path: path.join(this.userDataDir, 'last_search.png') }) } catch (_) {}
        if (/验证|安全|滑块|拖动|captcha|verify/i.test(bodyHint)) {
          this.log('   ⚠️ 0 个职位：疑似 BOSS 安全验证，请在弹出的浏览器里手动通过一次验证，再重试', 'warn', 1)
        } else if (cur.includes('login') || /登录/.test(bodyHint)) {
          this.log('   ⚠️ 0 个职位：被要求登录，请点「登录 BOSS」重新扫码', 'warn', 1)
        } else {
          this.log(`   0 个职位（页面提示：${bodyHint.slice(0, 50) || '空'}）。已存截图 last_search.png`, 'info', 1)
        }
      }
      for (const card of cards.slice(0, 20)) {
        const pick = async (sels) => {
          for (const s of sels) { const el = await card.$(s); if (el) return (await el.innerText()).trim() }
          return ''
        }
        const title = await pick(['a.job-name', '.job-name', '.job-title'])
        const company = await pick(['.company-name', '.boss-name', '.company-text .name'])
        const location = await pick(['.job-area', '.job-area-wrapper', '.company-location'])
        let href = ''
        const link = await card.$('a.job-name, a[href*="/job_detail/"]')
        if (link) href = await link.getAttribute('href')
        if (!title || !href) continue
        const detailUrl = href.startsWith('http') ? href : `https://www.zhipin.com${href}`
        jobs.push({ title, company, location, detailUrl, salary: '', description: '', activity: '', tags: [] })
      }
    } catch (e) { this.log(`解析职位列表失败：${e.message}`, 'warn', 1) }
    return jobs
  }

  /** 打开职位详情页，补全 薪资 / JD / HR活跃度（真机实测选择器）*/
  async _loadDetail(page, job) {
    try {
      await page.goto(job.detailUrl, { waitUntil: 'domcontentloaded' })
      await this._humanPause(1800, 3000)
      const pick = async (sels) => {
        for (const s of sels) { const el = await page.$(s); if (el) return (await el.innerText()).trim() }
        return ''
      }
      job.salary = await pick(['.salary', '.job-banner .salary', '.badge'])
      job.description = (await pick(['.job-sec-text', '.job-detail-section'])).slice(0, 1500)
      job.activity = await pick(['.job-boss-info .name', '.boss-active-time', '.gray'])
      return true
    } catch (e) {
      this.log(`  打开详情失败：${e.message}`, 'warn', 1)
      return false
    }
  }

  /**
   * 在职位详情页打招呼：只点「立即沟通」，用 BOSS 里设置好的默认打招呼语，
   * 不自拟话术（按用户要求）。已是「继续沟通」=早聊过，跳过。
   */
  async _sendGreeting(page, job) {
    try {
      const already = await page.$("a.btn-startchat:has-text('继续沟通'), a:has-text('继续沟通')")
      if (already) { this.log(`  已联系过，跳过：${job.title}`, 'skip', 1); return false }

      const btnSelectors = [
        "a.btn-startchat", "a.op-btn-chat", "a:has-text('立即沟通')",
        "button:has-text('立即沟通')", ".chat-btn",
      ]
      let btn = null
      for (const s of btnSelectors) { btn = await page.$(s); if (btn) break }
      if (!btn) { this.log(`  未找到沟通按钮：${job.title}`, 'warn', 1); return false }
      await this._humanClick(page, btn)
      await this._humanPause(1800, 2800)

      // BOSS 点「立即沟通」会自动发出你设置的默认打招呼语。若弹出确认/发送框则点一下确认。
      const confirm = await page.$(
        ".boss-dialog .btn-sure, .boss-popup .btn-sure, button:has-text('确定'), button:has-text('发送')"
      )
      if (confirm) { await this._humanClick(page, confirm); await this._humanPause(600, 1200) }
      return true
    } catch (e) { this.log(`  投递失败 ${job.title}：${e.message}`, 'warn', 1); return false }
  }

  // ── 流程二：监听 HR 回复 → 秒发简历 ⭐ ─────────────
  async startFlow2(opts) {
    if (this.flow2Running) return
    const cfg = { ...DEFAULTS, ...(opts.config || {}) }
    this._flow2Opts = opts
    const connected = await this.isLoggedIn()
    if (!connected) {
      this.log('⚠️ 没连上 Chrome！请先双击「启动Chrome-调试模式.command」并点蓝色「连接 Chrome」，再点流程二', 'warn', 2)
      this.status(2, 'stopped')
      return
    }
    this.flow2Running = true
    this.status(2, 'running')
    this.log('👂 流程二启动：HR 一回复就发作品集+简历（海投，不等第二句）', 'ok', 2)
    try {
      this._flow2Page = await this._newPage()
      const ok = await this.ensureLoggedIn(this._flow2Page)
      if (!ok) { this.flow2Running = false; this.status(2, 'stopped'); return }
      // 真机实测：消息页是 /web/geek/chat（直接 goto /web/im/ 会被弹回首页）
      await this._flow2Page.goto('https://www.zhipin.com/web/geek/chat', { waitUntil: 'domcontentloaded' })
      await this._humanPause(2500, 4000)
      this.status(2, 'listening')
      await this._flow2Tick(cfg)
      this._flow2Timer = setInterval(() => {
        this._flow2Tick(cfg).catch((e) => this.log(`流程二轮询异常：${e.message}`, 'warn', 2))
      }, cfg.pollInterval)
    } catch (e) {
      this.log(`流程二异常：${e.message}`, 'warn', 2)
      this.flow2Running = false; this.status(2, 'stopped')
    }
  }
  stopFlow2() {
    if (!this.flow2Running) return
    this.flow2Running = false
    if (this._flow2Timer) { clearInterval(this._flow2Timer); this._flow2Timer = null }
    this.log('⏹ 流程二已手动停止', 'warn', 2)
    this.status(2, 'stopped')
  }

  /**
   * 海投策略（按用户要求，无任何自拟客套话）：HR **一回复就够了**，不等第二句——
   * 检测到 HR 回复(最后气泡是 .item-friend) → 一次性发**作品集链接 + 简历附件**，然后交还给你。
   * 用 sentResume[name] 记录防重复；只处理「今天」活跃的会话，避免首次跑就骚扰一堆旧对话。
   */
  async _flow2Tick(cfg) {
    if (!this.flow2Running) return
    const page = this._flow2Page
    if (!page) return

    // 触发信号：真机实测未读=条目里的红色数字徽标 .notice-badge（HR 发了新消息）。最可靠。
    let candidates = []
    try {
      const all = await page.$$('.user-list-content li')
      for (const it of all) {
        const nameEl = await it.$('.name-text, .name-box .name-text, .name')
        const key = nameEl ? (await nameEl.innerText()).trim() : ''
        if (!key || (this.sentResume[key] && this.sentResume[key].resume)) continue  // 已发过
        const unread = await it.$('.notice-badge')                // 红色未读数字 = HR 有新消息
        if (!unread) continue
        candidates.push({ it, key })
      }
    } catch (_) {}
    if (candidates.length === 0) return
    this.log(`📬 ${candidates.length} 个会话疑似 HR 有新回复，逐个确认...`, 'info', 2)

    for (const { it: item, key } of candidates) {
      if (!this.flow2Running) break
      try {
        if (this.sentResume[key] && this.sentResume[key].resume) continue

        const clickTarget = (await item.$('.friend-content')) || item
        await this._humanClick(page, clickTarget)
        await this._humanPause(1300, 2200)

        // 二次确认：最后一条消息气泡必须是 HR 侧（.item-friend），否则是我最后说话，跳过
        const bubbles = await page.$$('.message-item')
        if (bubbles.length === 0) continue
        const lastCls = (await bubbles[bubbles.length - 1].getAttribute('class')) || ''
        if (!lastCls.includes('item-friend')) continue
        const lastMsg = (await bubbles[bubbles.length - 1].innerText()).trim()
        const st = this.sentResume[key] || {}

        if (!st.portfolio) {
          this.log(`💬 HR(${key}) 已回复："${lastMsg.slice(0, 24)}" → 发作品集+简历`, 'warn', 2)
          this.metrics.hrReply++; this.pushMetrics()
          this._recordReply((this.sessions[key] || {}).category)
          await this._sendPortfolio(page)               // 发作品集链接（未配置则跳过）
          st.portfolio = true
          await this._humanPause(800, 1500)
        }
        const okResume = await this._sendResumeAttachment(page)  // 发简历附件
        if (okResume) st.resume = new Date().toISOString()
        st.at = new Date().toISOString()
        this.sentResume[key] = st
        this._saveJson(this.sentResumePath, this.sentResume)
        this._markSession({ company: key }, { replied: true, portfolio_sent: true, resume_sent: !!okResume, handed_over: !!okResume }, key)
        if (okResume) {
          this.metrics.resumeSent++; this.pushMetrics()
          this.log(`✅ 已向 ${key} 发送作品集+简历，交回你手动沟通`, 'ok', 2)
          this.emit('event', { type: 'notify', title: '已送达', body: `已向 ${key} 发送作品集+简历，请接手沟通` })
        } else {
          this.log(`🔗 已发作品集；简历未发出（看下「发简历」按钮选择器）`, 'warn', 2)
        }
      } catch (e) { this.log(`处理会话失败：${e.message}`, 'warn', 2) }
    }
  }

  /** 第1步：发作品集链接（只发链接，无客套话）。未配置作品集则跳过 */
  async _sendPortfolio(page) {
    const portfolio = (this._flow2Opts || {}).portfolio || ''
    if (!portfolio) { this.log('  未配置作品集链接（设置页填一下），本次跳过发作品集', 'warn', 2); return false }
    try {
      const inputBox = await page.$("textarea.input, textarea.chat-input, div[contenteditable='true'], textarea")
      if (!inputBox) { this.log('  未找到聊天输入框', 'warn', 2); return false }
      await this._humanClick(page, inputBox)
      await this._humanType(page, portfolio)
      await this._humanPause(300, 600)
      await page.keyboard.press('Enter')   // BOSS：Enter 发送
      await this._humanPause(700, 1200)
      return true
    } catch (e) { this.log(`  发作品集失败：${e.message}`, 'warn', 2); return false }
  }

  /**
   * 发简历附件（真机实测的完整流程）：
   *   触发入口二选一 → ① HR 主动求简历卡片的「同意」(span.card-btn)；② 工具栏「发简历」(未到双方回复带 .unable，禁用)
   *   两者都会弹出「请选择要发送的简历」对话框 .choose-resume-dialog
   *   → 选中匹配名字的简历(.list-item，选中后加 .selected) → 点「发送」(.btn-confirm，选中后才不 disabled)
   */
  async _sendResumeAttachment(page) {
    const want = (this._flow2Opts || {}).resumeName || '海外新媒体运营'  // 优先发这份
    try {
      let opened = false
      // 入口①：HR 求简历卡片「同意」
      const agree = await page.$('.card-btn:has-text("同意"), .btn-agree:has-text("同意")')
      if (agree) {
        await this._humanClick(page, agree); await this._humanPause(900, 1600); opened = true
      } else {
        // 入口②：工具栏「发简历」（需双方回复，否则 .unable 禁用）
        const btn = await page.$('.toolbar-btn:has-text("发简历")')
        if (btn) {
          const cls = (await btn.getAttribute('class')) || ''
          if (cls.includes('unable') || cls.includes('disabled')) {
            this.log('  「发简历」暂不可用（需双方回复）', 'info', 2); return false
          }
          await this._humanClick(page, btn); await this._humanPause(900, 1600); opened = true
        }
      }
      if (!opened) { this.log('  未找到「同意」或「发简历」入口', 'warn', 2); return false }

      // 选择简历对话框
      const dlg = await page.$('.choose-resume-dialog')
      if (!dlg) { this.log('  📎 已触发发简历（未见选择框，可能已直接发送）', 'ok', 2); return true }

      const items = await page.$$('.choose-resume-dialog .list-item')
      let picked = null
      for (const it of items) {
        const n = await it.$('.resume-name')
        const t = n ? (await n.innerText()).trim() : ''
        if (t.includes(want)) { picked = it; break }
      }
      if (!picked && items.length) picked = items[0]   // 没匹配到就发第一份
      if (picked) { await this._humanClick(page, picked); await this._humanPause(500, 900) }

      const send = await page.$('.choose-resume-dialog .btn-confirm:not(.disabled)')
      if (!send) { this.log('  发送按钮未就绪（没选中简历？）', 'warn', 2); return false }
      await this._humanClick(page, send)
      await this._humanPause(900, 1500)
      this.log(`  📎 已发送简历（${want}）`, 'ok', 2)
      return true
    } catch (e) { this.log(`  发简历失败：${e.message}`, 'warn', 2); return false }
  }

  _markSession(job, patch, keyOverride) {
    const key = keyOverride || job.company || job.title
    if (!key) return
    this.sessions[key] = { ...(this.sessions[key] || {}), ...patch }
    this._saveJson(this.sessionsPath, this.sessions)
  }

  async shutdown() {
    this.flow1Running = false; this.flow2Running = false
    if (this._flow2Timer) { clearInterval(this._flow2Timer); this._flow2Timer = null }
    try { if (this.browser) await this.browser.close() } catch (_) {}
  }
}

module.exports = { BossAgent, DEFAULTS, DIMENSIONS, MY_PROFILE_DEFAULT }
