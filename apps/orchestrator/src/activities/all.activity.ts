import { Injectable, Logger } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { WorkspaceService, ContainerizationAgentGraph, DockerBuildService, DockerService, NginxService, StageRecord, DeploymentService } from '@githubdemo/libraries'
import { ApplicationFailure } from '@temporalio/activity';
import { execSync } from 'child_process';
import { DeploymentStatus } from '@githubdemo/libraries';

@Injectable()
@Activity()
export class AllActivity {
    private readonly logger = new Logger(AllActivity.name);

    constructor(
        private readonly workspaceService: WorkspaceService,
        private readonly dockerBuildService: DockerBuildService,
        private readonly dockerService: DockerService,
        private readonly nginxService: NginxService,
        private readonly deploymentService: DeploymentService,
        private readonly containerizationAgentGraph: ContainerizationAgentGraph,
    ) {}

    @ActivityMethod('registerRepo')
    async registerRepo(deploymentId: string, githubUrl: string, ref: string) {
        try {
            
            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "registerRepo", status: "in-progress" }
            });

            const deploymentPath = `${process.env.STORAGE_BASE_PATH}/${deploymentId}`;
            await this.workspaceService.createDeploymentDirectories(deploymentPath);
            await this.workspaceService.cloneRepo(githubUrl, deploymentPath, ref);
            await this.workspaceService.ingestRepo(deploymentPath, githubUrl);

            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "registerRepo", status: "completed" }
            });

            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { level: "INFO", message: `Repository cloned: ${githubUrl}`, stream: "stdout" }
            });

            return { deploymentPath };

        } catch (error: any) {
            this.logger.error(`registerRepo failed for ${deploymentId}: ${error.message}`);
            await this.deploymentService.publishEvent(deploymentId, {
                type: "error", data: { stage: "registerRepo", message: error.message }
            });
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { level: "ERROR", message: `registerRepo failed: ${error.message}`, stream: "stderr" }
            });


            if (error.message?.includes('Authentication failed') ||
                error.message?.includes('not found') ||
                error.message?.includes('ENOENT')) {
                throw ApplicationFailure.nonRetryable(error.message);
            }
            throw error;
        }
    }

    @ActivityMethod('createCompose')
    async createCompose(deploymentId: string, deploymentPath: string, githubUrl: string) {
        try {
            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "createCompose", status: "in-progress" }
            });

            const { status, failureReason, repoUrl, state } = await this.containerizationAgentGraph.run({
                deploymentId,
                deploymentPath,
                currentRepo: githubUrl,
            });

            if (state.phaseHistory) {
                this.logger.log(`Agent ran ${state.phaseHistory.length} phases`);
                
                for (const phase of state.phaseHistory) {
                    const phaseText = typeof phase === 'string' 
                        ? phase 
                        : phase?.summary || JSON.stringify(phase);
                    await this.deploymentService.publishEvent(deploymentId, {
                        type: "log",
                        data: { 
                            level: "INFO", 
                            message: `[Agent] ${phaseText}`,
                            stream: "agent"
                        }
                    });
                }
            }

            if (status === -1) {
                throw ApplicationFailure.nonRetryable(failureReason || 'Cannot containerize this project');
            }

            const stageHistory = await this.dockerBuildService.buildStageHistory(deploymentPath);

            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "createCompose", status: "completed" }
            });

            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { 
                    level: "INFO", 
                    message: `Files created: ${state.writtenFiles?.map((f: any) => f.path || f).join(', ') || 'none'}`,
                    stream: "agent"
                }
            });
            return { repoUrl, stageHistory, agentState: state };

        } catch (error: any) {
            this.logger.error(`createCompose failed for ${deploymentId}: ${error.message}`);
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { level: "ERROR", message: `createCompose failed: ${error.message}`, stream: "stderr" }
            });
            if (error instanceof ApplicationFailure) throw error;
            
            await this.deploymentService.publishEvent(deploymentId, {
                type: "error", data: { stage: "createCompose", message: error.message }
            });
            throw error;
        }
    }
    @ActivityMethod('fixCompose')
    async fixCompose(
        deploymentId: string,
        deploymentPath: string,
        repoUrl: string,
        mode: 1 | 2 | 3 | 4 | 5,
        stageHistory: StageRecord[],
        agentState?: any,
        logPath?: string,
        composeFiles?: Array<{ path: string; envPath?: string }>,
        connectivityResults?: any
    ) {
        try {
            const composePaths = composeFiles ? composeFiles.map(cf => cf.path) : [];

            const modeLabels: Record<number, string> = {
                1: 'Build failure',
                2: 'Compose failure',
                3: 'Health check failure',
                4: 'Connectivity failure',
                5: 'Runtime fix requested'
            };
            
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { 
                    level: "INFO", 
                    message: `Agent fixing: ${modeLabels[mode] || `Mode ${mode}`}`,
                    stream: "agent"
                }
            });

            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "fixCompose", status: "in-progress" }
            });

            const result = await this.containerizationAgentGraph.resume({
                deploymentId, deploymentPath, repoUrl, mode,
                stageHistory, state: agentState, logPath,
                composePaths, connectivityResults
            });

            // Log new phases
            const previousPhases = agentState?.phaseHistory || [];
            const newPhases = (result?.state?.phaseHistory || []).slice(previousPhases.length);

            for (const phase of newPhases) {
                const phaseText = typeof phase === 'string' 
                    ? phase 
                    : phase?.summary || JSON.stringify(phase);
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "log",
                    data: { 
                        level: "INFO", 
                        message: `[Agent] ${phaseText}`,
                        stream: "agent"
                    }
                });
            }

            // Log written files
            if  (result?.state?.writtenFiles && result.state.writtenFiles.length > 0) {
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "log",
                    data: { 
                        level: "INFO", 
                        message: `Files modified: ${result.state.writtenFiles.map((f: any) => f.path || f).join(', ')}`,
                        stream: "agent"
                    }
                });
            }

            if (result.status === -1) {
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "log",
                    data: { 
                        level: "ERROR", 
                        message: `Fix failed: ${result.failureReason || 'Unknown'}`,
                        stream: "stderr"
                    }
                });
                throw ApplicationFailure.nonRetryable(result.failureReason || 'Cannot fix this project');
            }

            const updatedStageHistory = await this.dockerBuildService.buildStageHistory(deploymentPath);
            const finalUpdatedStageHistory = await this.dockerBuildService.updateStageHistoryAfterChanges(
                stageHistory, updatedStageHistory, result.state?.writtenFiles || []
            );

            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { 
                    level: "INFO", 
                    message: `Fix completed successfully`,
                    stream: "agent"
                }
            });

            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "fixCompose", status: "completed" }
            });

            return { finalUpdatedStageHistory, agentState: result?.state || agentState  };

        } catch (error: any) {
            this.logger.error(`fixCompose failed for ${deploymentId}: ${error.message}`);
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { level: "ERROR", message: `fixCompose failed: ${error.message}`, stream: "stderr" }
            });

            if (error instanceof ApplicationFailure) throw error;
            
            await this.deploymentService.publishEvent(deploymentId, {
                type: "error", data: { stage: "fixCompose", message: error.message }
            });
            throw error;
        }
    }

    @ActivityMethod('buildImage')
    async buildImage({ deploymentId, deploymentPath, repoUrl, dockerfilePath, imageName, buildArgs }: {
        deploymentId: string;
        deploymentPath: string;
        repoUrl: string;
        dockerfilePath: string;
        imageName: string;
        buildArgs: Record<string, string>;
    }) {
        try {
            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "buildImage", status: "in-progress" }
            });

            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { 
                    level: "INFO", 
                    message: `Building image: ${imageName} from ${dockerfilePath}`,
                    stream: "stdout"
                }
            });

            const result = await this.dockerBuildService.buildImage(deploymentPath, repoUrl, dockerfilePath, imageName, buildArgs);

            if (result.status === 'failed') {
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "status", data: { stage: "buildImage", status: "failed" }
                });
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "log",
                    data: { 
                        level: "ERROR", 
                        message: `Build failed for ${imageName}`,
                        stream: "stderr"
                    }
                });
            } else {
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "status", data: { stage: "buildImage", status: "completed" }
                });
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "log",
                    data: { 
                        level: "INFO", 
                        message: `Build succeeded: ${imageName}`,
                        stream: "stdout"
                    }
                });
            }

            return result;

        } catch (error: any) {
            this.logger.error(`buildImage failed for ${deploymentId}: ${error.message}`);
            await this.deploymentService.publishEvent(deploymentId, {
                type: "error", data: { stage: "buildImage", message: error.message }
            });
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { level: "ERROR", message: `buildImage failed: ${error.message}`, stream: "stderr" }
            });

            throw error;
        }
    }

    // @ActivityMethod('uploadImage')
    // async uploadImage(deploymentId: string, deploymentPath: string, imageName: string) {
    //     try {
    //         await this.deploymentService.publishEvent(deploymentId, {
    //             type: "status", data: { stage: "uploadImage", status: "in-progress" }
    //         });

    //         await this.dockerBuildService.uploadImage(deploymentPath, imageName);

    //         await this.deploymentService.publishEvent(deploymentId, {
    //             type: "status", data: { stage: "uploadImage", status: "completed" }
    //         });

    //     } catch (error: any) {
    //         this.logger.error(`uploadImage failed for ${deploymentId}: ${error.message}`);
    //         await this.deploymentService.publishEvent(deploymentId, {
    //             type: "error", data: { stage: "uploadImage", message: error.message }
    //         });
    //         throw error;
    //     }
    // }

    @ActivityMethod('runCompose')
    async runCompose({ deploymentId, deploymentPath, repoUrl, composeFile, networkName, config }: {
        deploymentId: string;
        deploymentPath: string;
        repoUrl: string;
        composeFile: { path: string; envPath: string };
        networkName: string;
        config: { timeoutMinutes: number; cpuLimit: number; memoryLimit: string };
    }) {
        try {
            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "runCompose", status: "in-progress" }
            });

            const result = await this.dockerBuildService.runCompose(deploymentId, deploymentPath, repoUrl, composeFile, networkName, config);

            if (result.status === 'failed') {
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "status", data: { stage: "runCompose", status: "failed" }
                });
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "log",
                    data: { 
                        level: "ERROR", 
                        message: `Compose failed: ${result.logPath || 'Unknown error'}`,
                        stream: "stderr"
                    }
                });
            } else {
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "status", data: { stage: "runCompose", status: "completed" }
                });
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "log",
                    data: { 
                        level: "INFO", 
                        message: `Containers started successfully`,
                        stream: "stdout"
                    }
                });
            }

            return result;

        } catch (error: any) {
            this.logger.error(`runCompose failed for ${deploymentId}: ${error.message}`);
            await this.deploymentService.publishEvent(deploymentId, {
                type: "error", data: { stage: "runCompose", message: error.message }
            });
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { level: "ERROR", message: `runCompose failed: ${error.message}`, stream: "stderr" }
            });

            throw error;
        }
    }

    @ActivityMethod('createJobNetwork')
    async createJobNetwork(deploymentId: string) {
        try {
            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "createJobNetwork", status: "in-progress" }
            });

            const result = await this.dockerService.createJobNetwork(deploymentId);

            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "createJobNetwork", status: "completed" }
            });

            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { 
                    level: "INFO", 
                    message: `Network created`,
                    stream: "stdout"
                }
            });
            return result;

        } catch (error: any) {
            this.logger.error(`createJobNetwork failed for ${deploymentId}: ${error.message}`);
            await this.deploymentService.publishEvent(deploymentId, {
                type: "error", data: { stage: "createJobNetwork", message: error.message }
            });
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { level: "ERROR", message: `createJobNetwork failed: ${error.message}`, stream: "stderr" }
            });

            throw error;
        }
    }

    @ActivityMethod('checkHealth')
    async checkHealth({ deploymentId, deploymentPath, repoUrl, composeFiles }: {
        deploymentId: string;
        deploymentPath: string;
        repoUrl: string;
        composeFiles: Array<{ path: string; envPath?: string }>;
    }) {
        try {
            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "checkHealth", status: "in-progress" }
            });

            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { 
                    level: "INFO", 
                    message: `Running health checks...`,
                    stream: "stdout"
                }
            });

            const composePaths = composeFiles.map(cf => cf.path);
            const result = await this.dockerBuildService.checkHealth(deploymentId, deploymentPath, repoUrl, composePaths);

            if (result.status === 'failed' || result.status === 'timeout') {
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "status", data: { stage: "checkHealth", status: result.status }
                });
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "log",
                    data: { 
                        level: "WARN", 
                        message: `Health check: ${result.status}`,
                        stream: "stderr"
                    }
                });

            } else {
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "status", data: { stage: "checkHealth", status: "completed" }
                });
                await this.deploymentService.publishEvent(deploymentId, {
                    type: "log",
                    data: { 
                        level: "INFO", 
                        message: `Health check passed`,
                        stream: "stdout"
                    }
                });
            }

            return result;

        } catch (error: any) {
            this.logger.error(`checkHealth failed for ${deploymentId}: ${error.message}`);
            await this.deploymentService.publishEvent(deploymentId, {
                type: "error", data: { stage: "checkHealth", message: error.message }
            });
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { level: "ERROR", message: `checkHealth failed: ${error.message}`, stream: "stderr" }
            });

            throw error;
        }
    }

    @ActivityMethod('extractServicePorts')
    async extractServicePorts(deploymentId: string, repoUrl: string, deploymentPath: string, composeFiles: Array<{ path: string; envPath?: string }>) {
        try {
            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "extractServicePorts", status: "in-progress" }
            });

            const result = await this.dockerBuildService.extractServicePorts(deploymentPath, repoUrl, composeFiles);

            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "extractServicePorts", status: "completed" }
            });


            const totalPorts = Object.values(result).flat().length;
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { 
                    level: "INFO", 
                    message: `Found ${totalPorts} port(s) across ${Object.keys(result).length} service(s)`,
                    stream: "stdout"
                }
            });

            return result;

        } catch (error: any) {
            this.logger.error(`extractServicePorts failed for ${deploymentId}: ${error.message}`);
            await this.deploymentService.publishEvent(deploymentId, {
                type: "error", data: { stage: "extractServicePorts", message: error.message }
            });
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { level: "ERROR", message: `extractServicePorts failed: ${error.message}`, stream: "stderr" }
            });

            throw error;
        }
    }

    @ActivityMethod('connectAndSetupNginx')
    async connectAndSetupNginx(deploymentId: string, networkName: string, servicePorts: Record<string, number[]>) {
        try {
            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "connectAndSetupNginx", status: "in-progress" }
            });

            await this.nginxService.connectAndSetupNginx(deploymentId, networkName, servicePorts);

            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "connectAndSetupNginx", status: "completed" }
            });

            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { 
                    level: "INFO", 
                    message: `Nginx configured for ${Object.keys(servicePorts).join(', ')}`,
                    stream: "stdout"
                }
            });

        } catch (error: any) {
            this.logger.error(`connectAndSetupNginx failed for ${deploymentId}: ${error.message}`);
            await this.deploymentService.publishEvent(deploymentId, {
                type: "error", data: { stage: "connectAndSetupNginx", message: error.message }
            });
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { level: "ERROR", message: `connectAndSetupNginx failed: ${error.message}`, stream: "stderr" }
            });

            if (error.message?.includes('permission denied') || error.message?.includes('config test failed')) {
                throw ApplicationFailure.nonRetryable(error.message);
            }
            throw error;
        }
    }

    @ActivityMethod('checkConnectivity')
    async checkConnectivity({ deploymentId, deploymentPath, repoUrl, composeFiles, networkName }: {
        deploymentId: string;
        deploymentPath: string;
        repoUrl: string;
        composeFiles: Array<{ path: string; envPath?: string }>;
        networkName: string;
    }) {
        try {
            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "checkConnectivity", status: "in-progress" }
            });

            const results: { service: string; port: number; url: string; reachable: boolean; status: number | null; body: string; error: string | null }[] = [];

            let servicePorts: Record<string, number[]>;
            try {
                servicePorts = await this.dockerBuildService.extractServicePorts(deploymentPath, repoUrl, composeFiles);
            } catch (err: any) {
                this.logger.error(`Failed to extract service ports: ${err.message}`);
                return { status: 'failed', results: [{ service: 'unknown', port: 0, url: '', reachable: false, status: null, body: '', error: `Failed to extract service ports: ${err.message}` }] };
            }

            for (const [service, ports] of Object.entries(servicePorts)) {
                for (const port of ports) {
                    const domain = `${deploymentId}-${service}-${port}.${process.env.DOMAIN}`;
                    const url = `http://${domain}`;
                    this.logger.log(`Testing ${url}...`);

                    let lastError: string | null = null;
                    let success = false;

                    for (let attempt = 1; attempt <= 5; attempt++) {
                        try {
                            const curlCmd = `curl -L -s -m 5 -w "%{http_code}" ${url}`;
                            const output = execSync(curlCmd, { encoding: 'utf8' });
                            const statusCode = parseInt(output.slice(-3));
                            const body = output.slice(0, -3);

                            results.push({ service, port, url, reachable: statusCode < 500, status: statusCode, body: body.slice(0, 2000), error: null });
                            success = true;
                            break;
                        } catch (err: any) {
                            lastError = err.message;
                            if (attempt < 5) await new Promise(r => setTimeout(r, 2000));
                        }
                    }

                    if (!success) {
                        results.push({ service, port, url, reachable: false, status: null, body: '', error: `Failed after 5 attempts: ${lastError}` });
                    }
                }
            }

            const allReachable = results.every(r => r.reachable);

            await this.deploymentService.publishEvent(deploymentId, {
                type: "status", data: { stage: "checkConnectivity", status: allReachable ? "completed" : "failed" }
            });

            return { status: allReachable ? 'success' : 'failed', results };

        } catch (error: any) {
            this.logger.error(`checkConnectivity failed for ${deploymentId}: ${error.message}`);
            await this.deploymentService.publishEvent(deploymentId, {
                type: "error", data: { stage: "checkConnectivity", message: error.message }
            });
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { level: "ERROR", message: `checkConnectivity failed: ${error.message}`, stream: "stderr" }
            });

            throw error;
        }
    }
    
    @ActivityMethod('buildPublicUrls')
    async buildPublicUrls(deploymentId: string, servicePorts: Record<string, number[]>): Promise<{ service: string; url: string }[]> {
        const domain = process.env.DOMAIN;  // ← process.env works in activities
        return Object.entries(servicePorts).flatMap(([service, ports]) =>
            ports.map(port => ({
                service,
                url: `http://${deploymentId}-${service}-${port}.${domain}`
            }))
        );
    }

    @ActivityMethod('publishDeploymentEvent')
    async publishDeploymentEvent(deploymentId: string, event: { type: string; data: any }) {
        await this.deploymentService.publishEvent(deploymentId, event);
        

        if (event.type === 'deployment_ready') {
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { 
                    level: "INFO", 
                    message: `Deployment is live! URLs: ${event.data?.urls?.length || 0} service(s)`,
                    stream: "stdout"
                }
            });
        } else if (event.type === 'deployment_cancelled') {
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { 
                    level: "INFO", 
                    message: `Deployment cancelled by user: ${event.data?.reason || 'No reason given'}`,
                    stream: "stdout"
                }
            });
        } else if (event.type === 'deployment_stopped') {
            await this.deploymentService.publishEvent(deploymentId, {
                type: "log",
                data: { 
                    level: "INFO", 
                    message: `Deployment stopped: ${event.data?.reason || 'Runtime ended'}`,
                    stream: "stdout"
                }
            });
        }

        // Send webhook for important events
        if (['deployment_ready', 'deployment_cancelled', 'deployment_stopped', 'deployment_failed'].includes(event.type)) {
            await this.deploymentService.sendWebhook(deploymentId, event);
        }
    }

    @ActivityMethod('updateDeploymentStatus')
    async updateDeploymentStatus(
        deploymentId: string, 
        status: DeploymentStatus, 
        currentStage?: string,
        urls?: any[]
    ) {
        await this.deploymentService.updateDeploymentStatus(deploymentId, status, currentStage, urls);
    }

    @ActivityMethod('teardownDeployment')
    async teardownDeployment(
        deploymentId: string, 
        deploymentPath: string, 
        repoUrl: string, 
        networkName: string, 
        composeFiles: Array<{ path: string; envPath?: string }>,
        imageNames?: string[]
    ) {
        // 1. Compose down FIRST - stop the app containers
        for (const composeFile of composeFiles) {
            try {
                const composeFilePath = await this.workspaceService.getRepoFilePath(deploymentPath, repoUrl, composeFile.path);
                await this.dockerService.composeDown({ projectName: deploymentId, composeFilePath });
            } catch (err: any) {
                this.logger.warn(`Compose down skipped for ${composeFile.path}: ${err.message}`);
            }
        }
        

        // 2. Remove images
        if (imageNames) {
            for (const imageName of imageNames) {
                await this.dockerService.removeImage(imageName);
            }
        }

        // 3. Disconnect nginx from network BEFORE removing network
        try {
            await this.dockerService.disconnectFromNetwork(networkName);
        } catch (err: any) {
            this.logger.warn(`Nginx disconnect skipped: ${err.message}`);
        }
        
        // 4. Nginx teardown - remove config
        try {
            await this.nginxService.teardownNginx(deploymentId);
        } catch (err: any) {
            this.logger.warn(`Nginx teardown skipped: ${err.message}`);
        }
        
        // 5. Network last - after everything is disconnected
        try {
            await this.dockerService.removeJobNetwork(networkName);
        } catch (err: any) {
            this.logger.warn(`Network removal skipped: ${err.message}`);
        }
        
        this.logger.log(`Teardown completed for ${deploymentId}`);
    }

}