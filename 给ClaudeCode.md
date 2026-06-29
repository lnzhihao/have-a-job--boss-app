# 如何把这个项目交给 Claude Code

## 一句话操作

把整个 `boss-agent-app` 文件夹用 Claude Code 打开，然后对它说：

> 读一下 SPEC.md，基于 src/ 里的 Electron 骨架和 reference/boss_agent.py 参考实现，
> 帮我把这个 BOSS 直聘自动化 App 做完。重点是两个流程要能在界面上实时看到运行状态，
> 流程二（HR回复后秒发简历）要尽量快。先从流程一跑通开始。

Claude Code 会读规格、看现有代码、然后一步步帮你实现。

## 具体步骤

### 终端版 Claude Code
```bash
cd 你解压的路径/boss-agent-app
claude
```
进入后输入上面那段话即可。

### 桌面版 Claude Code（Claude 桌面 App 里的 Code 标签）
打开桌面 App → Code → 选择 `boss-agent-app` 文件夹作为项目 → 在对话框输入上面那段话。

## 文件夹里有什么

- `SPEC.md` ← 最重要，完整需求规格，Claude Code 主要读这个
- `src/main.js` ← Electron 主进程骨架
- `src/index.html` ← 悬浮窗口界面（已有 UI，需接真实数据）
- `reference/boss_agent.py` ← Python 参考实现，逻辑可复用
- `package.json` ← 项目配置
- `一键启动.sh` ← Mac 启动脚本

## ✅ 已完成（Claude Code 实现说明）

App 已做完，两个流程都接了真实 Playwright + Claude，界面实时回显。新增/改动文件：

- `src/engine.js` ← 新增。Playwright 自动化引擎（流程一打招呼、流程二监听发简历、Claude 评分、会话状态机），所有动作通过事件实时上报。
- `src/main.js` ← 接入引擎、IPC 转发 `agent-event`、流程启停、简历 PDF 选择对话框。
- `src/index.html` ← 删掉模拟日志，改成监听真实事件；新增「流程一 / 流程二」两个独立启停按钮；设置页加了简历 PDF、作品集链接、评分模型选择；指标「自动回复」改为「已发简历」。
- `package.json` ← 加了 `playwright` 和 `@anthropic-ai/sdk` 依赖。

本地数据存在 Electron userData 目录：`config.json`（配置）、`storage_state.json`（登录态）、`sent_resume.json`（防重复发简历）、`sessions.json`（会话状态机）、`stats.json`（行业回复率与历史评分）。

## ✨ 为西沙定制的增强能力（v2）

- **读简历 PDF**：设置里选简历 PDF，引擎用 `pdf-parse` 读取全文，喂给 AI 做评分和建议，做到“百分百贴合你本人”。
- **10 维度匹配打分**：每个职位由 Claude 从「技能/行业/经验/薪资/地点/职责/团队/出海方向/成长/成功率」10 个维度打分（各 0-100）+ 综合分，「建议」页可看最近一次的维度条形图。
- **行业回复率统计**：按搜索方向统计「打招呼数 / HR回复数 / 回复率」，「建议」页有排行表，回复率越高说明该方向越适配你。
- **AI 求职建议模块**：「建议」页点「生成建议」，AI 结合简历 + 各方向回复率，给出该聚焦哪类岗位、简历怎么改、薪资定位、话术改进等可执行建议。
- **24h 本地自动化**：设置里开「24 小时持续运行」，投满当日额度后等待，次日额度自动重置继续投。
- **规避 HR 不在线**：①「仅在 HR 活跃时段操作」（默认 9–20 点，可改，可周末暂停），不在时段就自动等待；②「HR 不活跃跳过」（读职位卡上的活跃文案，超过 N 天没上线的 HR 不投）。
- **拟人物理操作避风控**：真实鼠标轨迹移动+按下抬起（trusted 事件，非 JS click）、逐字变速打字、列表随机滚动、随机停顿，并抹掉 `navigator.webdriver` 等自动化指纹，降低被 BOSS 识别为机器投递的概率。

## 运行步骤

```bash
npm install                      # 装依赖
npx playwright install chromium  # 装浏览器内核（首次必须，约 150MB）
npm start                        # 启动 App
```

使用顺序：
1. 打开「设置」→ 填 Anthropic API Key、选评分模型、选简历 PDF、填作品集链接 → 保存配置。
2. 回「规则」页 → 点「🚀 流程一」开始打招呼，或「👂 流程二」开始监听 HR 回复。两个可同时跑。
3. 首次启动会弹出浏览器，请扫码登录 BOSS（仅一次，登录态会保存复用）。

> ⚠️ BOSS 前端的 class 经常变。引擎里每个关键元素都准备了 2-3 个备选选择器（在 `src/engine.js` 里），若某天点不动，优先更新那里的 selector。

