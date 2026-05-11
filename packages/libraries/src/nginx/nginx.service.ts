import { Injectable, Logger } from "@nestjs/common";
import { DockerService } from "../docker/docker.service.js";
import { promises as fsp } from 'fs';

@Injectable()
export class NginxService {
    private readonly logger = new Logger(NginxService.name);
    private readonly configDir = process.env.NODE_ENV === 'production' 
        ? '/etc/nginx/conf.d'                              // Hardcoded for production
        : process.env.NGINX_CONFIG_DIR || '/etc/nginx/conf.d';  // Dev: from env or default
    constructor(
        private readonly dockerService: DockerService,
    ) {}

    async onModuleInit() {
        let retries = 3;
        while (retries > 0) {
            try {
                await this.dockerService.ensureNginxRunning();
                this.logger.log('Nginx ready in DinD');
                return;
            } catch (error) {
                retries--;
                if (retries === 0) {
                    this.logger.error('Failed to start nginx after 3 attempts');
                    throw error;
                }
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }

    async connectAndSetupNginx(
        deploymentId: string, 
        networkName: string, 
        servicePorts: Record<string, number[]>
    ): Promise<void> {
        try {
            //  Container name changed from 'main-nginx' to 'githubdemo-app'
            await this.dockerService.disconnectFromNetwork(networkName).catch(() => {});
            await this.dockerService.connectToNetwork(networkName);
            await this.setupNginx(deploymentId, servicePorts);
        } catch (error: any) {
            this.logger.error(`Failed to setup nginx for ${deploymentId}: ${error.message}`);
            try {
                await this.dockerService.disconnectFromNetwork(networkName);
                await this.teardownNginx(deploymentId);
            } catch {}
            throw error;
        }
    }

    async setupNginx(deploymentId: string, servicePorts: Record<string, number[]>): Promise<void> {
        const configPath = `${this.configDir}/${deploymentId}.conf`;

        try {
            const config = this.generateNginxConfig(deploymentId, servicePorts);
            await fsp.writeFile(configPath, config);
            this.reloadNginx();       //  Direct, no dockerService
        } catch (error) {
            await fsp.rm(configPath, { force: true }).catch(() => {});
            throw error;
        }
    }

    async teardownNginx(deploymentId: string): Promise<void> {
        try {
            const configPath = `${this.configDir}/${deploymentId}.conf`;
            await fsp.rm(configPath, { force: true });
            this.reloadNginx();       //  Direct
        } catch (error: any) {
            this.logger.warn(`Teardown failed: ${error.message}`);
        }
    }

    private reloadNginx(): void {
        this.dockerService.reloadNginx().catch(err => {
            this.logger.warn(`Nginx reload failed: ${err.message}`);
        });
    }

    private generateNginxConfig(deploymentId: string, servicePorts: Record<string, number[]>): string {
        const blocks: string[] = [];

        for (const [service, ports] of Object.entries(servicePorts)) {
            for (const port of ports) {
                blocks.push(`
    server {
        listen 80;
        server_name ${deploymentId}-${service}-${port}.${process.env.DOMAIN};
        

        location / {
            resolver 127.0.0.11 valid=30s;
            set $upstream ${deploymentId}-${service}:${port};
            proxy_pass http://$upstream;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }`);
            }
        }

        return blocks.join('\n');
    }
}