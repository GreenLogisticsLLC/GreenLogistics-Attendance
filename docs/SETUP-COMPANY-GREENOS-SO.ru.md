# Полная настройка: Company → Green OS → so.greengrouplogistics.com

Пошаговая инструкция для cPanel. Делайте **по порядку**, не пропуская шаги.

---

## Как это будет работать

```
greengrouplogistics.com
    → меню Company → GreenOS
    → greenos.html (логин + пароль)
    → автоматически so.greengrouplogistics.com (внутренняя система)

Роли:
  Owner / Administrator — полный доступ (все вкладки, настройки, удаление)
  Manager — управление сотрудниками, без части настроек
  Viewer — только просмотр
```

---

# ЧАСТЬ A. Поддомен so.greengrouplogistics.com (внутренняя система)

## Шаг A1. Создать поддомен в cPanel

1. Войдите в **cPanel**.
2. Откройте **Domains** → **Subdomains** (или **Create a New Domain**).
3. Создайте поддомен:
   - **Subdomain:** `so`
   - **Domain:** `greengrouplogistics.com`
   - **Document Root:** оставьте по умолчанию (например `/home/ijh19zqesepn/so.greengrouplogistics.com`)
4. Нажмите **Create**.

Подождите 5–30 минут, пока DNS обновится.

---

## Шаг A2. GitHub — репозиторий Attendance

На вашем компьютере в папке `GreenLogistics-Attendance`:

1. Запустите **`PUSH-TO-GITHUB.bat`** (или вручную создайте репозиторий на github.com).
2. Репозиторий: `GreenLogisticsLLC/GreenLogistics-Attendance`.

---

## Шаг A3. Клонировать репозиторий на сервер

1. cPanel → **Git Version Control**.
2. **Clone**:
   - **Clone URL:** `https://github.com/GreenLogisticsLLC/GreenLogistics-Attendance.git`
   - **Repository Path:** `/home/ijh19zqesepn/repositories/GreenLogistics-Attendance`
3. **Create**.

---

## Шаг A4. Файл .env на сервере

1. cPanel → **File Manager**.
2. Перейдите в `/home/ijh19zqesepn/repositories/GreenLogistics-Attendance`.
3. Скопируйте `.env.example` → `.env`.
4. Откройте `.env` и задайте:

```env
DATABASE_URL="file:./data/attendance.db"
JWT_SECRET=длинный-случайный-секрет-минимум-32-символа
WEBHOOK_SECRET=токен-для-считывателей-дверей
TIMEZONE=America/Los_Angeles
COMPANY_NAME=Green Logistics
CORS_ORIGINS=https://greengrouplogistics.com,https://www.greengrouplogistics.com
```

> **Важно:** файл `.env` не должен попадать в GitHub.

---

## Шаг A5. Node.js приложение на поддомене so

1. cPanel → **Setup Node.js App** → **Create Application**.
2. Заполните:

| Поле | Значение |
|------|----------|
| Node.js version | **20** (или 18) |
| Application mode | **Production** |
| Application root | `repositories/GreenLogistics-Attendance` |
| Application URL | **so.greengrouplogistics.com** |
| Application startup file | `dist/index.js` |

3. Нажмите **Create**.
4. В разделе приложения нажмите **Run NPM Install**.
5. Откройте **Terminal** (cPanel) и выполните:

```bash
cd /home/ijh19zqesepn/repositories/GreenLogistics-Attendance
npm run deploy:build
npx prisma db push
npx prisma db seed
```

6. В панели Node.js нажмите **Restart**.

**Проверка:** откройте `https://so.greengrouplogistics.com` — должна появиться страница входа Attendance.

---

## Шаг A6. Cron — автообновление (как у SeoGeo)

1. cPanel → **Cron Jobs**.
2. Добавьте задачу **Every 5 minutes**:

```
*/5 * * * * /bin/bash /home/ijh19zqesepn/repositories/GreenLogistics-Attendance/tools/cpanel-cron-deploy.sh
```

После каждого `git push` на GitHub сайт обновится в течение ~5 минут.

---

## Шаг A7. Создать учётную запись Owner (вы — владелец)

После `npx prisma db seed` есть пользователь **admin** / **Admin123!@Green**.

Чтобы у вас была роль **Owner** с полным доступом, в Terminal:

