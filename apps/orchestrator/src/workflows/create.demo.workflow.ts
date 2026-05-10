import { proxyActivities, defineSignal, condition, setHandler } from '@temporalio/workflow';
import { AllActivity } from '../activities/all.activity.js'

export const fixNeededSignal = defineSignal<[string]>('fixNeeded');
export const cancelSignal = defineSignal<[void]>('cancel');

const { 
    registerRepo, createJobNetwork, extractServicePorts, 
    connectAndSetupNginx, publishDeploymentEvent, updateDeploymentStatus, buildPublicUrls
} = proxyActivities<AllActivity>({
    startToCloseTimeout: '10 minutes',
    retry: { maximumAttempts: 3, initialInterval: '5s', maximumInterval: '30s', backoffCoefficient: 2 },
});

const { 
    checkHealth, checkConnectivity, teardownDeployment 
} = proxyActivities<AllActivity>({
    startToCloseTimeout: '10 minutes',
    retry: { maximumAttempts: 5, initialInterval: '5s', maximumInterval: '30s', backoffCoefficient: 2 },
});

const { 
    createCompose, fixCompose
} = proxyActivities<AllActivity>({
    startToCloseTimeout: '50 minutes',
    retry: { maximumAttempts: 15, initialInterval: '10s', maximumInterval: '60s', backoffCoefficient: 2 },
});

const { 
    buildImage, runCompose 
} = proxyActivities<AllActivity>({
    startToCloseTimeout: '50 minutes',
    retry: { maximumAttempts: 3, initialInterval: '10s', maximumInterval: '60s', backoffCoefficient: 2 },
});

