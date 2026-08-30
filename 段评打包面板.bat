@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo   DBook Pack Panel
echo   http://127.0.0.1:8789
echo   Output goes to dbook_out\
echo   Close this window to stop the panel
echo ============================================
start "" http://127.0.0.1:8789
node dbook_pack_panel.mjs
pause
