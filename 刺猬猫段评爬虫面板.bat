@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo   Ciweimao Tsukkomi Crawler Panel
echo   http://127.0.0.1:8788
echo   Close this window to stop the panel
echo ============================================
start "" http://127.0.0.1:8788
node ciweimao_vis_crawler.mjs
pause
