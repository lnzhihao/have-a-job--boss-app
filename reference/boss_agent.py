"""
BOSS直聘 Auto-Agent
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
功能：自动筛选职位 → AI评分 → 打招呼投递 → 自动回复 HR 消息
作者：为西沙定制 | 深圳·南山/前海 | 跨境电商+AI Agent 岗位

依赖安装：
    pip install playwright anthropic pyyaml loguru
    playwright install chromium

运行方式：
    python boss_agent.py              # 正常运行（有界面）
    python boss_agent.py --headless   # 无头模式（Mac Mini 后台）
    python boss_agent.py --reply-only # 只处理消息回复
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import asyncio
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from loguru import logger
from playwright.async_api import async_playwright, Page, Browser
import anthropic

# ─────────────────────────────────────────
# 配置区（根据自己情况修改）
# ─────────────────────────────────────────
CONFIG = {
    # 地理位置（职位地址包含以下任意词则通过）
    "areas": ["南山", "前海", "宝安"],

    # 薪资（单位：k/月）
    "min_salary": 15,       # 低于此值直接跳过
    "target_salary": 20,    # 低于此值降优先级

    # 目标岗位关键词（职位名包含任意一个则进入评分）
    "job_keywords": [
        "TikTok Shop", "跨境电商", "海外运营", "出海运营",
        "AI Agent", "AI运营", "自动化运营", "社媒运营", "独立站"
    ],

    # AI 评分阈值（低于此分数跳过）
    "min_score": 60,

    # 每日最大投递数（BOSS 免费沟通约30次/天）
    "daily_limit": 25,

    # HR 活跃度：超过 N 天未活跃则跳过
    "hr_inactive_days": 3,

    # 是否过滤低评分公司（基于页面显示的Boss评分）
    "filter_low_rated": True,
    "min_company_rating": 3.5,

    # 打招呼间隔（秒），避免操作过快
    "delay_between": (8, 15),  # 随机区间

    # Cookie 文件路径（首次手动登录后保存）
    "cookie_file": "boss_cookies.json",

    # 日志文件
    "log_file": "boss_agent.log",
}

# ─────────────────────────────────────────
# 我的背景信息（用于 AI 生成话术）
# ─────────────────────────────────────────
MY_PROFILE = """
姓名：西沙
经验：约18个月 TikTok Shop 实操经验（美国+巴西双市场）
核心能力：
  - TikTok Shop 全链路运营（达人矩阵、短视频内容、Shop Ads、选品）
  - AI Agent 工作流落地（选品→脚本→视频生成→发布全链路自动化）
  - 跨境品牌孵化（D8 3C电子品牌 TikTok 三账号矩阵）
  - 内容营销服务机构 Gainova 创始人
