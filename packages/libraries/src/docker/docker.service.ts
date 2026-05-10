import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import { spawn } from "child_process";
import { randomUUID } from 'node:crypto';
import * as path from 'path';
import Docker from 'dockerode';
import * as tar from 'tar-fs';
import { writeFile, unlink } from 'fs/promises';

@Injectable()
export class DockerService {
  private readonly logger = new Logger(DockerService.name);
  private readonly docker: Docker;

  constructor() {
    const dockerUrl = process.env.DOCKER_HOST || 'tcp://localhost:2375';
    const url = new URL(dockerUrl);
    
    this.docker = new Docker({
        host: url.hostname,
        port: parseInt(url.port) || 2375,
        protocol: 'http',
    });
  }
async ensureNginxRunning(): Promise<void> {
    try {
        await this.runCli('docker', ['rm', '-f', 'shared-nginx']).catch(() => {});

        // Write Dockerfile to host path
        const hostConfigDir = process.env.NODE_ENV === 'production' 
          ? '/etc/nginx/conf.d'
          : process.env.NGINX_CONFIG_DIR || '/etc/nginx/conf.d';
        const dockerfilePath = `${hostConfigDir}/Dockerfile.nginx`;
        const dockerfileContent = `FROM nginx:alpine
        RUN printf 'user nginx;\\nworker_processes auto;\\npid /run/nginx.pid;\\nevents { worker_connections 1024; }\\nhttp {\\n    server_names_hash_bucket_size 128;\\n    include /etc/nginx/mime.types;\\n    default_type application/octet-stream;\\n    include /etc/nginx/conf.d/*.conf;\\n}' > /etc/nginx/nginx.conf`;
                
        await writeFile(dockerfilePath, dockerfileContent);

        // Build using stdin (no context needed)
        await this.runCli('docker', [
            'build',
            '-t', 'custom-nginx:latest',
            '-f', dockerfilePath,
            hostConfigDir,  // stdin as context
        ]);

        await unlink(dockerfilePath).catch(() => {});

        // Create container
        const container = await this.docker.createContainer({
            Image: 'custom-nginx:latest',
            name: 'shared-nginx',
            HostConfig: {
                NetworkMode: 'bridge',
                Binds: ['/etc/nginx/conf.d:/etc/nginx/conf.d'],
                PortBindings: { '80/tcp': [{ HostPort: '80' }] },
                RestartPolicy: { Name: 'always' },
            },
        });
        await container.start();
        this.logger.log('Shared nginx started in DinD');
    } catch (error: any) {
        this.logger.error(`Failed to ensure nginx: ${error.message}`);
        throw error;
    }
}
  // ============================================================
  // CLI Helper
  // ============================================================
  private runCli(command: string, args: string[]) {
    return new Promise<{ status: string; logs: string }>((resolve) => {
        const safeEnv = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            DOCKER_HOST: process.env.DOCKER_HOST || 'tcp://dind:2375',
        };

        const proc = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: safeEnv,
        });

