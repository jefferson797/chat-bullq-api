import { Module } from '@nestjs/common';
import { ChatbotSessionService } from './chatbot-session.service';

/**
 * Módulo-folha só com a sessão do bot (Redis). Existe pra que o messaging
 * possa encerrar a sessão quando um humano assume a conversa SEM importar o
 * ChatbotModule inteiro — o que fecharia um ciclo (chatbot → messaging → chatbot).
 */
@Module({
  providers: [ChatbotSessionService],
  exports: [ChatbotSessionService],
})
export class ChatbotSessionModule {}
