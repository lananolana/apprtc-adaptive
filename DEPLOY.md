# Деплой прототипа на Yandex Cloud

Развёртываем **рядом с уже работающим** `mesto`-проектом на той же VM
(`158.160.220.226`, аккаунт `schoegar@yandex.ru`). PM2 умеет держать
несколько приложений одновременно, nginx — несколько vhost'ов; конфликта
нет, потому что у нас:

| Что | Существующие проекты | Новый `apprtc-adaptive` |
|---|---|---|
| Поддомен | `mestomesto.…`, `kpd.…` | `webrtcvkr.nomorepartiessite.ru` |
| nginx vhost | свои (по конвенции — имя файла = полный домен) | `/etc/nginx/sites-available/webrtcvkr.nomorepartiessite.ru` |
| PM2 app | `mesto-*`, `kupipodariday-backend` | `apprtc-adaptive` (порт 8080) |
| Путь на диске | `/home/user/mesto*`, `/home/user/kupipodariday` | `/home/user/apprtc-adaptive` |
| Git-репо | прежние | `github.com/lananolana/apprtc-adaptive` (public) |
| SSH | `ssh -i ~/.ssh/ssh_keys/private_key user@158.160.220.226` | то же |

```
[GitHub: apprtc-adaptive] --git--> [Compute VM, Ubuntu, 158.160.220.226]
                                      ├─ PM2  apprtc-adaptive (порт 8080)   ← новое
                                      ├─ PM2  mesto-*                       (как было)
                                      ├─ Docker  kupipodariday              (как было)
                                      └─ Nginx
                                          ├─ webrtcvkr.nomorepartiessite.ru → 127.0.0.1:8080
                                          ├─ mestomesto.…                   → (как было)
                                          └─ kpd.…, api.kpd.…               → (как было)
                                                ↑
   [учебный домен webrtcvkr.nomorepartiessite.ru, A → 158.160.220.226]
```

---

## Шаг 1. Создать GitHub-репозиторий и запушить код

Репозиторий уже создан: <https://github.com/lananolana/apprtc-adaptive>.

> ⚠️ В `adaptive-prototype/.git/` мог остаться полупустой служебный
> каталог от sandbox-окружения. Первым делом чистим его.

В терминале на твоей **локальной** машине:

```bash
cd ~/apprtc/adaptive-prototype
rm -rf .git
git init -b main
git config user.email "lanaalekseevaa@gmail.com"
git config user.name  "Светлана Алексеева"
git add .
git commit -m "Initial commit: adaptive WebRTC prototype"
git remote add origin git@github.com:lananolana/apprtc-adaptive.git
git push -u origin main
```

(Если SSH-ключ для GitHub не настроен — `https://github.com/lananolana/apprtc-adaptive.git`
и при пуше PAT вместо пароля.)

## Шаг 2. VM в Yandex Cloud — пропускается

VM `158.160.220.226` уже работает (использовалась для `mesto`).
Node 20, PM2, Nginx и certbot на ней установлены ещё в практике —
заново ставить не нужно. `deploy/setup.sh` оставлен в репозитории
только на случай переезда на новую машину.

## Шаг 3. Привязать учебный поддомен к IP — сделано

`webrtcvkr.nomorepartiessite.ru` → A-запись → `158.160.220.226`.
Проверка распространения DNS (на твоей машине):

```bash
dig +short webrtcvkr.nomorepartiessite.ru   # должен вернуть 158.160.220.226
# или
nslookup webrtcvkr.nomorepartiessite.ru
```

Если 1–5 минут после сохранения формы ответ всё ещё пустой — подождать
ещё пару минут, кэши DNS бывают ленивыми.

## Шаг 4. Развернуть приложение через PM2 Deploy

Сначала убедимся, что порт 8080 на VM свободен (kupipodariday-бэкенд
смотрит наружу на `4000`, фронт — на `8081`; mesto обычно на `3000/3001`):

```bash
ssh -i ~/.ssh/ssh_keys/private_key user@158.160.220.226 \
    'ss -ltn | grep :8080 || echo free'
# должно вывести: free
```

Если занят — поменяй `PORT` в `ecosystem.config.js` (например, `8090`) и
такой же `proxy_pass` в `deploy/nginx.conf`.

Теперь добавим SSH-ключ в агент один раз за сессию (PM2 Deploy
использует его для подключения к VM и для будущих pull'ов):

```bash
ssh-add ~/.ssh/ssh_keys/private_key
```

И с **локальной** машины (НЕ с VM):

```bash
cd ~/apprtc/adaptive-prototype

# Первый раз: pm2 склонирует репозиторий в /home/user/apprtc-adaptive
pm2 deploy ecosystem.config.js production setup

# Собственно деплой — pull + npm install --omit=dev + pm2 reload
pm2 deploy ecosystem.config.js production
```

Проверка:

```bash
ssh -i ~/.ssh/ssh_keys/private_key user@158.160.220.226 'pm2 status'
# должен появиться apprtc-adaptive | online

ssh -i ~/.ssh/ssh_keys/private_key user@158.160.220.226 \
    'curl -s http://127.0.0.1:8080/healthz'
# → ok
```

PM2 уже зарегистрирован в systemd с прошлых проектов, новое приложение
переживёт перезагрузку VM автоматически. Чтобы оно действительно
сохранилось в pm2-resurrect-листе, на VM один раз:

```bash
ssh -i ~/.ssh/ssh_keys/private_key user@158.160.220.226 'pm2 save'
```

## Шаг 5. Поднять Nginx vhost + HTTPS (рядом с mesto и kpd)

Заходим на VM:

```bash
ssh -i ~/.ssh/ssh_keys/private_key user@158.160.220.226
```

Дальше — на сервере. По твоей конвенции имя файла vhost = полный домен:

```bash
# Копируем заготовку из репо (он склонировался в Шаге 4)
sudo cp /home/user/apprtc-adaptive/current/deploy/nginx.conf \
        /etc/nginx/sites-available/webrtcvkr.nomorepartiessite.ru

# Активируем
sudo ln -sf /etc/nginx/sites-available/webrtcvkr.nomorepartiessite.ru \
            /etc/nginx/sites-enabled/webrtcvkr.nomorepartiessite.ru

# Проверка, что существующие конфиги (mesto, kpd) ничему не мешают
sudo nginx -t
sudo systemctl reload nginx

# TLS-сертификат от Let's Encrypt — certbot уже стоит с прошлых проектов
sudo certbot --nginx -d webrtcvkr.nomorepartiessite.ru
# certbot сам допишет ssl_*-блоки и редирект 80 → 443
```

Renewal-таймер certbot уже работает для `mestomesto.…` и `kpd.…`, новый
домен он подхватит автоматически — никаких дополнительных действий.

## Шаг 6. Проверить

```bash
# с любой машины:
curl https://webrtcvkr.nomorepartiessite.ru/healthz   # → ok
```

Открой `https://webrtcvkr.nomorepartiessite.ru` в браузере — увидишь
интерфейс прототипа. Открой в двух браузерах (или на двух компах),
нажми «Войти / создать», скопируй ссылку, вставь во второй — пойдёт
WebRTC-звонок.

QR на эту ссылку поставишь на каждый слайд презентации — генератор
любой (например, <https://www.qrcode-monkey.com/>), URL короткий и
читается камерой даже издалека.

## Обновления

Локально:

```bash
git add -A && git commit -m "..."  && git push
pm2 deploy ecosystem.config.js production    # pull → install → reload
```

## Если P2P не устанавливается между разными сетями

См. секцию **«TURN»** в `README.md` — добавим Metered.ca или свой
coturn на ту же VM (10 минут).
