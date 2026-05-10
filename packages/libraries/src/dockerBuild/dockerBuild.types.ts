export type StageRecord =
  | {
      type: 'BUILD';
      status: 'pending' | 'success' | 'failed' | 'error' | 'fixing';
      dockerfilePath: string;
      imageName: string;
      buildArgs: Record<string, string>;
    }
  | {
      type: 'COMPOSE';
      status: 'pending' | 'success' | 'failed' | 'error' | 'fixing';
      composeFile: {
          path: string;
          envPath: string;
      };
    }
  | {
      type: 'HEALTH_CHECK';
      status: 'pending' | 'success' | 'failed' | 'error' | 'fixing' | 'timeout';
      composeFiles: Array<{ path: string; envPath: string }>; 
    }
  | {
      type: 'RUNTIME_TEST';
      status: 'pending' | 'success' | 'failed' | 'error' | 'fixing';
      composeFiles: Array<{ path: string; envPath: string }>;
    }
  | {
      type: 'CONNECTIVITY_CHECK';
      status: 'pending' | 'success' | 'failed' | 'error' | 'fixing';
      composeFiles: Array<{ path: string; envPath: string }>;
    };