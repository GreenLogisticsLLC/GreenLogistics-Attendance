@echo off
chcp 65001 >nul
title Green Logistics — Open Firewall Port 3847
echo.
echo This allows other devices on your network to send webhooks to Attendance.
echo Run this script as Administrator (right-click - Run as administrator).
echo.

netsh advfirewall firewall delete rule name="Green Logistics Attendance 3847" >nul 2>&1
netsh advfirewall firewall add rule name="Green Logistics Attendance 3847" dir=in action=allow protocol=TCP localport=3847

if %errorlevel% equ 0 (
    echo OK — port 3847 is open for incoming connections.
) else (
    echo FAILED — right-click this file and choose "Run as administrator".
)

echo.
pause