```bash
cd /home/ijh19zqesepn/repositories/GreenLogistics-Attendance
npx tsx -e "
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const role = await p.role.findUnique({ where: { roleName: 'Owner' } });
  const hash = await bcrypt.hash('ВАШ-НАДЁЖНЫЙ-ПАРОЛЬ', 12);
  await p.user.upsert({
    where: { username: 'owner' },
    update: { passwordHash: hash, roleId: role.roleId },
    create: {
      username: 'owner',
      email: 'ваш@email.com',
      passwordHash: hash,
      firstName: 'Ваше',
      lastName: 'Имя',
      roleId: role.roleId,
    },
  });
  console.log('Owner user ready');
  await p.\$disconnect();
})();
"
```

Замените email, имя и пароль на свои.

**Роли с полным доступом:** `Owner` и `Administrator`.

---

# ЧАСТЬ B. Основной сайт greengrouplogistics.com (Green OS вход)

## Шаг B1. Обновить GreenGroup на GitHub

На компьютере в папке **SEO GEO** (репозиторий GreenGroup):

1. Убедитесь, что в `assets/js/greenos-config.js` указано:

```javascript
window.GL_GREENOS_CONFIG = {
  apiBaseUrl: "https://so.greengrouplogistics.com/api/v1",
  appUrl: "https://so.greengrouplogistics.com/",
  users: []
};
```

2. Закоммитьте и отправьте:

```bash
git add assets/js/greenos-config.js assets/js/greenos.js
git commit -m "GreenOS login redirects to so.greengrouplogistics.com"
git push origin main
```

3. Подождите ~5 минут — cron GreenGroup обновит **greengrouplogistics.com**.

---

## Шаг B2. Проверить меню Company → GreenOS

1. Откройте **https://greengrouplogistics.com**
2. Меню **Company** → **GreenOS**
3. Должна открыться страница **greenos.html** с формой входа.

Если пункта нет — в навигации сайта уже есть ссылка `greenos.html` в выпадающем меню Company.

---

## Шаг B3. Проверить полный путь входа

1. **greengrouplogistics.com** → **Company** → **GreenOS**
2. Выберите роль **Owner**
3. Введите логин: `owner` (или `admin`) и ваш пароль
4. Нажмите **Sign in to GreenOS**
5. Браузер должен перейти на **https://so.greengrouplogistics.com** уже **внутри системы** (Dashboard), без повторного ввода пароля.

---

# ЧАСТЬ C. Права доступа

| Роль в Green OS | Роль в системе so | Доступ |
|-----------------|-------------------|--------|
| Owner | Owner | Полный: Dashboard, Reports, Administration, настройки, удаление |
| — | Administrator | То же, что Owner |
| Manager | Manager | Dashboard, Reports, Administration (без части настроек) |
| Accounting / Broker | Viewer | Только просмотр (по мере добавления модулей) |

Вкладка **Administration** видна только **Owner**, **Administrator** и **Manager**.

---

# ЧАСТЬ D. Проверочный список

- [ ] `https://so.greengrouplogistics.com` открывается
- [ ] `https://so.greengrouplogistics.com/api/health` возвращает `"status":"OK"`
- [ ] Cron Attendance настроен (каждые 5 мин)
- [ ] Cron GreenGroup работает (уже был для SeoGeo)
- [ ] `greenos-config.js` указывает на `so.greengrouplogistics.com`
- [ ] Вход с greengrouplogistics.com/greenos.html перенаправляет на so
- [ ] Owner видит вкладку Administration

---

# ЧАСТЬ E. Если что-то не работает

| Проблема | Решение |
|----------|---------|
| so.greengrouplogistics.com не открывается | Проверьте поддомен в cPanel, подождите DNS |
| Ошибка входа на greenos.html | Проверьте, что so запущен; откройте `/api/health` |
| CORS ошибка в браузере | В `.env` на сервере добавьте `CORS_ORIGINS` (шаг A4) |
| После входа снова просит пароль | Обновите `greenos.js` и `app.js` на сервере (git push + cron) |
| Нет вкладки Administration | У пользователя должна быть роль Owner или Administrator |

---

# Дальнейшие обновления

**Сайт (SeoGeo):** изменения в папке SEO GEO → `git push` в GreenGroup → cron обновит greengrouplogistics.com.

**Внутренняя система:** изменения в GreenLogistics-Attendance → `git push` → cron обновит so.greengrouplogistics.com.
