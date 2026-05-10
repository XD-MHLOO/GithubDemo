import { Injectable, Logger } from "@nestjs/common";
import { DockerService } from "../docker/docker.service.js";
import { promises as fsp } from 'fs';
import { WorkspaceService } from "../workspace/workspace.service.js";
import { StageRecord } from "./dockerBuild.types.js";
import yaml from 'js-yaml';
import { randomUUID } from 'node:crypto';

const RESET_ARRAY = '___RESET_ARRAY___';
const RESET_NULL = '___RESET_NULL___';

@Injectable()
export class DockerBuildService {
  private readonly logger = new Logger(DockerBuildService.name);

  constructor(
    private readonly dockerService: DockerService,
    private readonly workspaceService: WorkspaceService,
  ) {}

  async updateStageHistoryAfterChanges(
    oldHistory: StageRecord[],
    freshHistory: StageRecord[],
    addedFiles: string[]
  ): Promise<StageRecord[]> {
    if (oldHistory.length !== freshHistory.length) {
      return freshHistory;
    }

    const oldBuildCount = oldHistory.filter(s => s.type === 'BUILD').length;
    const newBuildCount = freshHistory.filter(s => s.type === 'BUILD').length;
    const oldComposeCount = oldHistory.filter(s => s.type === 'COMPOSE').length;
    const newComposeCount = freshHistory.filter(s => s.type === 'COMPOSE').length;

    if (oldBuildCount !== newBuildCount || oldComposeCount !== newComposeCount) {
      return freshHistory;
    }

    for (let i = 0; i < oldHistory.length; i++) {
      const old = oldHistory[i];
      const fresh = freshHistory[i];
      if (old.type !== fresh.type) return freshHistory;
      if (old.type === 'BUILD') {
        const oldBuild = old as Extract<StageRecord, { type: 'BUILD' }>;
        const freshBuild = fresh as Extract<StageRecord, { type: 'BUILD' }>;
        if (oldBuild.dockerfilePath !== freshBuild.dockerfilePath) return freshHistory;
      } else if (old.type === 'COMPOSE') {
        const oldCompose = old as Extract<StageRecord, { type: 'COMPOSE' }>;
        const freshCompose = fresh as Extract<StageRecord, { type: 'COMPOSE' }>;
        if (oldCompose.composeFile.path !== freshCompose.composeFile.path) return freshHistory;
      }
    }

    const composePaths = new Set<string>();
    for (const stage of freshHistory) {
      if (stage.type === 'COMPOSE') {
        composePaths.add(stage.composeFile.path);
      }
    }

    const nonComposeFileChanged = addedFiles.some(file => !composePaths.has(file));
    if (nonComposeFileChanged) {
      return freshHistory;
    }

    const merged: StageRecord[] = [];
    for (let i = 0; i < freshHistory.length; i++) {
      const freshStage = freshHistory[i];
      const oldStage = oldHistory[i];

      if (freshStage.type === 'BUILD' && oldStage.type === 'BUILD') {
        const sameImage = oldStage.imageName === freshStage.imageName;
        const sameBuildArgs = JSON.stringify(oldStage.buildArgs) === JSON.stringify(freshStage.buildArgs);
        const keepSuccess = sameImage && sameBuildArgs && oldStage.status === 'success';
        merged.push({ ...freshStage, status: keepSuccess ? 'success' : 'pending' });
      } else {
        merged.push({ ...freshStage, status: 'pending' });
      }
    }

    return merged;
  }

