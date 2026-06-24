import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { statfs } from 'fs/promises';
import { PrismaService } from '../../database/prisma.service';

/**
 * Monitora o uso de disco do servidor e avisa o operador no WhatsApp quando
 * passa de um limite. A mídia das conversas é re-hospedada localmente
 * (volume persistente), então o disco cresce com o tempo — este alerta evita
 * a surpresa de encher.
 *
 * - Checa a cada 6h via `statfs` no diretório de uploads (que mora no volume
 *   montado do host, então reflete o disco real do servidor).
 * - Envia direto pela API do Zappfy (`/send/text`) usando o token do canal
 *   ativo — não depende de conversa.
 * - Anti-spam: alerta no máximo 1x/dia enquanto acima do limite; rearma
 *   quando o disco cai abaixo de (limite - 5%).
 *
 * Config por env:
 *   DISK_ALERT_NUMBER     número de WhatsApp do operador (só dígitos, com DDI/DDD)
 *   DISK_ALERT_THRESHOLD  percentual de alerta (default 80)
 */
@Injectable()
export class DiskMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DiskMonitorService.name);
  private static readonly ZAPPFY_BASE = 'https://api.zappfy.io';
  private static readonly INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

  private alerted = false;
  private lastAlertAt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // Primeira checagem ~1min após subir; depois a cada 6h.
    setTimeout(() => void this.check(), 60_000);
    this.timer = setInterval(
      () => void this.check(),
      DiskMonitorService.INTERVAL_MS,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<void> {
    const number = (this.config.get<string>('DISK_ALERT_NUMBER') || '').replace(/\D/g, '');
    if (!number) return; // sem destinatário configurado → não faz nada

    const threshold = Number(this.config.get('DISK_ALERT_THRESHOLD') || 80);
    const dir = this.config.get<string>('UPLOADS_DIR') || '/app/uploads';

    let pct: number;
    let freeGb: number;
    let totalGb: number;
    try {
      const s = await statfs(dir);
      const total = s.blocks * s.bsize;
      const avail = s.bavail * s.bsize;
      pct = Math.round(((total - avail) / total) * 100);
      freeGb = avail / 1024 ** 3;
      totalGb = total / 1024 ** 3;
    } catch (err: any) {
      this.logger.warn(`disk check failed (${dir}): ${err?.message ?? err}`);
      return;
    }

    this.logger.log(`disk usage ${pct}% (free ${freeGb.toFixed(1)}GB / ${totalGb.toFixed(1)}GB)`);

    // rearma quando folga voltar
    if (pct < threshold - 5) {
      this.alerted = false;
      return;
    }
    if (pct < threshold) return;

    // anti-spam: 1x/dia enquanto acima
    const dayMs = 24 * 60 * 60 * 1000;
    if (this.alerted && Date.now() - this.lastAlertAt < dayMs) return;

    const text =
      `⚠️ *Alerta de disco — Tuner / Conversas*\n\n` +
      `O disco do servidor está em *${pct}%* (limite: ${threshold}%).\n` +
      `Livre: ${freeGb.toFixed(1)} GB de ${totalGb.toFixed(1)} GB.\n\n` +
      `A mídia das conversas vai acumulando no servidor. Recomendado liberar ` +
      `espaço (limpar mídia antiga) ou ampliar o disco antes de encher.`;

    const sent = await this.sendWhatsapp(number, text);
    if (sent) {
      this.alerted = true;
      this.lastAlertAt = Date.now();
      this.logger.warn(`disk alert sent to ${number} (${pct}%)`);
    }
  }

  private async sendWhatsapp(number: string, text: string): Promise<boolean> {
    try {
      const channel = await this.prisma.channel.findFirst({
        where: { type: 'WHATSAPP_ZAPPFY', deletedAt: null, isActive: true },
        select: { config: true },
      });
      const token = (channel?.config as Record<string, any>)?.token;
      if (!token) {
        this.logger.warn('disk alert: nenhum canal Zappfy ativo com token');
        return false;
      }
      const resp = await fetch(`${DiskMonitorService.ZAPPFY_BASE}/send/text`, {
        method: 'POST',
        headers: { token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number, text, delay: 0 }),
      });
      if (!resp.ok) {
        this.logger.warn(`disk alert send failed: HTTP ${resp.status}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.warn(`disk alert send error: ${err?.message ?? err}`);
      return false;
    }
  }
}
