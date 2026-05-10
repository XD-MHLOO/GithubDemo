import { Module } from '@nestjs/common';
import { 
    WorkspaceService, 
    ContainerizationAgentGraph, 
    LlmService, 
    DockerBuildService, 
    DockerService, 
    DeploymentService, 
    PrismaService, 
    DeploymentRepository,
  } from "@githubdemo/libraries";
import { DeploymentController } from "./routes/deployemnt.controller.js";
import { HttpModule } from '@nestjs/axios';
import * as https from 'https';

@Module({
  imports: [
    HttpModule.register({
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
    }),
  })
  ],
  controllers: [DeploymentController],
  providers: [
    WorkspaceService,
    LlmService,
    DockerService,
    DockerBuildService,
    DeploymentService,
    DeploymentRepository,
    ContainerizationAgentGraph,
    PrismaService
  ],
  exports: [],
})
export class ApiModule  {}