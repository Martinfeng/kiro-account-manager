module.exports = {
  apps: [{
    name: 'kiro2api-node',
    script: './src/index.js',
    instances: 1,
    exec_mode: 'fork',

    // 加载 .env 文件
    env_file: '.env',

    // 环境变量（.env 文件优先级更高）
    env: {
      NODE_ENV: 'production'
    },

    // 日志配置
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: false,

    // 自动重启配置
    watch: false,
    ignore_watch: [
      'node_modules',
      'logs',
      'data',
      '.git'
    ],

    // 重启策略
    max_memory_restart: '500M',
    min_uptime: '10s',
    max_restarts: 10,
    autorestart: true,

    // 进程管理
    kill_timeout: 5000,
    listen_timeout: 3000,
    shutdown_with_message: true,

    // 其他配置
    time: true,
    node_args: '--max-old-space-size=512'
  }]
};
