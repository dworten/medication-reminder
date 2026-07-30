'use strict';

module.exports = {
  apps: [
    {
      name:               'medication-reminder',
      script:             'app.js',
      instances:          1,
      autorestart:        true,
      watch:              false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      out_file:        './logs/pm2-out.log',
      error_file:      './logs/pm2-err.log',
      merge_logs:      true,
    },
  ],
};
