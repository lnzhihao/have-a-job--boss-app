#!/bin/bash
# 用「调试模式」打开你的 Chrome —— BOSS Agent 要连接的就是这个 Chrome。
# 双击本文件即可。它会：关闭当前 Chrome → 用你的登录配置档重新打开 + 开启调试端口 9222。
# 之后在这个 Chrome 里确认已登录 BOSS（zhipin.com），再回 BOSS Agent 点「连接 Chrome」。

PORT=9222
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ ! -f "$CHROME" ]; then
  echo "❌ 没找到 Google Chrome，请确认已安装在 /Applications。"
  read -n 1 -s -r -p "按任意键关闭…"; exit 1
fi

echo "→ 关闭正在运行的 Chrome（请先保存好正在编辑的内容）..."
osascript -e 'quit app "Google Chrome"' 2>/dev/null
sleep 2

echo "→ 以调试模式（端口 $PORT）重新打开 Chrome，用你的默认配置档（保留登录态）..."
"$CHROME" --remote-debugging-port=$PORT --profile-directory=Default \
  --restore-last-session >/dev/null 2>&1 &

sleep 2
echo ""
echo "✅ 已用调试模式打开 Chrome。"
echo "   1) 在这个 Chrome 里打开 zhipin.com 确认已登录 BOSS；"
echo "   2) 回到 BOSS Agent 网页，点「连接 Chrome」→「流程一」开始。"
echo ""
read -n 1 -s -r -p "按任意键关闭本窗口…"
