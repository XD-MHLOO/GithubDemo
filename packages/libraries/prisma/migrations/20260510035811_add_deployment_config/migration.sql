/*
  Warnings:

  - Added the required column `config` to the `Deployment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "config" JSONB NOT NULL;
