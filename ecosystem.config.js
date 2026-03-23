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
      // Limit restarts to prevent infinite loops
      max_restarts: 5,
      restart_delay: 5000,
      // Log configuration
      error_file: './logs/error.log',
      out_file: './logs/output.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