        let logs = "";
        proc.stdout.on("data", (d) => { const msg = d.toString(); logs += msg; console.log(msg); });
        proc.stderr.on("data", (d) => { const msg = d.toString(); logs += msg; console.error(msg); });
        proc.on("close", (code) => { resolve({ status: code === 0 ? "success" : "failed", logs }); });
        proc.on("error", (err) => { resolve({ status: "error", logs: err.message }); });
    });
  }

  // ============================================================
  // DOCKERODE METHODS
  // ============================================================

  async loadImageFromTar(tarPath: string) {
    if (!fs.existsSync(tarPath)) return { status: "error", logs: "Tar file does not exist" };
    try {
        const stream = fs.createReadStream(tarPath);
        await this.docker.loadImage(stream);
        return { status: "success", logs: "Image loaded successfully" };
    } catch (err: any) {
        return { status: "error", logs: err.message };
    }
  }

  async listContainers(all = true) {
    try {
        const containers = await this.docker.listContainers({ all });
        return containers.map(c => ({
            id: c.Id, name: c.Names, image: c.Image, state: c.State, status: c.Status, ports: c.Ports,
        }));
    } catch (err: any) {
        this.logger.error(`listContainers failed: ${err.message}`);
        return [];
    }
  }

  async createJobNetwork(deploymentId: string): Promise<string> {
    const networkName = `deployment-${deploymentId}-${randomUUID()}`;
    await this.docker.createNetwork({ Name: networkName });
    return networkName;
  }

  async removeJobNetwork(networkName: string): Promise<void> {
    const network = this.docker.getNetwork(networkName);
    await network.remove();
  }

  async getContainerIp(containerName: string, networkName: string): Promise<string | null> {
    try {
        const container = this.docker.getContainer(containerName);
        const info = await container.inspect();
        return info.NetworkSettings?.Networks?.[networkName]?.IPAddress || null;
    } catch { return null; }
  }

  async connectToNetwork(networkName: string) {
    try {
      const network = this.docker.getNetwork(networkName);
      await network.connect({ Container: 'shared-nginx' }); 
      this.logger.log(`Connected shared-nginx to network: ${networkName}`);
      return { status: 'success', logs: `Connected to ${networkName}` };
    } catch (error: any) {
      this.logger.error(`Network connect failed: ${error.message}`);
      throw new Error(`Network connect failed: ${error.message}`);
    }
  }

    async disconnectFromNetwork(networkName: string) {
    try {
      const network = this.docker.getNetwork(networkName);
      await network.disconnect({ Container: 'shared-nginx' });
      this.logger.log(`Disconnected shared-nginx from network: ${networkName}`);
      return { status: 'success', logs: `Disconnected from ${networkName}` };
    } catch (error: any) {
      this.logger.warn(`Network disconnect error: ${error.message}`);
      return { status: 'error', logs: error.message };
    }
  }

  async reloadNginx(): Promise<void> {
      await this.runCli('docker', ['exec', 'shared-nginx', 'nginx', '-s', 'reload']);
  }

  // Kaniko image build
  async buildWithKaniko(params: {
    deploymentPath: string; repoDirName: string; dockerfilePath: string;
    imageName: string; buildArgs: Record<string, string>;
  }): Promise<{ status: string; logs: string }> {
    const { deploymentPath, repoDirName, dockerfilePath, imageName, buildArgs } = params;
    const args = [
        'run', '--rm', '-v', `${deploymentPath}:/workspace`,
        'gcr.io/kaniko-project/executor:latest',
        `--dockerfile=${dockerfilePath}`, `--context=/workspace/repos/${repoDirName}`,
        `--destination=${imageName}:latest`, '--force', '--insecure',
        `--tar-path=/workspace/build/${imageName}.tar`, '--no-push',
        '--snapshot-mode=redo', '--log-format=json'
    ];
    Object.entries(buildArgs).forEach(([key, value]) => args.push(`--build-arg=${key}=${value}`));
    this.logger.log(`Starting Kaniko build: ${imageName}`);
    return this.runCli('docker', args);
  }


    async buildImage(params: {
        deploymentPath: string;
        repoDirName: string;
        dockerfilePath: string;
        imageName: string;
        buildArgs: Record<string, string>;
        }): Promise<{ status: string; logs: string }> {
        const { deploymentPath, repoDirName, dockerfilePath, imageName, buildArgs } = params;

        try {
            // Tar the build context
            const tarStream = tar.pack(`${deploymentPath}/repos/${repoDirName}`);
            
            // Build image directly in DinD
            const stream = await this.docker.buildImage(tarStream, {
            t: `${imageName}:latest`,
            dockerfile: dockerfilePath,
            buildargs: buildArgs,
            });

            let logs = '';
            await new Promise((resolve, reject) => {
            this.docker.modem.followProgress(stream, 
                (err) => err ? reject(err) : resolve(null),
                (event) => {
                if (event.stream) {
                    logs += event.stream;
                    console.log(event.stream);
                }
                }
            );
            });

            // Image is now in DinD - no upload needed!
            return { status: 'success', logs };
        } catch (err: any) {
            return { status: 'failed', logs: err.message };
        }
    }

    async removeImage(imageName: string): Promise<void> {
        try {
            const image = this.docker.getImage(`${imageName}:latest`);
            await image.remove({ force: true });
            this.logger.log(`Removed image: ${imageName}`);
        } catch (err: any) {
            this.logger.warn(`Failed to remove image ${imageName}: ${err.message}`);
        }
    }

  // ============================================================
  // COMPOSE METHODS
  // ============================================================
  async composeUp(params: { projectName: string; composeFilePath: string; overrideFile?: string; removeOrphans?: boolean; build?: boolean; envFile?: string; }) {
    const { projectName, composeFilePath, overrideFile, removeOrphans = true, build = false, envFile } = params;
    const args = ["compose", "-p", projectName, "-f", composeFilePath];
    if (overrideFile) args.push('-f', overrideFile);
    if (envFile) args.push("--env-file", envFile);
    args.push("up", "-d");
    if (removeOrphans) args.push("--remove-orphans");
    if (build) args.push("--build");
    return this.runCli("docker", args);
  }

  async composeDown(params: { projectName: string; composeFilePath: string }) {
    const { projectName, composeFilePath } = params;
    return this.runCli("docker", ["compose", "-p", projectName, "-f", composeFilePath, "down", "--remove-orphans", "-v"]);
  }

  async composeUpWithTTL(params: { projectName: string; composeFilePath: string; overrideFile?: string; removeOrphans?: boolean; build?: boolean; envFile?: string; ttlSeconds?: number; }) {
    const { ttlSeconds = 3600, ...rest } = params;
    try {
        const composeDir = path.dirname(rest.composeFilePath);
        const debugFileName = `debug-compose-${new Date().toISOString().replace(/[:.]/g, '-')}.yml`;
        const debugFilePath = `${composeDir}/${debugFileName}`;
        const configResult = await this.composeConfig({ composeFile: rest.composeFilePath, overrideFile: rest.overrideFile, envFile: rest.envFile, outputFile: debugFilePath });
        if (configResult.status === "success") this.logger.log(`Debug compose config saved to: ${debugFilePath}`);
        else this.logger.warn(`Failed to generate debug config: ${configResult.logs}`);
    } catch (debugError: any) { this.logger.warn(`Debug config generation failed: ${debugError.message}`); }

    const upResult = await this.composeUp(rest);
    if (upResult.status !== "success") return upResult;

    setTimeout(async () => {
        this.logger.log(`TTL reached, shutting down ${rest.projectName}`);
        await this.composeDown({ projectName: rest.projectName, composeFilePath: rest.composeFilePath });
    }, ttlSeconds * 1000);

    return { ...upResult, message: `Started. Will auto shutdown in ${ttlSeconds}s` };
  }

  async composePs(params: { projectName: string; composeFile: string; all?: boolean }) {
    const { projectName, composeFile, all = false } = params;
    const args = ["compose", "-p", projectName, "-f", composeFile, "ps"];
    if (all) args.push("-a");
    args.push("--format", "json");
    const result = await this.runCli("docker", args);
    return { status: result.status, logs: result.logs, data: this.parseNdjson(result.logs) };
  }

  async composeLogs(params: { projectName: string; composeFile: string; since?: string }) {
    const { projectName, composeFile, since } = params;
    const args = ["compose", "-p", projectName, "-f", composeFile, "logs", "-t"];
    if (since) args.push("--since", since);
    return this.runCli("docker", args);
  }

  async composeConfig(params: { composeFile: string; overrideFile?: string; envFile?: string; outputFile?: string; }): Promise<{ status: string; logs: string; content?: string }> {
    const { composeFile, overrideFile, envFile, outputFile } = params;
    const args = ["compose", "-f", composeFile];
    if (overrideFile) args.push('-f', overrideFile);
    if (envFile) args.push("--env-file", envFile);
    args.push("config");
    if (outputFile) args.push("-o", outputFile);
    const result = await this.runCli("docker", args);
    let content: string | undefined;
    if (!outputFile && result.status === "success") content = result.logs;
    if (outputFile && result.status === "success" && fs.existsSync(outputFile)) content = fs.readFileSync(outputFile, 'utf8');
    return { status: result.status, logs: result.logs, content };
  }

  private parseNdjson(output: string) {
    return output.trim().split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  }
}