  async buildStageHistory(deploymentPath: string): Promise<StageRecord[]> {
    try {
      const summaryData = await this.workspaceService.getRepoSummaryData(deploymentPath);
      const stageHistory: StageRecord[] = [];

      for (const composeFile of summaryData.compose_files || []) {
        for (const image of composeFile.images || []) {
          if (image.need_build) {
            stageHistory.push({
              type: 'BUILD',
              status: 'pending',
              dockerfilePath: image.dockerfile_path,
              imageName: image.image,
              buildArgs: image.build_args || {}
            });
          }
        }
        stageHistory.push({
          type: 'COMPOSE',
          status: 'pending',
          composeFile: {
            path: composeFile.path,
            envPath: composeFile.env_path
          }
        });
      }

      stageHistory.push({
        type: 'HEALTH_CHECK',
        status: 'pending',
        composeFiles: summaryData.compose_files.map(c => ({
          path: c.path,
          envPath: c.env_path
        }))
      });

      stageHistory.push({
        type: 'CONNECTIVITY_CHECK',
        status: 'pending',
        composeFiles: summaryData.compose_files.map(c => ({
          path: c.path,
          envPath: c.env_path
        }))
      });

      stageHistory.push({
        type: 'RUNTIME_TEST',
        status: 'pending',
        composeFiles: summaryData.compose_files.map(c => ({
          path: c.path,
          envPath: c.env_path
        }))
      });

      return stageHistory;
    } catch (err: any) {
      this.logger.error(`Failed to build stage history: ${err.message}`);
      throw err;
    }
  }

  async buildImage(
      deploymentPath: string,
      repoUrl: string,
      dockerfilePath: string,
      imageName: string,
      buildArgs: Record<string, string>
  ) {
      try {
          const result = await this.dockerService.buildImage({
              deploymentPath,
              repoDirName: this.workspaceService.repoUrlToDirName(repoUrl),
              dockerfilePath,
              imageName,
              buildArgs,
          });

          const logPath = this.workspaceService.getLogFilePath(
              deploymentPath,
              `buildImage-${imageName}-${Date.now()}.log`
          );
          await fsp.writeFile(logPath, result.logs);

          return {
              status: result.status as 'success' | 'failed' | 'error',
              logPath: logPath
          };
      } catch (err: any) {
          this.logger.error(`Build failed for ${imageName}: ${err.message}`);
          throw err;
      }
  }

  // async buildImage(
  //   deploymentPath: string,
  //   repoUrl: string,
  //   dockerfilePath: string,
  //   imageName: string,
  //   buildArgs: Record<string, string>
  // ) {
  //   try {
  //     const args = [
  //       'run', '--rm',
  //       '-v', `${deploymentPath}:/workspace`,
  //       'gcr.io/kaniko-project/executor:latest',
  //       `--dockerfile=${dockerfilePath}`,
  //       `--context=/workspace/repos/${this.workspaceService.repoUrlToDirName(repoUrl)}`,
  //       `--destination=${imageName}:latest`,
  //       '--force',
  //       '--insecure',
  //       `--tar-path=/workspace/build/${imageName}.tar`,
  //       '--no-push',
  //       '--snapshot-mode=redo',
  //       '--log-format=json'
  //     ];

  //     Object.entries(buildArgs).forEach(([key, value]) => {
  //       args.push(`--build-arg=${key}=${value}`);
  //     });

  //     this.logger.log(`Starting Kaniko build: ${imageName}`);

  //     let capturedLogs = '';

  //     const buildResult = await this.dockerService.buildWithKaniko({
  //       deploymentPath,
  //       repoDirName: this.workspaceService.repoUrlToDirName(repoUrl),
  //       dockerfilePath,
  //       imageName,
  //       buildArgs,
  //     });

  //     const logPath = this.workspaceService.getLogFilePath(
  //       deploymentPath,
  //       `buildImage-${imageName}-${Date.now()}.log`
  //     );
  //     await fsp.writeFile(logPath, buildResult.logs);

  //     return {
  //       status: buildResult.status as 'success' | 'failed' | 'error',
  //       logPath: logPath
  //     };
  //   } catch (err: any) {
  //     this.logger.error(`Build failed for ${imageName}: ${err.message}`);
  //     throw err;
  //   }
  // }

  // async uploadImage(deploymentPath: string, imageName: string) {
  //   try {
  //     const tarPath = this.workspaceService.getBuildFilePath(deploymentPath, `${imageName}.tar`);
  //     const result = await this.dockerService.loadImageFromTar(tarPath);

  //     if (result.status !== 'success') {
  //       throw new Error(`Failed to load image ${imageName}: ${result.logs}`);
  //     }

  //     this.logger.log(`Uploaded image: ${imageName}`);
  //   } catch (err: any) {
  //     this.logger.error(`Failed to upload image ${imageName}: ${err.message}`);
  //     throw err;
  //   }
  // }

