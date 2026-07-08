@echo off
REM Stops the attendance server and waits for file locks to release.
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr :3847 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)
taskkill /IM tsx.exe /F >nul 2>&1
timeout /t 3 /nobreak >nul
