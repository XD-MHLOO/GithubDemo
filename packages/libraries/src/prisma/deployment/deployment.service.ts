import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { Redis } from 'ioredis';
import { DeploymentRepository } from './deployment.repository.js';
import { DeploymentStatus } from '../../generated/prisma/client.js';

@Injectable()
export class DeploymentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeploymentService.name);
  private redisSubscriber!: Redis;
  private redisPublisher!: Redis;
  private deploymentStreams = new Map<string, Subject<any>>();

  constructor(private deploymentRepository: DeploymentRepository) {}

  async onModuleInit() {
    this.redisSubscriber = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      lazyConnect: false,
      retryStrategy: (times) => {
        console.log(`Redis reconnecting... attempt ${times}`);
        return Math.min(times * 100, 5000);
      }
    });
    
    this.redisPublisher = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
    });
    
    await this.redisSubscriber.psubscribe('deployment:*');
    
    this.redisSubscriber.on('pmessage', (pattern, channel, message) => {
      const deploymentId = channel.split(':')[1];
      const stream = this.deploymentStreams.get(deploymentId);
      
      if (stream) {
        const parsedMessage = JSON.parse(message);
        stream.next(parsedMessage);
      }
    });
    
    console.log('Redis subscriber active - listening for deployment events');
  }

  async onModuleDestroy() {
    await this.redisSubscriber.quit();
    await this.redisPublisher.quit();
  }

  private async storeEvent(deploymentId: string, event: any) {
    try {
      if (event.type === 'log') {
        await this.deploymentRepository.createLog({
          deploymentId,
          level: event.data.level || 'INFO',
          message: event.data.message,
          stream: event.data.stream || 'stdout',
        });
      } else {
        await this.deploymentRepository.createEvent({
          deploymentId,
          type: event.type,
          stage: event.data?.stage,
          status: event.data?.status,
          message: event.data?.message || event.type,
          details: event.data?.details,
          metadata: event.data,
        });
      }
    } catch (error) {
      console.error('Failed to store event:', error);
    }
  }

  // SSE Stream
  getDeploymentStream(id: string): Observable<any> {
    let stream = this.deploymentStreams.get(id);
    
    if (!stream) {
      stream = new Subject<any>();
      this.deploymentStreams.set(id, stream);
    }
    
    return stream.asObservable();
  }

  // Publish event
  async publishEvent(id: string, event: { type: string; data?: any }) {
    const message = {
      ...event,
      deploymentId: id,
      timestamp: new Date().toISOString()
    };
    
    await this.redisPublisher.publish(`deployment:${id}`, JSON.stringify(message));
    await this.storeEvent(id, message);
  }

  // Create deployment
  async createDeployment(githubUrl: string, ref: string = '', config: { timeoutMinutes: number; cpuLimit: number; memoryLimit: string }, userId?: string,) {
    return this.deploymentRepository.create({ githubUrl, ref, config, userId});
  }

  // Get deployment by id
  async getDeployment(id: string) {
    return this.deploymentRepository.findById(id);
  }

  // Get deployment with details
  async getDeploymentWithDetails(id: string) {
    return this.deploymentRepository.findByIdWithDetails(id);
  }

  // Get all deployments
  async getAllDeployments() {
    return this.deploymentRepository.findAll();
  }

  // Get recent deployments
  async getRecentDeployments(limit: number = 10) {
    return this.deploymentRepository.findRecent(limit);
  }

  // Get deployments by status
  async getDeploymentsByStatus(status: DeploymentStatus) {
    return this.deploymentRepository.findByStatus(status);
  }

  // Get user deployments
  async getUserDeployments(userId: string) {
    return this.deploymentRepository.findByUserId(userId);
  }

  // Update deployment status
  async updateDeploymentStatus(
    id: string, 
    status: DeploymentStatus, 
    currentStage?: string,
    urls?: any[],
    errorMessage?: string
  ) {
    await this.publishEvent(id, { type: 'status', data: { stage: currentStage, status } });
    return this.deploymentRepository.updateStatus(id, status, currentStage, urls, errorMessage);
  }

  // Update stage
  async updateStage(id: string, stage: string) {
    return this.deploymentRepository.updateStage(id, stage);
  }

  // Delete deployment
  async deleteDeployment(id: string) {
    return this.deploymentRepository.delete(id);
  }

  // Cleanup old deployments
  async cleanupOldDeployments(daysOld: number = 30) {
    return this.deploymentRepository.deleteOldDeployments(daysOld);
  }

  // Get timeline
  async getDeploymentTimeline(id: string) {
    return this.deploymentRepository.findEventsByDeploymentId(id);
  }

  // Get logs
  async getDeploymentLogs(id: string) {
    return this.deploymentRepository.findLogsByDeploymentId(id);
  }

    async sendWebhook(deploymentId: string, event: { type: string; data: any }) {
      const deployment = await this.deploymentRepository.findById(deploymentId);
      const webhookUrl = (deployment?.config as any)?.webhookUrl;
      
      if (!webhookUrl) return;
      
      try {
          await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  deploymentId,
                  type: event.type,
                  data: event.data,
                  timestamp: new Date().toISOString(),
              }),
          });
          this.logger.log(`Webhook sent to ${webhookUrl} for ${deploymentId}`);
      } catch (error: any) {
          this.logger.warn(`Webhook failed for ${deploymentId}: ${error.message}`);
      }
  }

}