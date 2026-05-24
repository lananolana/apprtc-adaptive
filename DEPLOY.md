# Деплой прототипа

Развёртывание состоит из двух коротких шагов. Совокупно — ~5 минут.

## Шаг 1. Инициализировать локальный git и запушить на GitHub

> ⚠️ В папке `adaptive-prototype/.git/` может остаться полупустой
> служебный каталог — я пыталась проинициализировать репозиторий, но
> sandbox-окружение, в котором я выполняю команды, имеет ограниченные
> права на твою файловую систему. Поэтому первый шаг — почистить и
> переинициализировать репо в твоём терминале, где у тебя полные права.

### 1.1 Создать репозиторий на GitHub

1. Открой <https://github.com/new>
2. Имя репозитория: `apprtc-adaptive` (или любое другое).
3. Видимость: **Public** (так Render бесплатно подцепит репозиторий).
4. **Не** ставь галочки «Add a README», «Add .gitignore», «Choose a license».
   Репо должен быть пустым — иначе будет конфликт с локальным коммитом.
5. Нажми «Create repository». GitHub покажет URL вида
   `https://github.com/USERNAME/apprtc-adaptive.git`.

### 1.2 Инициализировать и запушить

В терминале на твоей машине (замени `USERNAME` на свой GitHub-логин):

```bash
cd ~/apprtc/adaptive-prototype

# Чистим возможный полупустой .git от sandbox
rm -rf .git

# Инициализация и первый коммит
git init -b main
git config user.email "lanaalekseevaa@gmail.com"
git config user.name  "Светлана Алексеева"
git add .
git commit -m "Initial commit: adaptive WebRTC prototype"

# Подключение GitHub и пуш
git remote add origin https://github.com/USERNAME/apprtc-adaptive.git
git push -u origin main
```

При HTTPS-пуше Git попросит логин и Personal Access Token (Settings →
Developer settings → Personal access tokens → Tokens (classic) → Generate
new token, scope `repo`). Если используешь SSH-ключ — подставь URL
`git@github.com:USERNAME/apprtc-adaptive.git` вместо HTTPS-варианта.

Замени `USERNAME` на свой GitHub-логин. Если у тебя не настроен SSH-ключ для
GitHub — используй HTTPS-вариант, GitHub предложит его рядом:

```bash
git remote add origin https://github.com/USERNAME/apprtc-adaptive.git
```

При HTTPS-пуше Git попросит логин и пароль; вместо пароля используется
**Personal Access Token** (Settings → Developer settings → Personal access
tokens → Tokens (classic) → Generate new token, scope `repo`). Это
одноразовая процедура.

## Шаг 2. Подключить репозиторий к Render

1. Открой <https://render.com> и нажми «Get Started for Free».
2. Выбери «Sign up with GitHub», подтверди доступ Render к репозиториям.
3. На дашборде нажми **New → Blueprint**.
4. Выбери репозиторий `apprtc-adaptive`.
5. Render обнаружит `render.yaml` и предложит создать сервис
   `apprtc-adaptive`. Нажми «Apply».
6. Подожди ~2 минуты — пройдёт build (`npm install`) и старт. В логах
   ожидается строчка `[signaling] listening on http://...`.
7. Render выдаст публичный URL вида `https://apprtc-adaptive.onrender.com`.

## Шаг 3. Проверить

- Открой `https://apprtc-adaptive.onrender.com` — должна загрузиться
  страница прототипа.
- `https://apprtc-adaptive.onrender.com/healthz` должен отдать `ok`.
- Открой URL в двух вкладках и проверь звонок (как локально).
- Дай URL коллеге / открой на втором компьютере → проверь звонок между
  устройствами.

## Особенности free-tier Render

- Сервис **засыпает через 15 минут** простоя. Первый запрос после сна
  возвращается за ~30 секунд (cold start). Для защиты — пробуди сервис
  один раз за 1–2 минуты до начала демонстрации (просто открой URL).
- Бесплатно: 750 часов работы в месяц, ~512 MB RAM, без привязки карты.
- TLS-сертификат выдаётся автоматически, HTTPS работает «из коробки».

## Если P2P не устанавливается между двумя сетями

Признаки: `iceConnectionState` уходит в `checking` и не переходит в
`connected`. Решение — добавить TURN-сервер. Самый быстрый бесплатный
вариант — Metered.ca (50 GB / месяц).

1. <https://www.metered.ca/tools/openrelay/> → Sign up.
2. Получишь блок ICE-серверов с `username` и `credential`.
3. В `client/app.js` обнови `RTC_CONFIG`:

```js
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: '<твой_username>',
      credential: '<твой_credential>'
    }
  ]
};
```

4. `git commit -am "Add TURN" && git push` — Render задеплоит автоматически.
