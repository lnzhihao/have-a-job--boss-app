#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then echo "首次启动，正在安装依赖（请等几分钟）..."; npm install; fi
echo "启动中... 浏览器会自动打开 http://localhost:8848"
npm start
