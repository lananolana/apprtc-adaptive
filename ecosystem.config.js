// ecosystem.config.js — конфигурация PM2 (процесс + автоматизация деплоя).
// Развёртываемся на VM 158.160.220.226 рядом с уже работающими mesto и
// kupipodariday. Используется тот же пользователь user и ключ
// ~/.ssh/ssh_keys/private_key.
//
// Использование (с локальной машины):
//   ssh-add ~/.ssh/ssh_keys/private_key          # один раз за сессию
//   pm2 deploy ecosystem.config.js production setup    # первый раз
//   pm2 deploy ecosystem.config.js production          # последующие обновления

module.exports = {
  apps: [
    {
      name: 'apprtc-adaptive',
      script: 'server/signaling.js',
      cwd: '/home/user/apprtc-adaptive/current',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 8080
      },
      max_memory_restart: '300M',
      autorestart: true,
      watch: false
    }
  ],

  deploy: {
    production: {
      user: 'user',
      host: '158.160.220.226',
      ref:  'origin/main',
      // Public-репо, поэтому HTTPS — на VM не нужен GitHub SSH-ключ
      repo: 'https://github.com/lananolana/apprtc-adaptive.git',
      path: '/home/user/apprtc-adaptive',
      'post-deploy':
        'npm install --omit=dev && pm2 reload ecosystem.config.js --update-env',
      'pre-setup': ''
    }
  }
};
