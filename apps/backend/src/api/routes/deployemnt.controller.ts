// deployment.controller.ts
import { Controller, Post, Body, Get, Param, Delete, Query, Sse, NotFoundException } from '@nestjs/common';
import { DeploymentService, CreateDeploymentDto } from '@githubdemo/libraries';
import { DeploymentStatus } from '@githubdemo/libraries';
import { map, Observable } from 'rxjs';
import { MessageEvent } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';

@Controller('deployments')
export class DeploymentController {
  constructor(
    private readonly deploymentService: DeploymentService,
    private readonly temporal: TemporalService,
  ) {}

  @Post('create')
  async createDeployment(@Body() body: CreateDeploymentDto) {
      const config = {
          timeoutMinutes: body.timeoutMinutes || 60,
          cpuLimit: body.cpuLimit || 1,
          memoryLimit: body.memoryLimit || '1G',
          webhookUrl: body.webhookUrl || null
      };

      const deployment = await this.deploymentService.createDeployment(
          body.githubUrl,
          body.ref,
          config,
          body.userId,
            
      );
      
      await this.temporal.startWorkflow('analyzeWorkflow', [{ 
          deploymentId: deployment.id, 
          githubUrl: body.githubUrl, 
          ref: body.ref,       
          config             
      }], {
          workflowId: deployment.id,
          taskQueue: 'main',
      });
      
      return { 
          deploymentId: deployment.id, 
          message: 'Deployment started',
          deployment 
      };
  }

  @Get()
  async getAll() {
    return this.deploymentService.getAllDeployments();
  }

  @Get('recent')
  async getRecent(@Query('limit') limit?: string) {
    return this.deploymentService.getRecentDeployments(limit ? parseInt(limit) : 10);
  }

  @Get('status/:status')
  async getByStatus(@Param('status') status: DeploymentStatus) {
    return this.deploymentService.getDeploymentsByStatus(status);
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
      const deployment = await this.deploymentService.getDeploymentWithDetails(id);
      
      if (!deployment) {
          throw new NotFoundException(`Deployment ${id} not found`);
      }
      
      const timeline = await this.deploymentService.getDeploymentTimeline(id);
      const logs = await this.deploymentService.getDeploymentLogs(id);
      
    return {
        id: deployment.id,
        githubUrl: deployment.githubUrl,
        ref: deployment.ref,
        status: deployment.status,
        currentStage: deployment.currentStage,
        urls: deployment.urls,
        config: deployment.config,
        createdAt: deployment.createdAt,
        updatedAt: deployment.updatedAt,
        completedAt: deployment.completedAt,
        errorMessage: deployment.errorMessage,
        userId: deployment.userId,
        timeline,
        logs,
    };
  }

  @Get(':id/timeline')
  async getTimeline(@Param('id') id: string) {
    return this.deploymentService.getDeploymentTimeline(id);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
      // Always try to forcefully terminate the workflow first
      try {
          await this.temporal.terminateWorkflow(id, 'Deleted by user');
      } catch (error) {
          // Workflow doesn't exist or already dead - that's fine
      }
      
      return this.deploymentService.deleteDeployment(id);
  }

  @Sse(':id/stream')
  streamDeployment(@Param('id') id: string): Observable<MessageEvent> {
    return this.deploymentService.getDeploymentStream(id).pipe(
      map((data) => ({ 
        data: JSON.stringify(data) 
      } as MessageEvent))
    );
  }

  @Post(':id/terminate')
  async terminateDeployment(@Param('id') id: string) {
      try {
          // Set status to show user it's being processed
          await this.deploymentService.updateDeploymentStatus(
              id, 
              DeploymentStatus.PROCESSING, 
              'terminating'
          );
          
          await this.temporal.signalWorkflow(id, 'cancel', []);
          return { message: 'Termination signal sent', deploymentId: id };
      } catch (error: any) {
          // Workflow already gone - mark as cancelled directly
          if (error.message?.includes('workflow execution already completed')) {
              await this.deploymentService.updateDeploymentStatus(
                  id, 
                  DeploymentStatus.CANCELLED, 
                  'terminated'
              );
              return { message: 'Deployment terminated', deploymentId: id };
          }
          return { message: `Failed to terminate: ${error.message}`, deploymentId: id };
      }
  }

  @Post(':id/fix')
  async fixDeployment(@Param('id') id: string) {
      try {
          await this.temporal.signalWorkflow(id, 'fixNeeded', ['User requested fix']);
          return { message: 'Fix signal sent', deploymentId: id };
      } catch (error: any) {
          return { message: `Failed to send fix signal: ${error.message}`, deploymentId: id };
      }
  }
}