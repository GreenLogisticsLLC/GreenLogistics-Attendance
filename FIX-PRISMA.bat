@echo off
chcp 65001 >nul
title Green Logistics — Fix Prisma EPERM
cd /d "%~dp0"

echo ========================================
echo  Fix Prisma file lock (EPERM error)
echo ========================================
echo.

call scripts\stop-server.bat

echo Removing locked Prisma client cache...
if exist "node_modules\.prisma" rmdir /s /q "node_modules\.prisma" 2>nul
timeout /t 2 /nobreak >nul

echo Regenerating Prisma client...
call npm run db:generate
if errorlevel 1 (
    echo.
    echo FAILED. Try:
    echo   1. Pause OneDrive sync for this folder
    echo   2. Close Cursor/VS Code and run this again
    echo   3. Move project out of OneDrive Desktop folder
    pause
    exit /b 1
)

echo Updating database schema...
call npm run db:push -- --skip-generate
if errorlevel 1 call npm run db:push

echo.
echo Fixed. Now run START.bat
pause
