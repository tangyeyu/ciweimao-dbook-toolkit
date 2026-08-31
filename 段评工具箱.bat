@echo off
chcp 65001 >nul
cd /d %~dp0
start "" http://127.0.0.1:8888
node dsh_toolbox.mjs 8888
pause
