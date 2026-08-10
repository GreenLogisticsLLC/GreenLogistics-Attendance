# Green Logistics Attendance Management System

Система учёта посещаемости сотрудников Green Logistics LLC.

## Возможности

- Приём webhook-событий от системы контроля доступа (Legacy Reader / Pico)
- Автоматическое создание сессий посещаемости
- Определение опозданий (grace period 15 минут)
- Отслеживание выходов и возвращений в офис
- Live Dashboard с автообновлением каждые 5 секунд
- Управление сотрудниками и картами доступа
- Журнал webhook-запросов и уведомления

## Быстрый старт (Windows)

1. Установите [Node.js LTS](https://nodejs.org/)
2. Дважды щёлкните **`START.bat`**
3. Откройте http://localhost:3847
4. Войдите: **admin** / **Admin123!@Green**

## GitHub и автообновление на so.greengrouplogistics.com

Как у **greengrouplogistics.com** (SeoGeo / GreenGroup):

1. **`PUSH-TO-GITHUB.bat`** — отправить код на GitHub.
2. На cPanel — clone + Node.js + cron по **`docs/DEPLOY-SO-SUBDOMAIN.ru.md`**.

**Production:** https://so.greengrouplogistics.com

Репозиторий: `https://github.com/GreenLogisticsLLC/GreenLogistics-Attendance`

После `git push origin main` сервер обновится автоматически (cron каждые 5 мин).

## Интеграция с устройствами доступа

Настройте в системе контроля доступа webhook:

```
POST http://<ваш-сервер>:3847/api/v1/webhook/attendance
Authorization: Bearer <WEBHOOK_SECRET из .env>
Content-Type: application/json
```

Формат payload (Legacy Reader):

```json
{
  "profile_id": "186",
  "device_id": "12",
  "token": "0aab3c5d",
  "external_ref": "ORD-10045",
  "decision": "enter",
  "direction": "in",
  "scanned_at": "2026-07-03T17:02:00+04:00"
}
```

- `decision`: `"enter"` или `"exit"`
- `token` — UID карты (сопоставляется с `card_number` сотрудника)
- `external_ref` — ваш ID билета (сопоставляется с `external_ref` сотрудника)

## Структура проекта

```
GreenLogistics-Attendance/
├── src/                    # Backend (Express + TypeScript)
│   ├── services/           # Attendance Engine, Business Rules
│   ├── repositories/       # Database access
│   ├── controllers/        # API handlers
│   └── routes/             # REST routes
├── frontend/public/        # Dashboard UI
├── prisma/                 # Database schema + seed
├── docs/                   # Architecture documentation
└── data/                   # SQLite database (auto-created)
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/auth/login` | Авторизация |
| GET | `/api/v1/dashboard` | Live dashboard |
| POST | `/api/v1/webhook/attendance` | Webhook от СКД |
| GET | `/api/v1/employees` | Список сотрудников |
| GET | `/api/v1/reports/daily` | Дневной отчёт |
| GET | `/api/health` | Health check |

## Смены по умолчанию

| Смена | Начало | Конец | Grace |
|-------|--------|-------|-------|
| Day Shift | 17:00 | 01:00 | 15 min |
| Night Shift | 00:00 | 05:00 | 15 min |

## Конфигурация (.env)

```env
DATABASE_URL="file:./data/attendance.db"
JWT_SECRET="your-secret"
WEBHOOK_SECRET="your-webhook-token"
API_PORT=3847
TIMEZONE=Asia/Yerevan
```

## Синхронизация карт на устройство (Ingest API)

Система отправляет карты сотрудников **на** сервер Legacy Reader:

```
POST {LEGACY_API_URL}/api/legacy/ingest
Authorization: Bearer {LEGACY_INGEST_TOKEN}
```

Настройка:
1. В `.env` или в **Administration → Device Integration** укажите URL и ingest-токен
2. Нажмите **Sync All Cards** или **Sync** у отдельного сотрудника
3. Включите **Auto-sync** для автоматической отправки при создании/редактировании

## PostgreSQL (production)

1. Установите PostgreSQL 16+
2. Создайте базу: `CREATE DATABASE greenlogistics_attendance;`
3. В `.env` установите:
   ```
   DATABASE_URL="postgresql://user:password@localhost:5432/greenlogistics_attendance"
   ```
4. Запустите **`SETUP-POSTGRES.bat`** или `npm run setup:postgres`

Для разработки используется SQLite (по умолчанию).

## Админ-панель

После входа как **Administrator** или **Manager**:
- Вкладка **Administration** — управление сотрудниками
- Добавление/редактирование/деактивация сотрудников
- Синхронизация карт с устройством
- Настройка Legacy API (только Administrator)

## Тест webhook

```bash
curl -X POST http://localhost:3847/api/v1/webhook/attendance \
  -H "Authorization: Bearer webhook-dev-secret" \
  -H "Content-Type: application/json" \
  -d "{\"device_id\":\"12\",\"token\":\"0aab3c5d\",\"external_ref\":\"ORD-10045\",\"decision\":\"enter\",\"scanned_at\":\"2026-07-03T17:08:00+04:00\"}"
```

## Документация

Полная архитектурная спецификация: `docs/MASTER_SPECIFICATION.md.txt`

Интеграция партнёра: `PARTNER-INTEGRATION.ru.md`
