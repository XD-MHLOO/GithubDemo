module.exports = {
  apps: [
    {
      name: 'backend',                    // Name in pm2 list
      script: './apps/backend/dist/src/main.js',  // Path to JS file
      instances: 1,                       // Single instance
      autorestart: true,                  // Restart if crashes
      max_memory_restart: '1G',          // Restart if memory exceeds 1GB
      exec_mode: 'fork', 
    },
    {
      name: 'frontend',
      script: './apps/frontend/node_modules/next/dist/bin/next',  // Run next CLI
      args: 'start -p 3001',             // Arguments passed to next
      cwd: './apps/frontend',             // Working directory
      instances: 1,
      autorestart: true,
      exec_mode: 'fork', 
    },
    {
      name: 'orchestrator',
      script: './apps/orchestrator/dist/src/main.js',
      instances: 1,
      autorestart: true,
      exec_mode: 'fork', 
    },
  ],
};