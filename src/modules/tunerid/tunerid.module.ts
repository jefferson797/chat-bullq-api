import { Global, Module } from '@nestjs/common';
import { TuneridService } from './tunerid.service';

/** Global: a autenticação e a gestão de equipe perguntam ao mesmo cliente. */
@Global()
@Module({ providers: [TuneridService], exports: [TuneridService] })
export class TuneridModule {}
