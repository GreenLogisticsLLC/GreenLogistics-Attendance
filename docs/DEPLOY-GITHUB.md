# GitHub + автоматическое обновление (как SeoGeo / GreenGroup)

## Репозиторий

```
https://github.com/GreenLogisticsLLC/GreenLogistics-Attendance
```

## Локальная работа

```bash
git add .
git commit -m "описание изменений"
git push origin main
```

После `push` в `main` сервер подтянет изменения по cron (как у папки SeoGeo).

## Первичная настройка на cPanel (один раз)

1. **GitHub** — создайте репозиторий `GreenLogistics-Attendance` в организации `GreenLogisticsLLC` (приватный).
2. **cPanel → Git Version Control → Clone**
   - URL: `https://github.com/GreenLogisticsLLC/GreenLogistics-Attendance.git`
   - Путь: `/home/ijh19zqesepn/repositories/GreenLogistics-Attendance`
3. **Файл `.env` на сервере** (не в git):
   ```bash
   cp .env.example .env
   # Отредактируйте JWT_SECRET, WEBHOOK_SECRET, DATABASE_URL
   ```
4. **cPanel → Setup Node.js App**
   - Application root: `repositories/GreenLogistics-Attendance`
   - Application URL: `attendance.greengrouplogistics.com` (или ваш поддомен)
   - Application startup file: `dist/index.js`
   - Node.js 18+ или 20
5. **Cron** (каждые 5 минут):
   ```
   /bin/bash /home/ijh19zqesepn/repositories/GreenLogistics-Attendance/tools/cpanel-cron-deploy.sh
   ```
6. Проверка: `https://attendance.greengrouplogistics.com/api/health` — поле `commit` должно совпадать с последним push.

## Webhook для считывателей (production)

```
POST https://attendance.greengrouplogistics.com/api/v1/webhook/attendance
Authorization: Bearer <WEBHOOK_SECRET из .env на сервере>
```
