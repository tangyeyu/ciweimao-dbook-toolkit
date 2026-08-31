@echo off
chcp 65001 >nul
cd /d %~dp0
start "" http://127.0.0.1:8793
node txt2shelf_panel.mjs 8793
pause