  formatStageHistory(stageHistory: StageRecord[]): string {
    return stageHistory.map(s => {
      if (s.type === 'BUILD') return `[${s.status}] BUILD — ${s.imageName}`;
      if (s.type === 'COMPOSE') return `[${s.status}] COMPOSE — ${s.composeFile.path}`;
      if (s.type === 'HEALTH_CHECK') return `[${s.status}] HEALTH_CHECK`;
      if (s.type === 'RUNTIME_TEST') return `[${s.status}] RUNTIME_TEST`;
      return `[unknown]`;
    }).join('\n');
  }

  async extractServicePorts(
    deploymentPath: string,
    repoUrl: string,
    composeFiles: Array<{ path: string; envPath?: string }>
  ): Promise<Record<string, number[]>> {
    try {
      const result: Record<string, number[]> = {};

      for (const composeFile of composeFiles) {
        const composeFilePath = await this.workspaceService.getRepoFilePath(
          deploymentPath, repoUrl, composeFile.path
        );
        const envPath = composeFile.envPath
          ? await this.workspaceService.getRepoFilePath(deploymentPath, repoUrl, composeFile.envPath)
          : undefined;
        const tempOutputPath = await this.workspaceService.getRepoFilePath(
          deploymentPath, repoUrl, `.temp-compose-${Date.now()}-${Math.random()}.yml`
        );

        let compose: any;
        let interpolationFailed = false;

        try {
          const configResult = await this.dockerService.composeConfig({
            composeFile: composeFilePath,
            envFile: envPath,
            outputFile: tempOutputPath,
          });

          if (configResult.status === 'success' && configResult.content) {
            compose = yaml.load(configResult.content);
            await fsp.unlink(tempOutputPath).catch(() => {});
          } else {
            interpolationFailed = true;
          }
        } catch (error) {
          this.logger.warn(`Failed to interpolate ${composeFile.path}, falling back to raw file`);
          interpolationFailed = true;
          await fsp.unlink(tempOutputPath).catch(() => {});
        }

        if (interpolationFailed || !compose) {
          const content = await fsp.readFile(composeFilePath, 'utf8');
          compose = yaml.load(content);
        }

        for (const [service, config] of Object.entries(compose.services ?? {}) as any) {
          if (!Array.isArray(config.ports)) continue;

          const ports = config.ports.map((port: any) => {
            if (typeof port === 'string') return parseInt(port.split(':').pop()!.split('/')[0]);
            if (typeof port === 'object' && port.target) return port.target;
            return null;
          }).filter((p: any) => p !== null && !isNaN(p));

          if (ports.length > 0) {
            result[service] = [...new Set([...(result[service] ?? []), ...ports])];
          }
        }
      }

      return result;
    } catch (err: any) {
      this.logger.error(`Failed to extract service ports: ${err.message}`);
      throw err;
    }
  }

  private normalizeNetworks(nets: any): Record<string, any> {
    if (!nets) return {};
    if (Array.isArray(nets)) return Object.fromEntries(nets.map(n => [n, {}]));
    if (typeof nets === 'object') return nets;
    return {};
  }

