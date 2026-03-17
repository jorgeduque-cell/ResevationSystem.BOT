// PM2 Ecosystem Configuration
module.exports = {
  apps: [
    {
      name: 'reservation-bot',
      script: 'dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
      // Restart at 8:55 AM every day to ensure fresh process
      cron_restart: '55 8 * * *',
      // Log configuration
      error_file: './logs/error.log',
      out_file: './logs/output.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
