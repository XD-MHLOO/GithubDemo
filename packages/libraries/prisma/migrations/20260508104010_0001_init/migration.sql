-- Create schema for LangGraph checkpoints
CREATE SCHEMA IF NOT EXISTS agent;

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "githubUrl" TEXT NOT NULL,
    "ref" TEXT NOT NULL DEFAULT '',
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "currentStage" TEXT,
    "errorMessage" TEXT,
    "urls" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "userId" TEXT,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentEvent" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "stage" TEXT,
    "status" TEXT,
    "message" TEXT NOT NULL,
    "details" TEXT,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentLog" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stream" TEXT NOT NULL DEFAULT 'stdout',
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Deployment_status_idx" ON "Deployment"("status");

-- CreateIndex
CREATE INDEX "Deployment_createdAt_idx" ON "Deployment"("createdAt");

-- CreateIndex
CREATE INDEX "Deployment_userId_idx" ON "Deployment"("userId");

-- CreateIndex
CREATE INDEX "DeploymentEvent_deploymentId_idx" ON "DeploymentEvent"("deploymentId");

-- CreateIndex
CREATE INDEX "DeploymentEvent_timestamp_idx" ON "DeploymentEvent"("timestamp");

-- CreateIndex
CREATE INDEX "DeploymentEvent_deploymentId_timestamp_idx" ON "DeploymentEvent"("deploymentId", "timestamp");

-- CreateIndex
CREATE INDEX "DeploymentLog_deploymentId_idx" ON "DeploymentLog"("deploymentId");

-- CreateIndex
CREATE INDEX "DeploymentLog_deploymentId_timestamp_idx" ON "DeploymentLog"("deploymentId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentEvent" ADD CONSTRAINT "DeploymentEvent_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
