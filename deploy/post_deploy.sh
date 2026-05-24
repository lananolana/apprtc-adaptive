#!/usr/bin/env bash
# post_deploy.sh — выполняется PM2 Deploy на сервере после git pull
# в каталоге /home/user/apprtc-adaptive/current
#
# Зачем отдельный файл:
#   PM2 deploy при передаче многошаговой команды через ssh добавляет
#   свой слой экранирования. Скобочные тесты [ ... ] и nested quotes
#   ломаются. Поэтому всю логику делаем в shell-скрипте — пересылается
#   одна простая команда `bash deploy/post_deploy.sh`.

set -eu

# 1. Активируем nvm — non-interactive ssh не читает ~/.bashrc, поэтому
#    node/npm/pm2 без явного source nvm.sh недоступны.
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
fi

echo "[post-deploy] node=$(node -v) npm=$(npm -v) pm2=$(pm2 -v)"

# 2. Зависимости
npm install --omit=dev

# 3. Перезапуск приложения через PM2
pm2 reload ecosystem.config.cjs --update-env

# 4. Сохранить текущий список процессов pm2 (чтобы переживало reboot)
pm2 save
