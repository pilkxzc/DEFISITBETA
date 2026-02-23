# DEFISITBETA 🚀

**DEFIS Browser** — це мінімалістичний антидетект-браузер на базі Electron з власним бекенд-сервером для управління профілями, проксі та завданнями.

---

## 📂 Структура проекту

- `page/` — Клієнтська частина (Electron App).
  - `lib/` — Логіка управління (auth, proxy, profiles, etc.).
  - `main.js` — Вхідна точка Electron.
- `page/defis-server/` — Серверна частина (Node.js + SQLite).
  - `routes/` — API ендпоінти.
  - `db.js` — Робота з базою даних.
- `docs/` — Детальна документація (Архітектура, Агенти, Збірка).

---

## 🛠 Швидкий старт

### 1. Встановлення залежностей
Виконайте команду в корені проекту:
```bash
npm run install:all
```

### 2. Налаштування
Скопіюйте приклад конфігурації для сервера:
```bash
cp page/defis-server/.env.example page/defis-server/.env
```

### 3. Запуск
**Запуск сервера (Backend):**
```bash
npm run start:server
```
Або в режимі розробки:
```bash
npm run dev:server
```

**Запуск браузера (Frontend):**
```bash
npm run start:client
```

---

## 📦 Збірка (Build)

Проект підтримує збірку під різні ОС через `electron-builder`:

- **Linux (AppImage):** `npm run build:linux`
- **Windows (NSIS):** `npm run build:win`

Зібрані файли з'являться в директорії `page/dist/`.

---

## 📜 Документація
Більше деталей ви знайдете в папці `docs/`:
- [Архітектура](./docs/ARCHITECTURE.md)
- [Налаштування сервера](./docs/SERVER.md)
- [Робота з антидетектом](./docs/ANTIDETECT.md)
- [Інструкція зі збірки](./docs/BUILD.md)

---

## 🤝 Контакти
- **Сайт:** [defis.app](https://defis.app)
- **Підтримка:** support@defis.app
