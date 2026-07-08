@echo off
chcp 65001 >nul
echo Testing webhook — employee entry...
curl -s -X POST http://localhost:3847/api/v1/webhook/attendance ^
  -H "Authorization: Bearer change-this-webhook-bearer-token" ^
  -H "Content-Type: application/json" ^
  -d "{\"device_id\":\"12\",\"token\":\"0aab3c5d\",\"external_ref\":\"ORD-10045\",\"decision\":\"enter\",\"scanned_at\":\"2026-07-03T17:08:00+04:00\"}"
echo.
echo.
echo Testing webhook — employee exit...
curl -s -X POST http://localhost:3847/api/v1/webhook/attendance ^
  -H "Authorization: Bearer change-this-webhook-bearer-token" ^
  -H "Content-Type: application/json" ^
  -d "{\"device_id\":\"12\",\"token\":\"0aab3c5d\",\"external_ref\":\"ORD-10045\",\"decision\":\"exit\",\"scanned_at\":\"2026-07-03T18:31:00+04:00\"}"
echo.
pause
