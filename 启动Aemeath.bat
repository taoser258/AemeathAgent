@echo off
chcp 65001 >nul
title Aemeath Agent
cd /d "%~dp0"
echo 启动 Aemeath Agent（开发模式，关掉此窗口或按 Ctrl+C 即停止）...
npm run dev
pause
