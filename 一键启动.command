#!/bin/bash
# ============================================================
# BOSS 找工作 Agent · 一键启动
# 双击本文件即可：自动开调试 Chrome → 启动后台 → 自动开跑 → 弹出桌面数据看板
# 第一次用：在弹出的 Chrome 里登录一次 BOSS；在看板「设置」里填 DeepSeek key 并保存。
# ============================================================
cd "$(dirname "$0")"
PORT=9222
URL="http://localhost:8848"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ ! -f "$CHROME" ]; then
  echo "❌ 没找到 Google Chrome（需安装在 /Applications）。"; read -n 1 -s -r -p "按任意键关闭…"; exit 1
fi

echo "→ (1/4) 用调试模式打开你的 Chrome（保留登录态）..."
osascript -e 'quit app "Google Chrome"' 2>/dev/null
sleep 2
"$CHROME" --remote-debugging-port=$PORT --profile-directory=Default --restore-last-session >/dev/null 2>&1 &
sleep 3

if [ ! -d node_modules ]; then
  echo "→ 首次使用，安装依赖（等几分钟，仅此一次）..."
  npm install >/dev/null 2>&1
fi

echo "→ (2/4) 启动后台并自动开跑..."
# 先关掉可能残留的旧后台
pkill -f "node server.js" 2>/dev/null; sleep 1
BOSS_AUTOSTART=1 BOSS_NO_OPEN=1 npm start >/tmp/boss-agent.log 2>&1 &

echo "→ (3/4) 等待后台就绪..."
for i in $(seq 1 25); do curl -s -o /dev/null "$URL" && break; sleep 1; done

echo "→ (4/4) 打开桌面数据看板窗口..."
"$CHROME" --app="$URL" >/dev/null 2>&1 &

echo ""
echo "✅ 启动完成！"
echo "   · 请在 Chrome 里确认已登录 BOSS（zhipin.com）"
echo "   · 桌面看板窗口会实时显示：打招呼数 / 发简历数 / 匹配度 / 公司 / 薪资"
echo "   · 第一次若看板提示「没填 API Key」：在看板「设置」里填 DeepSeek key→保存→再双击本文件一次"
echo ""
echo "（本窗口可关闭，程序会在后台继续运行；要停就关掉看板窗口和 Chrome）"
read -n 1 -s -r -p "按任意键关闭本提示窗口…"
