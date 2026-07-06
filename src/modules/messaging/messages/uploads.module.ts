import { Module } from '@nestjs/common';
import { UploadsService } from './uploads.service';

/**
 * Expõe o UploadsService de forma reutilizável fora do MessagingModule
 * (ex.: upload do logo da organização). O serviço é stateless — só depende
 * de ConfigService (global) e do disco — então uma instância própria aqui
 * não conflita com a do Messaging.
 */
@Module({
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
