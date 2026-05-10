import { Module } from "@nestjs/common";
import { ApiModule } from "./api/api.module.js";
import { getTemporalModule, LlmService } from '@githubdemo/libraries';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [
    HttpModule,
    ApiModule,
    getTemporalModule(false),
  ],
  controllers: [],
  providers: [LlmService],
})
export class AppModule {}
