import { AutoReplyConfig, Weekday } from '../../auto-replies/auto-reply.types';

const DIAS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "08:30" → 510 minutos. */
function emMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Dia da semana e minutos do dia, no fuso da organização. */
function agoraLocal(quando: Date, timezone: string): { dow: Weekday; minutos: number; dataLocal: string } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = f.formatToParts(quando).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  const mapa: Record<string, Weekday> = {
    Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat',
  };
  const hora = p.hour === '24' ? 0 : Number(p.hour);
  return {
    dow: mapa[p.weekday] ?? 'mon',
    minutos: hora * 60 + Number(p.minute),
    dataLocal: `${p.year}-${p.month}-${p.day}`,
  };
}

/** A empresa está atendendo neste instante? */
export function dentroDoExpediente(config: AutoReplyConfig, quando = new Date()): boolean {
  const { dow, minutos } = agoraLocal(quando, config.timezone);
  const janelas = config.businessHours?.[dow] || [];
  return janelas.some(([ini, fim]) => minutos >= emMinutos(ini) && minutos < emMinutos(fim));
}

/**
 * Quantos milissegundos faltam até a empresa abrir de novo.
 *
 * Varre os próximos 8 dias (cobre feriado/fim de semana longo configurado como
 * dia sem janela). Devolve `null` se não houver nenhuma janela configurada —
 * nesse caso quem chamou decide (o SLA prefere avisar na hora a nunca avisar).
 */
export function msAteAbrir(config: AutoReplyConfig, quando = new Date()): number | null {
  const { dow, minutos } = agoraLocal(quando, config.timezone);
  const indiceHoje = DIAS.indexOf(dow);

  for (let d = 0; d < 8; d++) {
    const dia = DIAS[(indiceHoje + d) % 7];
    const janelas = [...(config.businessHours?.[dia] || [])].sort(
      (a, b) => emMinutos(a[0]) - emMinutos(b[0]),
    );
    for (const [ini] of janelas) {
      const abre = emMinutos(ini);
      // hoje só vale abertura que ainda não passou
      if (d === 0 && abre <= minutos) continue;
      const minutosAteLa = d * 24 * 60 + abre - minutos;
      return minutosAteLa * 60_000;
    }
  }
  return null;
}
