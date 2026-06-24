import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { statfs } from 'fs/promises';
import * as os from 'os';
import { PrismaService } from '../../database/prisma.service';

/**
 * Monitora o servidor e fala com o operador no WhatsApp (via Zappfy):
 *  - ALERTA de disco quando passa de DISK_ALERT_THRESHOLD (default 80%).
 *  - STATUS diário (CPU/carga, memória, disco, uptime) no horário configurado.
 *
 * Roda um tick a cada 30min (setInterval), sem dependência de cron/fila.
 * Tudo inerte se DISK_ALERT_NUMBER (destinatário) estiver vazio.
 *
 * Envs:
 *   DISK_ALERT_NUMBER      WhatsApp do operador (só dígitos, DDI+DDD+número)
 *   DISK_ALERT_THRESHOLD   % de alerta de disco (default 80)
 *   SERVER_STATUS_HOUR     hora do resumo diário (0-23, default 8); -1 desliga
 *   SERVER_STATUS_TZ       fuso (default America/Sao_Paulo)
 */
@Injectable()
export class DiskMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DiskMonitorService.name);
  private static readonly ZAPPFY_BASE = 'https://api.zappfy.io';
  private static readonly TICK_MS = 30 * 60 * 1000; // 30min

  private diskAlerted = false;
  private lastDiskAlertAt = 0;
  private lastDigestDay = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    setTimeout(() => void this.tick(), 60_000);
    this.timer = setInterval(() => void this.tick(), DiskMonitorService.TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const number = (this.config.get<string>('DISK_ALERT_NUMBER') || '').replace(/\D/g, '');
    if (!number) return;
    try {
      const m = await this.collect();
      await this.maybeDiskAlert(number, m);
      await this.maybeDailyDigest(number, m);
    } catch (err: any) {
      this.logger.warn(`server monitor tick failed: ${err?.message ?? err}`);
    }
  }

  // ─── Alerta de disco ─────────────────────────────────────────────────

  private async maybeDiskAlert(number: string, m: Metrics): Promise<void> {
    const threshold = Number(this.config.get('DISK_ALERT_THRESHOLD') || 80);
    if (m.diskPct < threshold - 5) {
      this.diskAlerted = false;
      return;
    }
    if (m.diskPct < threshold) return;
    const dayMs = 24 * 60 * 60 * 1000;
    if (this.diskAlerted && Date.now() - this.lastDiskAlertAt < dayMs) return;

    const text =
      `⚠️ *Alerta de disco — Tuner / Conversas*\n\n` +
      `O disco do servidor está em *${m.diskPct}%* (limite: ${threshold}%).\n` +
      `Livre: ${m.diskFreeGb.toFixed(1)} GB de ${m.diskTotalGb.toFixed(1)} GB.\n\n` +
      `A mídia das conversas vai acumulando. Recomendado liberar espaço ou ampliar o disco.`;
    if (await this.sendWhatsapp(number, text)) {
      this.diskAlerted = true;
      this.lastDiskAlertAt = Date.now();
      this.logger.warn(`disk alert sent (${m.diskPct}%)`);
    }
  }

  // ─── Resumo diário ───────────────────────────────────────────────────

  private async maybeDailyDigest(number: string, m: Metrics): Promise<void> {
    const hour = Number(this.config.get('SERVER_STATUS_HOUR') ?? 8);
    if (hour < 0 || hour > 23) return; // desligado
    const tz = this.config.get<string>('SERVER_STATUS_TZ') || 'America/Sao_Paulo';
    const { day, hour: localHour } = this.localNow(tz);
    if (localHour !== hour) return;
    if (this.lastDigestDay === day) return; // já mandou hoje

    const text =
      `📊 *Status do servidor — Tuner / Conversas*\n` +
      `${day}\n\n` +
      `🖥️ *CPU:* ${m.cpuPct}% · carga ${m.load1.toFixed(2)} (${m.cores} núcleos)\n` +
      `🧠 *Memória:* ${m.memUsedGb.toFixed(1)} / ${m.memTotalGb.toFixed(1)} GB (${m.memPct}%)\n` +
      `💾 *Disco:* ${(m.diskTotalGb - m.diskFreeGb).toFixed(1)} / ${m.diskTotalGb.toFixed(1)} GB (${m.diskPct}%) · ${m.diskFreeGb.toFixed(1)} GB livres\n` +
      `⏱️ *Uptime:* ${m.uptime}`;
    if (await this.sendWhatsapp(number, text)) {
      this.lastDigestDay = day;
      this.logger.log(`daily status sent (${day})`);
    }
  }

  // ─── Coleta de métricas ──────────────────────────────────────────────

  private async collect(): Promise<Metrics> {
    const dir = this.config.get<string>('UPLOADS_DIR') || '/app/uploads';
    const s = await statfs(dir);
    const diskTotal = s.blocks * s.bsize;
    const diskAvail = s.bavail * s.bsize;

    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const cpuPct = await this.cpuPercent();

    return {
      diskPct: Math.round(((diskTotal - diskAvail) / diskTotal) * 100),
      diskFreeGb: diskAvail / 1024 ** 3,
      diskTotalGb: diskTotal / 1024 ** 3,
      memUsedGb: (memTotal - memFree) / 1024 ** 3,
      memTotalGb: memTotal / 1024 ** 3,
      memPct: Math.round(((memTotal - memFree) / memTotal) * 100),
      cpuPct,
      load1: os.loadavg()[0],
      cores: os.cpus().length,
      uptime: this.fmtUptime(os.uptime()),
    };
  }

  private async cpuPercent(): Promise<number> {
    const a = this.cpuTimes();
    await new Promise((r) => setTimeout(r, 200));
    const b = this.cpuTimes();
    const idle = b.idle - a.idle;
    const total = b.total - a.total;
    return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
  }

  private cpuTimes(): { idle: number; total: number } {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      for (const t of Object.values(c.times)) total += t;
      idle += c.times.idle;
    }
    return { idle, total };
  }

  private fmtUptime(sec: number): string {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const mi = Math.floor((sec % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${mi}min` : `${mi}min`;
  }

  private localNow(tz: string): { day: string; hour: number } {
    const now = new Date();
    try {
      const fmt = new Intl.DateTimeFormat('pt-BR', {
        timeZone: tz,
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        hour12: false,
      });
      const parts = fmt.formatToParts(now);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      return { day: `${get('day')}/${get('month')}`, hour: Number(get('hour')) % 24 };
    } catch {
      return {
        day: `${now.getUTCDate()}/${now.getUTCMonth() + 1}`,
        hour: now.getUTCHours(),
      };
    }
  }

  // ─── Envio ───────────────────────────────────────────────────────────

  private async sendWhatsapp(number: string, text: string): Promise<boolean> {
    try {
      const channel = await this.prisma.channel.findFirst({
        where: { type: 'WHATSAPP_ZAPPFY', deletedAt: null, isActive: true },
        select: { config: true },
      });
      const token = (channel?.config as Record<string, any>)?.token;
      if (!token) {
        this.logger.warn('server monitor: nenhum canal Zappfy ativo com token');
        return false;
      }
      const resp = await fetch(`${DiskMonitorService.ZAPPFY_BASE}/send/text`, {
        method: 'POST',
        headers: { token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number, text, delay: 0 }),
      });
      if (!resp.ok) {
        this.logger.warn(`server monitor send failed: HTTP ${resp.status}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.warn(`server monitor send error: ${err?.message ?? err}`);
      return false;
    }
  }
}

interface Metrics {
  diskPct: number;
  diskFreeGb: number;
  diskTotalGb: number;
  memUsedGb: number;
  memTotalGb: number;
  memPct: number;
  cpuPct: number;
  load1: number;
  cores: number;
  uptime: string;
}
