import { Module } from '@nestjs/common';
import { getTemporalModule, WorkspaceService, ContainerizationAgentGraph, LlmService, DockerBuildService, DockerService, NginxService, DeploymentService, PrismaService, DeploymentRepository } from '@githubdemo/libraries';

import { AllActivity } from './activities/all.activity.js';
import { HealthController } from './health.controller.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const activities = [
  WorkspaceService,
  DockerBuildService,
  DockerService,
  LlmService,
  NginxService,
  DeploymentService,
  DeploymentRepository,
  PrismaService,
  ContainerizationAgentGraph,
  AllActivity,
];
@Module({
  imports: [
    getTemporalModule(true, require.resolve('./workflows'), activities),
  ],
  controllers: [HealthController],
  providers: [...activities],

})
export class AppModule {}