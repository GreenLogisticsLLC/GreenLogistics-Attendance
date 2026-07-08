@echo off
chcp 65001 >nul
title Green Logistics — PostgreSQL Setup
cd /d "%~dp0"

echo ========================================
echo  PostgreSQL Database Setup
echo ========================================
echo.
echo Before running, set DATABASE_URL in .env:
echo   DATABASE_URL="postgresql://user:password@localhost:5432/greenlogistics"
echo.

if not exist ".env" (
    copy /Y ".env.example" ".env" >nul
    echo Created .env — please edit DATABASE_URL for PostgreSQL.
    pause
    exit /b 1
)

call npm run setup:postgres
if errorlevel 1 (
    echo Setup failed.
    pause
    exit /b 1
)

echo.
echo PostgreSQL setup complete.
echo Run START.bat to start the server.
pause