  async createOverride(
    deploymentId: string,
    deploymentPath: string,
    repoUrl: string,
    composePath: string,
    networkName: string,
    config?: { cpuLimit?: number; memoryLimit?: string }
  ): Promise<string> {
    try {
      const composeFilePath = await this.workspaceService.getRepoFilePath(
        deploymentPath, repoUrl, composePath
      );
      const content = await fsp.readFile(composeFilePath, 'utf8');
      const compose = yaml.load(content) as any;
      const services = Object.keys(compose.services || {});

      const override: any = { services: {}, networks: {} };

      for (const service of services) {
        const originalService = compose.services[service] || {};

        override.services[service] = {
          container_name: `${deploymentId}-${service}`,
          mem_limit: config?.memoryLimit || '1G',
          memswap_limit: config?.memoryLimit || '1G',
          cpus: config?.cpuLimit || 1,
          restart: 'no',
          privileged: false,
          pids_limit: 100,
        };

        if (originalService.pid === 'host') override.services[service].pid = RESET_NULL;
        if (originalService.cap_add?.includes('ALL')) override.services[service].cap_add = RESET_ARRAY;
        if (originalService.userns_mode === 'host') override.services[service].userns_mode = RESET_NULL;
        if (originalService.ipc === 'host') override.services[service].ipc = RESET_NULL;
        
        if (originalService.security_opt) {
          const filtered = originalService.security_opt.filter((opt: string) =>
            !opt.includes('seccomp:unconfined') &&
            !opt.includes('apparmor:unconfined') &&
            !opt.includes('no-new-privileges:false')
          );
          if (filtered.length !== originalService.security_opt.length) {
            override.services[service].security_opt = filtered.length > 0 ? filtered : RESET_ARRAY;
          }
        }

        if (originalService.volumes) {
          override.services[service].volumes = originalService.volumes.map((vol: any) => {
            if (typeof vol === 'object' && vol.bind?.propagation) {
              const dangerous = ['rshared', 'shared', 'rslave', 'slave'];
              if (dangerous.includes(vol.bind.propagation)) {
                const { propagation, ...restBind } = vol.bind;
                const newVol = { ...vol };
                if (Object.keys(restBind).length > 0) {
                  newVol.bind = restBind;
                } else {
                  delete newVol.bind;
                }
                return newVol;
              }
            }
            return vol;
          });
        }

        override.services[service].ports = RESET_ARRAY;
      }

      const originalNetworks = compose.networks || {};
      for (const [key, val] of Object.entries(originalNetworks)) {
        const networkConfig = (val as any) || {};
        if (networkConfig.name) {
          override.networks[key] = {
            ...networkConfig,
            name: `${deploymentId}-${key}`
          };
        } else {
          override.networks[key] = val;
        }
      }
      override.networks[networkName] = { external: true };

      for (const service of services) {
        const originalService = compose.services[service] || {};
        const originalServiceNetworks = this.normalizeNetworks(originalService.networks);
        override.services[service].networks = {
          ...originalServiceNetworks,
          [networkName]: {}
        };
      }

      let overrideContent = yaml.dump(override);
      overrideContent = overrideContent
        .replace(/___RESET_ARRAY___/g, '!reset []')
        .replace(/___RESET_NULL___/g, '!reset null');

      const overridePath = await this.workspaceService.getRepoFilePath(
        deploymentPath, repoUrl, `docker-compose.override-${randomUUID()}.yml`
      );
      await fsp.writeFile(overridePath, overrideContent);

      return overridePath;
    } catch (err: any) {
      this.logger.error(`Failed to create override: ${err.message}`);
      throw err;
    }
  }

  async runCompose(
    deploymentId: string,
    deploymentPath: string,
    repoUrl: string,
    composeFile: { path: string; envPath: string },
    networkName: string,
    config
  ) {
    let overridePath: string | undefined;
    let resolvedEnvFile: string | undefined;

    try {
      this.logger.log(`Running docker compose for ${deploymentId}`);

      const composeFilePath = await this.workspaceService.getRepoFilePath(
        deploymentPath, repoUrl, composeFile.path
      );
      const envFilePath = await this.workspaceService.getRepoFilePath(
        deploymentPath, repoUrl, composeFile.envPath
      );

      overridePath = await this.createOverride(
        deploymentId, deploymentPath, repoUrl, composeFile.path, networkName, config
      );
      resolvedEnvFile = await this.createResolvedEnv(
        deploymentId, deploymentPath, repoUrl, envFilePath, composeFile
      );

      await this.dockerService.composeDown({
        projectName: deploymentId,
        composeFilePath
      });

      const result = await this.dockerService.composeUpWithTTL({
        projectName: deploymentId,
        composeFilePath,
        overrideFile: overridePath,
        envFile: resolvedEnvFile
      });

      const logPath = this.workspaceService.getLogFilePath(
        deploymentPath, `runCompose-${Date.now()}.log`
      );
      await fsp.writeFile(logPath, result.logs);

      return {
        status: result.status as 'success' | 'failed' | 'error',
        logPath: logPath
      };
    } catch (err: any) {
      this.logger.error(`Docker compose failed for ${deploymentId}: ${err.message}`);

      // Rollback: bring down what was started
      try {
        const composeFilePath = await this.workspaceService.getRepoFilePath(
          deploymentPath, repoUrl, composeFile.path
        );
        await this.dockerService.composeDown({
          projectName: deploymentId,
          composeFilePath
        });
      } catch (rollbackErr: any) {
        this.logger.warn(`Rollback failed: ${rollbackErr.message}`);
      }

      const logPath = this.workspaceService.getLogFilePath(
        deploymentPath, `runCompose-error-${Date.now()}.log`
      );
      await fsp.writeFile(logPath, `Error: ${err.message}\nStack: ${err.stack}`);

      return {
        status: 'failed' as const,
        logPath: logPath
      };
    }
  }

