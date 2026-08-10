# Автообновление на so.greengrouplogistics.com

Поддомен **so.greengrouplogistics.com** — production для Green Logistics Attendance (как **greengrouplogistics.com** для SeoGeo / GreenGroup).

## Схема

```
Ваш ПК: git push → GitHub (GreenLogistics-Attendance)
                         ↓
cPanel cron (каждые 5 мин): git pull + npm build + restart Node.js
                         ↓
https://so.greengrouplogistics.com
```

## Репозиторий GitHub

```
https://github.com/GreenLogisticsLLC/GreenLogistics-Attendance
```

Локально после изменений:

```bash
git add .
git commit -m "описание"
git push origin main
```

Через ~5 минут изменения появятся на **so.greengrouplogistics.com**.

---

## Первичная настройка на cPanel (один раз)

### 1. GitHub — репозиторий

На вашем ПК запустите **`PUSH-TO-GITHUB.bat`** (или создайте репозиторий вручную на github.com).

### 2. cPanel → Git Version Control → Clone

| Поле | Значение |
|------|----------|
| Clone URL | `https://github.com/GreenLogisticsLLC/GreenLogistics-Attendance.git` |
| Repository Path | `/home/ijh19zqesepn/repositories/GreenLogistics-Attendance` |

### 3. Файл `.env` на сервере

В SSH или File Manager в папке репозитория:

```bash
cd /home/ijh19zqesepn/repositories/GreenLogistics-Attendance
cp .env.example .env
```

Отредактируйте `.env` (файл **не** в git):

```env
DATABASE_URL="file:./data/attendance.db"
JWT_SECRET="длинный-случайный-секрет"
WEBHOOK_SECRET="токен-для-считывателей"
TIMEZONE=America/Los_Angeles
COMPANY_NAME=Green Logistics
# PORT задаёт cPanel автоматически — не меняйте API_PORT на сервере
```

### 4. cPanel → Setup Node.js App

| Поле | Значение |
|------|----------|
| Node.js version | 18 или 20 |
| Application mode | Production |
| Application root | `repositories/GreenLogistics-Attendance` |
| Application URL | **so.greengrouplogistics.com** |
| Application startup file | `dist/index.js` |

После создания приложения нажмите **Run NPM Install**, затем в терминале cPanel (или SSH):

```bash
cd /home/ijh19zqesepn/repositories/GreenLogistics-Attendance
npm run deploy:build
npx prisma db push
npx prisma db seed   # только первый раз — создаёт admin и смены
```

Перезапустите приложение в панели Node.js.

### 5. Cron (каждые 5 минут)

cPanel → Cron Jobs:

```
*/5 * * * * /bin/bash /home/ijh19zqesepn/repositories/GreenLogistics-Attendance/tools/cpanel-cron-deploy.sh
```

Это тот же принцип, что у GreenGroup:

```
*/5 * * * * /bin/bash /home/ijh19zqesepn/repositories/GreenGroup/tools/cpanel-cron-deploy.sh
```

### 6. Проверка

Откройте в браузере:

- Сайт: **https://so.greengrouplogistics.com**
- Health: **https://so.greengrouplogistics.com/api/health** — поле `commit` = последний push в GitHub
- Версия: **https://so.greengrouplogistics.com/deploy-version.txt**

Вход: **admin** / **Admin123!@Green** (смените пароль после первого входа).

---

## Webhook для считывателей (production)

```
POST https://so.greengrouplogistics.com/api/v1/webhook/attendance
Authorization: Bearer <WEBHOOK_SECRET из .env на сервере>
Content-Type: application/json
```

---

## Если обновление не применилось

1. Проверьте cron: `deploy-check.txt` в папке репозитория на сервере.
2. Запустите вручную:
   ```bash
   /bin/bash /home/ijh19zqesepn/repositories/GreenLogistics-Attendance/tools/cpanel-cron-deploy.sh
   ```
3. В cPanel Node.js — **Restart** приложения.
4. Убедитесь, что `git push` ушёл в ветку **main**.
