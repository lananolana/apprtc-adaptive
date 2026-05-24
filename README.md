# apprtc-adaptive

Исследовательский прототип к магистерской ВКР

> «Исследование и разработка механизмов адаптации качества видеопотоков
> в WebRTC-соединениях при изменении сетевых условий»

Алексеева С.И., МИСТ-24-3-2, НИТУ МИСИС, 2026.

## Что это

Клиентский слой адаптивного управления качеством видеопотока поверх baseline
WebRTC. Реализован как минимальный отдельный проект, использующий
архитектуру AppRTC (`webrtc/apprtc`) в качестве референса для клиентской части
и собственный минимальный сигналинг вместо устаревшего App Engine + Collider.

## Что взято из webrtc/apprtc

| Файл | Использование |
|---|---|
| `src/web_app/js/peerconnectionclient.js` | архитектурный референс; копия лежит в `client/baseline/peerconnectionclient.original.js` с сохранением BSD-заголовка |
| `src/web_app/js/sdputils.js` | копия в `client/baseline/sdputils.original.js`; функции SDP-манипуляций будут применяться для bitrate-cap |
| `src/app_engine/`, `src/collider/` | **не используется**, заменено на `server/signaling.js` |

См. `LICENSE-APPRTC.md`.

## Структура

```
apprtc-adaptive/
├── server/
│   └── signaling.js          # минимальный WS-сигналинг (Node + ws)
├── client/
│   ├── index.html
│   ├── app.js                # точка входа клиента
│   ├── ui/styles.css
│   ├── baseline/             # код из AppRTC как референс (исходники + лицензия)
│   └── adaptive/             # авторский вклад
│       ├── collector.js      # periodic getStats()
│       ├── aggregator.js     # EMA-сглаживание + QoE score
│       ├── policy.js         # ladder + гистерезис + audio-only
│       ├── actuator.js       # applyConstraints / setParameters
│       └── dashboard.js
├── docs/                     # черновики глав ВКР
├── package.json
└── README.md
```

## Запуск локально

```bash
cd adaptive-prototype
npm install
npm start
```

Открой `http://localhost:8080` в двух вкладках одного браузера, нажми
«Войти / создать» в первой, скопируй ссылку и вставь во вторую — пойдёт
peer-to-peer звонок между вкладками. Дашборд справа покажет телеметрию.

Тумблер `baseline` / `adaptive` переключает работу адаптивной политики.
В режиме `baseline` действуют только встроенные механизмы WebRTC;
в режиме `adaptive` подключается ступенчатая адаптация качества.

## Деплой

- **Хостинг:** Yandex Cloud Compute VM, Ubuntu 22.04, ~150–200 ₽/мес
  (или бесплатно по гранту нового аккаунта 4000 ₽ / 60 дней).
- **Процесс-менеджер:** PM2 + PM2 Deploy (git-based pull-deploy).
- **Реверс-прокси:** Nginx с TLS-сертификатом от Let's Encrypt (certbot).
- **Домен:** учебный `*.nomorepartiessite.ru`, A-запись на IP VM.
- **STUN:** публичный `stun.l.google.com:19302`.
- **TURN:** не используется на этом этапе; при необходимости — coturn
  на той же VM или Metered.ca (free 50 GB/мес).

Шаги развёртывания — см. `DEPLOY.md`. Файлы инфраструктуры:

```
ecosystem.config.cjs   # PM2 process + deploy
deploy/setup.sh       # одноразовая инициализация VM
deploy/nginx.conf     # vhost для reverse-proxy + WS upgrade
```

## Лицензии

- Файлы в `client/baseline/` — BSD 3-Clause, The WebRTC project authors, см. `LICENSE-APPRTC.md`.
- Авторский код (`server/`, `client/adaptive/`, `client/app.js`, `client/ui/`, `client/index.html`) — для целей ВКР, все права принадлежат автору.