所在地：深圳南山
目标薪资：20-28k，具体面谈
"""

# ─────────────────────────────────────────
# 打招呼话术模板
# ─────────────────────────────────────────
GREETING_TEMPLATES = {
    "tiktok_focused": (
        "您好，看到贵司在招{job_title}，"
        "我有约18个月TikTok Shop实操经验（美国+巴西双市场），"
        "熟悉达人矩阵、短视频AI工作流和Shop Ads。"
        "目前在深圳，可随时沟通～"
    ),
    "ai_agent_focused": (
        "Hi，关注到贵司{job_title}职位，"
        "我在跨境运营中深度落地了AI Agent工作流——"
        "从产品选品、短视频脚本到自动发布全链路自动化。"
        "欢迎了解具体案例 :)"
    ),
    "general": (
        "您好！看到{job_title}职位很感兴趣，"
        "我有跨境电商运营和AI自动化工作流实战经验，"
        "坐标深圳南山，欢迎进一步沟通～"
    ),
}

# 自动回复规则（关键词 → 回复内容）
AUTO_REPLY_RULES = [
    {
        "keywords": ["电话", "方便沟通", "通话", "打个电话"],
        "reply": "方便！请问您这边什么时候联系方便？我随时都可以 😊"
    },
    {
        "keywords": ["薪资", "薪酬", "期望薪资", "工资"],
        "reply": "期望在20-28k之间，具体根据岗位职责和团队情况面谈，弹性很大～"
    },
    {
        "keywords": ["在职", "离职", "到岗", "多久能来"],
        "reply": "目前在找新机会，可以随时到岗，最快一周内 👍"
    },
    {
        "keywords": ["简历", "发一下", "发份"],
        "reply": "好的，稍后发给您！请问您这边邮箱是？或者我直接在BOSS上传附件简历～"
    },
]


# ─────────────────────────────────────────
# 核心 Agent 类
# ─────────────────────────────────────────
class BossAgent:
    def __init__(self, headless: bool = False):
        self.headless = headless
        self.client = anthropic.AsyncAnthropic()
        self.sent_today = 0
        self.skipped_today = 0
        self.replied_today = 0
        self.page: Page = None
        self.browser: Browser = None

        # 配置日志
        logger.remove()
        logger.add(sys.stderr, format="<green>{time:HH:mm:ss}</green> | <level>{message}</level>")
        logger.add(CONFIG["log_file"], rotation="1 day", retention="7 days")

    # ── 登录 ──────────────────────────────
    async def ensure_logged_in(self):
        """检查登录状态，未登录则等待手动扫码"""
        cookie_file = Path(CONFIG["cookie_file"])

        if cookie_file.exists():
            cookies = json.loads(cookie_file.read_text())
            await self.page.context.add_cookies(cookies)
            await self.page.goto("https://www.zhipin.com/web/geek/job-recommend")
            await self.page.wait_for_timeout(2000)

            # 检查是否真的登录成功
            if "login" not in self.page.url:
                logger.info("✅ Cookie 登录成功")
                return

        logger.warning("⚠️  未检测到登录状态，请在浏览器中手动扫码登录...")
        await self.page.goto("https://www.zhipin.com/web/user/")
        logger.info("等待登录（最多60秒）...")

        # 等待登录完成（URL 不再含 login）
        try:
            await self.page.wait_for_url(
                lambda url: "login" not in url and "zhipin.com" in url,
                timeout=60000
            )
        except Exception:
            logger.error("登录超时，请重试")
            raise

        # 保存 Cookie
        cookies = await self.page.context.cookies()
        cookie_file.write_text(json.dumps(cookies, ensure_ascii=False, indent=2))
        logger.info(f"✅ 登录成功，Cookie 已保存到 {cookie_file}")

    # ── 解析薪资 ─────────────────────────
    @staticmethod
    def parse_salary(salary_text: str) -> tuple[int, int]:
        """'15-25K' → (15, 25)，失败返回 (0, 0)"""
        text = salary_text.upper().replace("，", "").replace(",", "")
        nums = re.findall(r'\d+\.?\d*', text)
        if len(nums) >= 2:
            lo, hi = float(nums[0]), float(nums[1])
            # 处理年薪（一般>100则是年薪/12）
            if "年" in salary_text or (lo > 100 and hi > 100):
                return int(lo / 12), int(hi / 12)
            return int(lo), int(hi)
        elif len(nums) == 1:
            v = int(float(nums[0]))
            return v, v
        return 0, 0

    # ── 区域检查 ─────────────────────────
    @staticmethod
    def check_area(location: str) -> bool:
        return any(area in location for area in CONFIG["areas"])

    # ── 关键词检查 ───────────────────────
    @staticmethod
    def check_keywords(job_title: str) -> bool:
        return any(kw.lower() in job_title.lower() for kw in CONFIG["job_keywords"])

    # ── AI 职位评分 ───────────────────────
    async def score_job(self, job_info: dict) -> dict:
        """调用 Claude 对职位进行匹配度评分"""
        prompt = f"""你是一个专业的求职顾问。请根据候选人背景对以下职位进行匹配度评分。

候选人背景：
{MY_PROFILE}

职位信息：
- 职位名称：{job_info.get('title', '')}
- 公司名称：{job_info.get('company', '')}
- 薪资范围：{job_info.get('salary', '')}
- 工作地点：{job_info.get('location', '')}
- 职位描述：{job_info.get('description', '（未获取）')}

请输出 JSON（只输出JSON，不要其他内容）：
{{
  "score": 85,
  "recommend": true,
  "template": "tiktok_focused",
  "reason": "简短说明原因（20字以内）",
  "priority": "high"
}}

template 从以下选择：tiktok_focused / ai_agent_focused / general
priority 从以下选择：high / medium / low
"""
        try:
            resp = await self.client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=200,
                messages=[{"role": "user", "content": prompt}]
            )
            text = resp.content[0].text.strip()
            # 提取 JSON
            match = re.search(r'\{.*\}', text, re.DOTALL)
            if match:
                return json.loads(match.group())
        except Exception as e:
            logger.warning(f"AI 评分失败: {e}")

        # 兜底评分
        return {"score": 50, "recommend": False, "template": "general", "reason": "评分失败"}

    # ── AI 生成回复 ───────────────────────
    async def generate_reply(self, hr_message: str, job_context: str = "") -> str:
        """根据 HR 消息生成智能回复"""

        # 先走规则匹配（快速、省 token）
        for rule in AUTO_REPLY_RULES:
            if any(kw in hr_message for kw in rule["keywords"]):
                logger.info(f"📋 规则匹配回复: {rule['reply'][:20]}...")
                return rule["reply"]

        # 规则不匹配则调用 Claude
        prompt = f"""你是西沙，一个有18个月TikTok Shop经验的跨境电商运营，正在找工作。

