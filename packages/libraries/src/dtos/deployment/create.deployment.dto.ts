import { IsString, IsOptional, IsUrl, IsNumber, Min, Max } from 'class-validator';

export class CreateDeploymentDto {
  @IsUrl()
  @IsString()
  githubUrl!: string;

  @IsOptional()
  @IsString()
  ref?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1440)  // Max 24 hours
  timeoutMinutes?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(4)
  cpuLimit?: number;

  @IsOptional()
  @IsString()
  memoryLimit?: string;  // e.g., '512M', '1G', '2G'

  @IsOptional()
  @IsUrl()
  webhookUrl?: string;

}