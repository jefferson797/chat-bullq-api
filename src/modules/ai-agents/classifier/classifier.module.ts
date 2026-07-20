import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmModule } from '../llm/llm.module';
import { IntentClassifierService } from './intent-classifier.service';

/**
 * Módulo do Intent Classifier.
 *
 * Não acopla com runner/router/orchestrator — fica isolado pra que outros
 * módulos (futura integração na Fase 2 dentro do AgentRouterService) possam
 * importar e usar sem ciclo de dependência.
 */
@Module({
  imports: [ConfigModule, LlmModule],
  providers: [IntentClassifierService],
  exports: [IntentClassifierService],
})
export class ClassifierModule {}
