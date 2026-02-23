# DEFIS Server API Documentation Reference

Всі запити повинні мати заголовок `Content-Type: application/json`.
Для захищених маршрутів використовується `Authorization: Bearer <token>`.

## 🔐 Auth (`/api/auth`)
- `POST /api/auth/register` — Реєстрація нового користувача.
- `POST /api/auth/login` — Вхід (повертає JWT токен).
- `GET /api/auth/me` — Отримання даних поточного користувача.

## 👥 Profiles (`/api/profiles`)
- `GET /api/profiles` — Список всіх профілів.
- `POST /api/profiles` — Створення нового профілю (fingerprint, proxy).
- `GET /api/profiles/:id` — Дані конкретного профілю.
- `PUT /api/profiles/:id` — Оновлення налаштувань.
- `DELETE /api/profiles/:id` — Видалення профілю.

## 🔖 Bookmarks, Notes, History (через `/api/profiles`)
Ці ресурси прив'язані до профілів:
- `GET /api/profiles/:id/bookmarks` — Закладки профілю.
- `POST /api/profiles/:id/bookmarks` — Додати закладку.
- `GET /api/profiles/:id/notes` — Нотатки.
- `GET /api/history` — Глобальна історія (залежно від реалізації).

## ⚙️ Config & Admin (`/api/config`, `/api/admin`)
- `GET /api/config` — Отримання глобальних налаштувань браузера.
- `POST /api/admin/setup` — Первинне налаштування сервера.

## 📦 Version (`/api/version`)
- `GET /api/version/check` — Перевірка наявності оновлень.
- `GET /api/version/download/:platform` — Посилання на завантаження останнього білду.

---
*Примітка: Детальні схеми JSON-об'єктів будуть додані після аналізу відповідних файлів у `routes/`.*