export async function analyzeWorkflow({ deploymentId, githubUrl, ref, config  }: {
        deploymentId: string;
        githubUrl: string;
        ref: string;
        config: {
            timeoutMinutes: number;
            cpuLimit: number;
            memoryLimit: string;
        };
    }){

    const STAGE_TIMEOUT_MS = (config.timeoutMinutes || 60) * 60 * 1000;
    let fixRequested = false;
    let cancelled = false;
    let timedOut = false;
    let agentState: any = undefined;
    
    setHandler(fixNeededSignal, (description: string) => { fixRequested = true; });
    setHandler(cancelSignal, () => { cancelled = true; });

    await updateDeploymentStatus(deploymentId, 'PROCESSING', 'registerRepo');
    let deploymentPath: string;
    try {
        const result = await registerRepo(deploymentId, githubUrl, ref);
        deploymentPath = result.deploymentPath;
    } catch (error: any) {
        await updateDeploymentStatus(deploymentId, 'FAILED', 'registerRepo');
        await publishDeploymentEvent(deploymentId, {
            type: "deployment_failed",
            data: { reason: error.message }
        });
        return { status: 'failed' };
    }

    let repoUrl: string, stageHistory;
    try {
        const result = await createCompose(deploymentId, deploymentPath, githubUrl);
        repoUrl = result.repoUrl;
        stageHistory = result.stageHistory;
        agentState = result.agentState;
    } catch (error: any) {
        await updateDeploymentStatus(deploymentId, 'FAILED', 'createCompose');
        await publishDeploymentEvent(deploymentId, {
            type: "deployment_failed",
            data: { reason: error.message }
        });
        return { status: 'failed' };
    }

    let networkName: string;
    try {
        networkName = await createJobNetwork(deploymentId);
    } catch (error: any) {
        await updateDeploymentStatus(deploymentId, 'FAILED', 'createJobNetwork');
        await publishDeploymentEvent(deploymentId, {
            type: "deployment_failed",
            data: { reason: error.message }
        });
        return { status: 'failed' };
    }

    while (!cancelled) {
        const index = stageHistory.findIndex(s => s.status === 'pending');
        if (index === -1) break;
        const stage = stageHistory[index];

        if (stage.type === 'BUILD') {
            try {
                const result: any = await buildImage({ deploymentId, deploymentPath, repoUrl, ...stage });
                stage.status = result.status;
                if (cancelled) break;
                if (result.status === 'success') continue;
                if (result.status === 'failed') {
                    stage.status = 'fixing';
                    const { finalUpdatedStageHistory, agentState: newState } = await fixCompose(
                        deploymentId, deploymentPath, repoUrl, 1, stageHistory, agentState, result.logPath, [],
                    );
                    stageHistory = finalUpdatedStageHistory;
                    agentState = newState;
                }
            } catch (error: any) {
                await updateDeploymentStatus(deploymentId, 'FAILED', 'buildImage');
                await publishDeploymentEvent(deploymentId, {
                    type: "deployment_failed",
                    data: { reason: error.message }
                });
                return { status: 'failed' };
            }
        } else if (stage.type === 'COMPOSE') {
            try {
                const result: any = await runCompose({ deploymentId, deploymentPath, repoUrl, composeFile: stage.composeFile, networkName, config: config || { timeoutMinutes: 60, cpuLimit: 1, memoryLimit: '1G' } });
                stage.status = result.status;
                if (cancelled) break;
                if (result.status === 'success') continue;
                if (result.status === 'failed') {
                    stage.status = 'fixing';
                    const { finalUpdatedStageHistory, agentState: newState } = await fixCompose(
                        deploymentId, deploymentPath, repoUrl, 2, stageHistory, agentState, result.logPath, [stage.composeFile],
                    );
                    stageHistory = finalUpdatedStageHistory;
                    agentState = newState;
                }
            } catch (error: any) {
                await updateDeploymentStatus(deploymentId, 'FAILED', 'runCompose');
                await publishDeploymentEvent(deploymentId, {
                    type: "deployment_failed",
                    data: { reason: error.message }
                });
                return { status: 'failed' };
            }
        } else if (stage.type === 'HEALTH_CHECK') {
            try {
                const result: any = await checkHealth({ deploymentId, deploymentPath, repoUrl, composeFiles: stage.composeFiles });
                stage.status = result.status;
                if (cancelled) break;
                if (result.status === 'success') {
                    const servicePorts = await extractServicePorts(deploymentId, repoUrl, deploymentPath, stage.composeFiles);
                    await connectAndSetupNginx(deploymentId, networkName, servicePorts);
                    continue;
                }
                if (result.status === 'failed') {
                    stage.status = 'fixing';
                    const { finalUpdatedStageHistory, agentState: newState } = await fixCompose(
                        deploymentId, deploymentPath, repoUrl, 3, stageHistory, agentState, result.logPath, stage.composeFiles,
                    );
                    stageHistory = finalUpdatedStageHistory;
                    agentState = newState;
                }
            } catch (error: any) {
                stage.status = 'fixing';
                const { finalUpdatedStageHistory, agentState: newState } = await fixCompose(
                    deploymentId, deploymentPath, repoUrl, 3, stageHistory, agentState, error.message, stage.composeFiles,
                );
                stageHistory = finalUpdatedStageHistory;
                agentState = newState;
            }
        } else if (stage.type === 'CONNECTIVITY_CHECK') {
            try {
                const result: any = await checkConnectivity({ deploymentId, deploymentPath, repoUrl, composeFiles: stage.composeFiles, networkName });
                stage.status = result.status;
                if (cancelled) break;
                if (result.status === 'success') {
                    const servicePorts = await extractServicePorts(deploymentId, repoUrl, deploymentPath, stage.composeFiles);
                    const publicUrls =  await buildPublicUrls(deploymentId, servicePorts);

                    await updateDeploymentStatus(deploymentId, 'SUCCESS', 'running', publicUrls);

                    await publishDeploymentEvent(deploymentId, {
                        type: "deployment_ready",
                        data: { urls: publicUrls }
                    });
                    continue;
                }
                if (result.status === 'failed') {
                    stage.status = 'fixing';
                    const { finalUpdatedStageHistory, agentState: newState } = await fixCompose(
                        deploymentId, deploymentPath, repoUrl, 4, stageHistory, agentState, '', stage.composeFiles, result.results
                    );
                    stageHistory = finalUpdatedStageHistory;
                    agentState = newState;
                }
            } catch (error: any) {
                stage.status = 'fixing';
                const { finalUpdatedStageHistory, agentState: newState } = await fixCompose(
                    deploymentId, deploymentPath, repoUrl, 4, stageHistory, agentState, error.message, stage.composeFiles, [],
                );
                stageHistory = finalUpdatedStageHistory;
                agentState = newState;
            }
        } else if (stage.type === 'RUNTIME_TEST') {
            const triggered = await condition(() => fixRequested || cancelled, STAGE_TIMEOUT_MS);
                
            if (cancelled) break;
            if (!triggered) { timedOut = true; break; }

            if (triggered && fixRequested) {
                await updateDeploymentStatus(deploymentId, 'PROCESSING', 'fixing');
                
                stage.status = 'fixing';
                const { finalUpdatedStageHistory, agentState: newState } = await fixCompose(
                    deploymentId, deploymentPath, repoUrl, 5, stageHistory, agentState, "", stage.composeFiles,
                );
                stageHistory = finalUpdatedStageHistory;
                agentState = newState;
                fixRequested = false;
            }
        }
        
        if (cancelled) break;
    }

    if (cancelled || timedOut) {
        if (cancelled) {
            await updateDeploymentStatus(deploymentId, 'CANCELLED', 'cancelled');
            await publishDeploymentEvent(deploymentId, {
                type: "deployment_cancelled",
                data: { reason: "User cancelled" }
            });
        } else {
            await updateDeploymentStatus(deploymentId, 'COMPLETED', 'completed');
            await publishDeploymentEvent(deploymentId, {
                type: "deployment_stopped", 
                data: { reason: "Runtime period ended" }
            });
        }
        
        const healthCheckStage = stageHistory.find(s => s.type === 'HEALTH_CHECK');
        const composeFiles = healthCheckStage ? (healthCheckStage as any).composeFiles : [];
        const imageNames = stageHistory
            .filter(s => s.type === 'BUILD')
            .map(s => (s as any).imageName)
            .filter(Boolean);

        await teardownDeployment(deploymentId, deploymentPath, repoUrl, networkName, composeFiles, imageNames);
        
        return { status: cancelled ? 'cancelled' : 'completed' };
    }

    return { status: 'completed' };
}