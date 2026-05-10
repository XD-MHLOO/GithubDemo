import { TemporalModule } from 'nestjs-temporal-core';

export const getTemporalModule = (
  isWorkers: boolean,
  path?: string,
  activityClasses?: any[]
) => {
  return TemporalModule.register({
    isGlobal: true,
    connection: {
      address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
      ...process.env.TEMPORAL_TLS === 'true' ? {tls: true} : {},
      ...process.env.TEMPORAL_API_KEY ? {apiKey: process.env.TEMPORAL_API_KEY} : {},
      namespace: process.env.TEMPORAL_NAMESPACE || 'default',
    },
    taskQueue: 'main',
    logLevel: 'error',
    workers: isWorkers
      ? [
          {
            taskQueue: 'main', 

            workflowsPath: path,

            activityClasses, 
            autoStart: true,

            workerOptions: {
              maxConcurrentActivityTaskExecutions: 10, 
            },
          }
      ]
      : [],
  });
};

