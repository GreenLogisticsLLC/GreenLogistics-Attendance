@echo off
chcp 65001 >nul
title Green Logistics — Stop
cd /d "%~dp0"
call scripts\stop-server.bat
echo Server stopped.
echo You can close this window.
pause