## 🔬 真机校准记录（2026-06 实测，linzhihao 账号登录态）

用 Claude in Chrome 实操了一遍真实页面，确认并修正了选择器，引擎已按「详情优先」改造：

| 位置 | 真实选择器 | 备注 |
|------|-----------|------|
| 搜索列表 | `https://www.zhipin.com/web/geek/jobs?query=…&city=101280600` | 注意是 `jobs`（复数）；不要带 `salary=` 参数，否则会按 BOSS 自己的薪资档过滤掉 13-15k |
| 职位卡 | `.job-card-box`（li） | 不是 `.job-card-wrapper`（那是「推荐」页布局） |
| 卡内标题/链接 | `a.job-name`（href=`/job_detail/xxx.html`） | **薪资在列表里被隐藏成「-K」，必须进详情页读** |
| 卡内公司/地区 | `.company-name` / `.job-area` | ✓ 地区含「深圳·南山区·科技园」 |
| 详情页薪资 | `.salary`（也有 `.badge`） | ✓ 「15-25K」 |
| 详情页 JD | `.job-sec-text`（兜底 `.job-detail-section`） | ✓ 完整描述，用于 10 维评分 |
| 详情页 HR 状态 | `.job-boss-info .name` 文本含「在线」 | 用于活跃度过滤 |
| 打招呼按钮 | `a.btn-startchat`（详情页；列表右侧详情面板用 `a.op-btn-chat`） | 文案「立即沟通」；若是「继续沟通」=已聊过，自动跳过 |
| 消息页 | `https://www.zhipin.com/web/geek/chat` | **不是 `/web/im/`（会被弹回首页）** |
| 聊天输入框 | `textarea.input` | 不是 contenteditable |
| 会话条目 | `.user-list-content li`（41条实测） | 名字 `.name-text`；时间 `.time`；最后消息 `.last-msg` |
| 我发的消息标记 | 条目内 `.message-status`（[送达]/[已读]） | 用来判断「最后一句是不是我说的」 |
| 消息气泡 | HR=`.item-friend`，我=`.item-myself`，统一 `.message-item` | **判断 HR 回复=最后一条 `.message-item` 是 `.item-friend`** |
| 聊天输入框 | `textarea.input` | Enter 发送、**Ctrl+Enter 换行**（多行别用 Shift+Enter） |
| 未读触发 | `.notice-badge`（条目内红色数字 span） | HR 有新消息=未读，最可靠的触发信号 |
| 工具栏发简历 | `.toolbar-btn`（含「发简历」） | **未到「双方回复」时带 `.unable`（禁用，aria-label「求简历：双方回复后可用」）**，点了无效 |
| HR 主动求简历 | 卡片里 `span.card-btn`（文字「同意」/「拒绝」） | HR 发「我想要一份您的附件简历，您是否同意」卡片，点「同意」走选简历弹框 |
| 选简历弹框 | `.choose-resume-dialog` | 点「同意」或「发简历」后弹出，列出已上传简历 |
| 简历选项 | `.choose-resume-dialog .list-item`（名字 `.resume-name`，选中加 `.selected`） | 西沙有3份：作品集/国内新媒体运营/海外新媒体运营 |
| 发送按钮 | `.choose-resume-dialog .btn-confirm`（未选简历时 `disabled`） | 选中简历后才可点 |

> 流程一：列表抓 标题/公司/地区/详情链接 → 逐个打开详情页读 薪资/JD/HR活跃 → 薪资(≥13k)+区域+活跃度筛 → 用完整 JD 做 10 维评分(≥60) → 点 `a.btn-startchat`，**用 BOSS 默认招呼语**（不自拟话术，按用户要求）。
> 流程二（**海投单发，无任何自拟客套话**）：扫 `.user-list-content li`，用 **`.notice-badge` 未读** 触发 → 点开会话确认最后气泡 `.item-friend` → 发作品集链接(`textarea.input`+Enter) + 发简历附件。简历附件流程：先找 HR 求简历卡片的「同意」`.card-btn`，没有就用工具栏「发简历」(`.unable` 则跳过) → 弹 `.choose-resume-dialog` → 选含「海外新媒体运营」的 `.list-item` → 点 `.btn-confirm` 发送。进度 `sent_resume.json` `{portfolio, resume}` 防重复；要发哪份简历由 `resumeName`(默认「海外新媒体运营」)决定。
> ⚠️ 选择器待真用时确认：①「发简历」确认框按钮(best-effort，实测没在真实 HR 上点)；②流程一点「立即沟通」后若 BOSS 不自动发默认招呼语而是弹框，确认框按钮已尽量覆盖，必要时补 `_sendGreeting` 的 confirm 选择器。
> 简历附件用 BOSS 里你已上传的那份（原生「发简历」），所以设置页的简历 PDF 路径只是 input[type=file] 兜底；作品集链接必须在设置页填，否则第1步会跳过。