HR发来的消息："{hr_message}"
职位上下文：{job_context or '跨境电商/AI运营相关'}

请生成一条专业、友好的回复，要求：
1. 字数在15-40字之间
2. 语气自然，不要过于正式
3. 如果 HR 在问问题，要明确回答
4. 只输出回复内容，不要任何解释
"""
        try:
            resp = await self.client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=100,
                messages=[{"role": "user", "content": prompt}]
            )
            return resp.content[0].text.strip()
        except Exception as e:
            logger.warning(f"AI 回复生成失败: {e}")
            return "感谢您的消息！请问方便进一步沟通吗？😊"

    # ── 搜索职位 ─────────────────────────
    async def search_jobs(self, keyword: str) -> list[dict]:
        """在 BOSS 直聘搜索职位列表"""
        search_url = (
            f"https://www.zhipin.com/web/geek/job"
            f"?query={keyword}&city=101280600&salary=406"  # 101280600=深圳, salary=406约15k+
        )
        await self.page.goto(search_url)
        await self.page.wait_for_timeout(2000)

        jobs = []
        try:
            job_cards = await self.page.query_selector_all(".job-card-wrapper")
            for card in job_cards[:20]:  # 每次最多处理20个
                try:
                    title_el = await card.query_selector(".job-name")
                    salary_el = await card.query_selector(".salary")
                    company_el = await card.query_selector(".company-name")
                    location_el = await card.query_selector(".job-area")
                    link_el = await card.query_selector("a.job-card-left")

                    title = await title_el.inner_text() if title_el else ""
                    salary = await salary_el.inner_text() if salary_el else ""
                    company = await company_el.inner_text() if company_el else ""
                    location = await location_el.inner_text() if location_el else ""
                    href = await link_el.get_attribute("href") if link_el else ""

                    jobs.append({
                        "title": title.strip(),
                        "salary": salary.strip(),
                        "company": company.strip(),
                        "location": location.strip(),
                        "url": f"https://www.zhipin.com{href}" if href else "",
                        "description": "",
                        "_element": card,
                    })
                except Exception:
                    continue
        except Exception as e:
            logger.warning(f"解析职位列表失败: {e}")

        return jobs

    # ── 发送投递 ─────────────────────────
    async def send_application(self, job: dict, score_result: dict) -> bool:
        """点击「立即沟通」并发送打招呼消息"""
        template_name = score_result.get("template", "general")
        greeting = GREETING_TEMPLATES[template_name].format(
            job_title=job["title"]
        )

        try:
            # 点击职位卡片进入详情
            card = job.get("_element")
            if card:
                await card.click()
                await self.page.wait_for_timeout(1500)

            # 寻找「立即沟通」按钮
            btn_selectors = [
                "a.btn-startchat",
                "button.btn-primary:has-text('立即沟通')",
                ".job-op a:has-text('立即沟通')",
                ".chat-btn",
            ]
            chat_btn = None
            for sel in btn_selectors:
                chat_btn = await self.page.query_selector(sel)
                if chat_btn:
                    break

            if not chat_btn:
                logger.warning(f"  未找到沟通按钮: {job['title']}")
                return False

            await chat_btn.click()
            await self.page.wait_for_timeout(1500)

            # 在聊天框输入打招呼
            input_sel = "div.chat-input[contenteditable='true'], textarea.chat-input, .input-area"
            input_box = await self.page.query_selector(input_sel)
            if input_box:
                await input_box.click()
                await self.page.keyboard.type(greeting, delay=30)
                await self.page.wait_for_timeout(500)

                # 发送
                send_btn = await self.page.query_selector("button.btn-send, .send-btn")
                if send_btn:
                    await send_btn.click()
                else:
                    await self.page.keyboard.press("Enter")

                await self.page.wait_for_timeout(1000)
                logger.success(f"  ✅ 投递成功 [{score_result['score']}分] {job['title']} · {job['company']}")
                return True

        except Exception as e:
            logger.warning(f"  投递失败 {job['title']}: {e}")

        return False

    # ── 处理消息 ─────────────────────────
    async def process_messages(self):
        """检查并回复 HR 未读消息"""
        logger.info("📬 检查未读消息...")
        await self.page.goto("https://www.zhipin.com/web/im/")
        await self.page.wait_for_timeout(2000)

        try:
            # 找所有未读对话
            unread = await self.page.query_selector_all(".chat-item.unread, .session-item .unread")
            logger.info(f"  发现 {len(unread)} 条未读消息")

            for item in unread:
                try:
                    await item.click()
                    await self.page.wait_for_timeout(1500)

                    # 获取最新一条 HR 消息
                    msg_els = await self.page.query_selector_all(".chat-message.left .message-content")
                    if not msg_els:
                        continue

                    last_msg = await msg_els[-1].inner_text()
                    last_msg = last_msg.strip()

                    logger.info(f"  HR: {last_msg[:30]}...")

                    # 生成回复
                    reply = await self.generate_reply(last_msg)
                    logger.info(f"  我: {reply[:30]}...")

                    # 输入并发送
                    input_box = await self.page.query_selector(
                        "div[contenteditable='true'].chat-input, textarea.chat-textarea"
                    )
                    if input_box:
                        await input_box.click()
                        await self.page.keyboard.type(reply, delay=30)
                        await self.page.wait_for_timeout(500)
                        send_btn = await self.page.query_selector("button.btn-send")
                        if send_btn:
                            await send_btn.click()
                        else:
                            await self.page.keyboard.press("Enter")

                        self.replied_today += 1
                        await self.page.wait_for_timeout(1000)

                except Exception as e:
                    logger.warning(f"  处理消息失败: {e}")
                    continue

        except Exception as e:
            logger.warning(f"消息处理异常: {e}")

    # ── 主流程 ────────────────────────────
    async def run(self, reply_only: bool = False):
        import random

        async with async_playwright() as p:
            self.browser = await p.chromium.launch(
                headless=self.headless,
                args=["--no-sandbox", "--disable-blink-features=AutomationControlled"]
            )
            context = await self.browser.new_context(
                viewport={"width": 1280, "height": 800},
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                )
            )
            self.page = await context.new_page()

            logger.info("=" * 50)
            logger.info("🤖 BOSS直聘 Auto-Agent 启动")
            logger.info(f"   目标区域: {', '.join(CONFIG['areas'])}")
            logger.info(f"   薪资要求: {CONFIG['min_salary']}k+")
            logger.info(f"   每日上限: {CONFIG['daily_limit']} 次")
            logger.info("=" * 50)

            # 登录
            await self.ensure_logged_in()

            if reply_only:
                # 仅回复模式
                await self.process_messages()
                logger.info(f"✅ 回复完成，共回复 {self.replied_today} 条")
                return

            # 先处理未读消息
            await self.process_messages()

            # 搜索关键词列表
            search_keywords = [
                "TikTok Shop运营",
                "跨境电商运营",
                "AI Agent运营",
                "海外社媒运营",
            ]

            for keyword in search_keywords:
                if self.sent_today >= CONFIG["daily_limit"]:
                    logger.warning(f"⚠️  已达今日投递上限 {CONFIG['daily_limit']}，停止")
                    break

                logger.info(f"\n🔍 搜索: {keyword}")
                jobs = await self.search_jobs(keyword)
                logger.info(f"   找到 {len(jobs)} 个职位")

                for job in jobs:
                    if self.sent_today >= CONFIG["daily_limit"]:
                        break

                    # 基础筛选
                    if not self.check_keywords(job["title"]):
                        self.skipped_today += 1
                        continue

                    if not self.check_area(job["location"]):
                        logger.info(f"  ⏭  区域不符: {job['title']} ({job['location']})")
                        self.skipped_today += 1
                        continue

                    lo, hi = self.parse_salary(job["salary"])
                    if hi > 0 and hi < CONFIG["min_salary"]:
                        logger.info(f"  ⏭  薪资不达标: {job['title']} ({job['salary']})")
                        self.skipped_today += 1
                        continue

                    # AI 评分
                    logger.info(f"  🤔 评分中: {job['title']} · {job['salary']} · {job['location']}")
                    score_result = await self.score_job(job)
                    score = score_result.get("score", 0)

                    if score < CONFIG["min_score"]:
                        logger.info(f"  ⏭  评分过低({score}分): {job['title']}")
                        self.skipped_today += 1
                        continue

                    logger.info(f"  ⭐ 评分 {score}/100 — {score_result.get('reason', '')}")

                    # 投递
                    success = await self.send_application(job, score_result)
                    if success:
                        self.sent_today += 1

                    # 随机延迟
                    delay = random.uniform(*CONFIG["delay_between"])
                    await asyncio.sleep(delay)

            # 完成统计
            logger.info("\n" + "=" * 50)
            logger.info(f"✅ 本次运行完成")
            logger.info(f"   投递: {self.sent_today} 个")
            logger.info(f"   跳过: {self.skipped_today} 个")
            logger.info(f"   回复: {self.replied_today} 条")
            logger.info("=" * 50)

            await self.browser.close()


# ─────────────────────────────────────────
# 入口
# ─────────────────────────────────────────
if __name__ == "__main__":
    headless = "--headless" in sys.argv
    reply_only = "--reply-only" in sys.argv

    agent = BossAgent(headless=headless)
    asyncio.run(agent.run(reply_only=reply_only))
