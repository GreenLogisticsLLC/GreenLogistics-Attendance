@echo off
chcp 65001 >nul
title Green Logistics — Push to GitHub
cd /d "%~dp0"

echo.
echo === Green Logistics Attendance — GitHub ===
echo.
echo Remote: https://github.com/GreenLogisticsLLC/GreenLogistics-Attendance
echo.

where gh >nul 2>&1
if errorlevel 1 (
    echo GitHub CLI not found. Install from: https://cli.github.com/
    echo Or push manually after creating the repo on github.com
    pause
    exit /b 1
)

echo Step 1: GitHub login (if not logged in yet)
gh auth status >nul 2>&1
if errorlevel 1 (
    gh auth login
)

echo.
echo Step 2: Create repo on GitHub (skip if already exists)
gh repo create GreenLogisticsLLC/GreenLogistics-Attendance --private --source=. --remote=origin --push 2>nul
if errorlevel 1 (
    echo Repo may already exist — pushing to origin main...
    git push -u origin main
) else (
    echo Repo created and pushed.
)

echo.
echo Done. Open: https://github.com/GreenLogisticsLLC/GreenLogistics-Attendance
echo.
echo Next: set up cPanel for so.greengrouplogistics.com (see docs\DEPLOY-SO-SUBDOMAIN.ru.md)
pause
