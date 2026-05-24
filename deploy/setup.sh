#!/usr/bin/env bash
# setup.sh — одноразовая инициализация Ubuntu 22.04 VM в Yandex Cloud.
# Запускать на самой машине (по ssh) из-под пользователя yc-user:
#   curl -fsSL https://raw.githubusercontent.com/<USERNAME>/apprtc-adaptive/main/deploy/setup.sh | bash
# либо склонировать репо и выполнить bash deploy/setup.sh
#
# Что делает:
#   1. Обновляет apt
#   2. Ставит Node.js 20.x (через NodeSource)
#   3. Ставит pm2 глобально, делает pm2 startup
#   4. Ставит nginx
#   5. Ставит certbot + плагин для nginx
#   6. Открывает firewall (если включен ufw)
#
# После выполнения — настройка domain A-записи, копирование deploy/nginx.conf
# и запрос TLS-сертификата выполняются вручную (см. DEPLOY.md).

set -euo pipefail

echo "[1/6] apt update"
sudo apt-get update -y

echo "[2/6] Node.js 20.x"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

echo "[3/6] pm2"
sudo npm install -g pm2
pm2 -v
# регистрируем pm2 в systemd, чтобы пережил перезагрузку
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | sudo bash || true

echo "[4/6] nginx"
sudo apt-get install -y nginx
sudo systemctl enable --now nginx

echo "[5/6] certbot"
sudo apt-get install -y certbot python3-certbot-nginx

echo "[6/6] firewall (если включен)"
if sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow OpenSSH || true
  sudo ufw allow 'Nginx Full' || true
fi

echo
echo "Готово. Дальше:"
echo "  1) Положи deploy/nginx.conf в /etc/nginx/sites-available/apprtc-adaptive"
echo "  2) ln -s /etc/nginx/sites-available/apprtc-adaptive /etc/nginx/sites-enabled/"
echo "  3) sudo nginx -t && sudo systemctl reload nginx"
echo "  4) sudo certbot --nginx -d <твой-домен.nomorepartiessite.ru>"