  async checkHealth(
    deploymentId: string,
    deploymentPath: string,
    repoUrl: string,
    composePaths: string[]
  ) {
    const maxWaitMs = 10 * 60 * 1000;
    const pollInterval = 30000;
    const stableCount = 3;

    let consecutiveHealthy = 0;
    const startTime = Date.now();

    try {
      while (Date.now() - startTime < maxWaitMs) {
        await new Promise(r => setTimeout(r, pollInterval));

        const allData: any[] = [];
        for (const composePath of composePaths) {
          const composeFile = await this.workspaceService.getRepoFilePath(
            deploymentPath, repoUrl, composePath
          );
          const { data } = await this.dockerService.composePs({
            projectName: deploymentId,
            composeFile,
            all: true
          });
          allData.push(...data);
        }

        const hasError = allData.some(c => {
          if (c.State === 'exited' && c.ExitCode !== 0) return true;
          if (c.Health === 'unhealthy') return true;
          return false;
        });

        const allRunning = allData.every(c => {
          if (c.Health) return c.Health === 'healthy';
          return c.State === 'running' || (c.State === 'exited' && c.ExitCode === 0);
        });

        if (hasError) {
          const logPath = this.workspaceService.getLogFilePath(
            deploymentPath, `healthCheck-${Date.now()}.log`
          );
          await fsp.writeFile(logPath, JSON.stringify(allData, null, 2));
          return { status: 'failed' as const, logPath };
        }

        this.logger.debug(`Health check: ${allData.map(c => `${c.Names}:${c.State}`).join(', ')}`);

        if (allRunning) {
          consecutiveHealthy++;
          if (consecutiveHealthy >= stableCount) {
            const logPath = this.workspaceService.getLogFilePath(
              deploymentPath, `healthCheck-${Date.now()}.log`
            );
            await fsp.writeFile(logPath, JSON.stringify(allData, null, 2));
            return { status: 'success' as const, logPath };
          }
        } else {
          consecutiveHealthy = 0;
        }
      }

      const logPath = this.workspaceService.getLogFilePath(
        deploymentPath, `healthCheck-${Date.now()}.log`
      );
      await fsp.writeFile(logPath, 'Health check timed out');
      return { status: 'timeout' as const, logPath };
    } catch (err: any) {
      this.logger.error(`Health check failed: ${err.message}`);
      throw err;
    }
  }

  private async createResolvedEnv(
    deploymentId: string,
    deploymentPath: string,
    repoUrl: string,
    envFile: string,
    composeFile: { path: string; envPath?: string }
  ): Promise<string> {
    try {
      const servicePorts = await this.extractServicePorts(deploymentPath, repoUrl, [composeFile]);
      let env = await fsp.readFile(envFile, 'utf8');

      env = env.replace(/http:\/\/placeholder-(\d+)/g, (_, port) => {
        const portNum = parseInt(port);
        for (const [service, ports] of Object.entries(servicePorts)) {
          if (ports.includes(portNum)) {
            return `http://${deploymentId}-${service}-${port}.${process.env.DOMAIN}`;
          }
        }
        return `http://${process.env.DOMAIN}:${port}`;
      });

      const resolvedEnvPath = this.workspaceService.getLogFilePath(
        deploymentPath, `resolved-env-${Date.now()}.env`
      );
      await fsp.writeFile(resolvedEnvPath, env, 'utf8');

      return resolvedEnvPath;
    } catch (err: any) {
      this.logger.error(`Failed to create resolved env: ${err.message}`);
      throw err;
    }
  }
}