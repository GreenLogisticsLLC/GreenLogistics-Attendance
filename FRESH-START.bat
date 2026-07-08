@echo off
chcp 65001 >nul
title Green Logistics — Fresh Start
cd /d "%~dp0"

echo.
echo ============================================
echo   GREEN LOGISTICS — НАЧАТЬ С НУЛЯ
echo ============================================
echo.
echo 1. Запускаю сервер...
echo.

call scripts\stop-server.bat >nul 2>&1
timeout /t 2 /nobreak >nul

start "Green Logistics Server" cmd /k "cd /d %~dp0 && npm run dev"

timeout /t 5 /nobreak >nul

echo 2. Откройте в браузере: http://localhost:3847
echo.
echo 3. Войдите: admin / Admin123!@Green
echo.
echo 4. Administration:
echo    - Delete — удалить старого сотрудника (Tatev)
echo    - Быстрая регистрация — добавить заново
echo    - Test Webhook (local) — проверить программу
echo.
echo 5. Webhook для Legacy Reader (скопируйте из Administration):
echo    http://ВАШ-IP:3847/api/v1/webhook/attendance
echo    Токен: change-this-webhook-bearer-token
echo.
echo    Узнать IP: ipconfig  (строка IPv4 Wi-Fi)
echo.
echo 6. OPEN-FIREWALL.bat — запустить от имени администратора
echo.
start http://localhost:3847
echo.
pause
