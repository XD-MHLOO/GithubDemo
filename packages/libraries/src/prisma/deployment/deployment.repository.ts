import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { DeploymentStatus } from '../../generated/prisma/client.js';

@Injectable()
export class DeploymentRepository {
  constructor(private prisma: PrismaService) {}

  // Create
  async create(data: {
    githubUrl: string;
    config: { timeoutMinutes: number; cpuLimit: number; memoryLimit: string };
    ref?: string;
    userId?: string;
  }) {
    return this.prisma.deployment.create({
      data: {
        githubUrl: data.githubUrl,
        ref: data.ref || '',
        status: DeploymentStatus.PENDING,
        currentStage: 'initializing',
        userId: data.userId,
        config: data.config,
      },
    });
  }

  // Find by id
  async findById(id: string) {
    return this.prisma.deployment.findUnique({
      where: { id },
      include: { user: true },
    });
  }

  // Get all deployments
  async findAll() {
    return this.prisma.deployment.findMany({
      orderBy: { createdAt: 'desc' },
      include: { user: true },
    });
  }

  // Get recent deployments with limit
  async findRecent(limit: number = 10) {
    return this.prisma.deployment.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: true },
    });
  }

  // Find by status
  async findByStatus(status: DeploymentStatus) {
    return this.prisma.deployment.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Find by user
  async findByUserId(userId: string) {
    return this.prisma.deployment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(
    id: string, 
    status: DeploymentStatus, 
    currentStage?: string,
    urls?: any[],
    errorMessage?: string
  ) {
    const data: any = { status };
    if (currentStage) data.currentStage = currentStage;
    if (urls) data.urls = urls;
    if (errorMessage) data.errorMessage = errorMessage;
    
    if (status === DeploymentStatus.SUCCESS || 
        status === DeploymentStatus.FAILED || 
        status === DeploymentStatus.CANCELLED) {
      data.completedAt = new Date();
    }
    
    return this.prisma.deployment.update({ where: { id }, data });
  }
  // Update current stage only
  async updateStage(id: string, currentStage: string) {
    return this.prisma.deployment.update({
      where: { id },
      data: { currentStage },
    });
  }

  // Delete
  async delete(id: string) {
    return this.prisma.deployment.delete({
      where: { id },
    });
  }

  // Count by status
  async countByStatus(status: DeploymentStatus) {
    return this.prisma.deployment.count({
      where: { status },
    });
  }

  // Delete old deployments (cleanup)
  async deleteOldDeployments(daysOld: number = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    
    return this.prisma.deployment.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
        status: { in: [DeploymentStatus.SUCCESS, DeploymentStatus.FAILED] }
      },
    });
  }

  // Create deployment event
  async createEvent(data: {
    deploymentId: string;
    type: string;
    stage?: string;
    status?: string;
    message: string;
    details?: string;
    metadata?: any;
  }) {
    return this.prisma.deploymentEvent.create({
      data: {
        deploymentId: data.deploymentId,
        type: data.type,
        stage: data.stage,
        status: data.status,
        message: data.message,
        details: data.details,
        metadata: data.metadata,
      },
    });
  }

  // Create deployment log
  async createLog(data: {
    deploymentId: string;
    level: string;
    message: string;
    stream: string;
  }) {
    return this.prisma.deploymentLog.create({
      data: {
        deploymentId: data.deploymentId,
        level: data.level,
        message: data.message,
        stream: data.stream,
      },
    });
  }

  // Find events by deployment ID
  async findEventsByDeploymentId(deploymentId: string) {
    return this.prisma.deploymentEvent.findMany({
      where: { deploymentId },
      orderBy: { timestamp: 'asc' },
    });
  }

  // Find logs by deployment ID
  async findLogsByDeploymentId(deploymentId: string) {
    return this.prisma.deploymentLog.findMany({
      where: { deploymentId },
      orderBy: { timestamp: 'asc' },
    });
  }

  // Get deployment with events and logs
  async findByIdWithDetails(id: string) {
    return this.prisma.deployment.findUnique({
      where: { id },
      include: {
        events: {
          orderBy: { timestamp: 'asc' },
        },
        logs: {
          orderBy: { timestamp: 'desc' },
          take: 100,
        },
        user: true,
      },
    });
  }
}