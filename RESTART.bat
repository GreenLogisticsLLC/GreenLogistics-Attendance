@echo off
chcp 65001 >nul
title Green Logistics — Restart
cd /d "%~dp0"

echo Restarting server...
call scripts\stop-server.bat

echo.
echo Starting server...
echo Open: http://localhost:3847
echo.
call npm run dev
