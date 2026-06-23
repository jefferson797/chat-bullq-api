import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { UploadsService } from './uploads.service';

/**
 * Resolves a playable URL for an inbound media message.
 *
 * WhatsApp delivers media as encrypted .enc CDN URLs that browsers can't play.
 * The provider adapter knows how to decrypt and hand us a playable URL; we
 * cache it on `message.content.mediaUrl` so each message hits the provider
 * at most once. (If the cached URL eventually expires the client will get a
 * 404 on playback and we can re-resolve then — not worth the complexity yet.)
 */
@Injectable()
export class MediaResolverService {
  private readonly logger = new Logger(MediaResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly uploads: UploadsService,
  ) {}

  async resolve(
    messageId: string,
    organizationId: string,
    access: import('../../iam/channel-access/channel-access.service').ChannelAccess = 'ALL',
  ): Promise<{ url: string; mimeType?: string }> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: { include: { channel: true } } },
    });
    if (!message) throw new NotFoundException('Message not found');
    if (message.conversation.organizationId !== organizationId) {
      throw new NotFoundException('Message not found');
    }
    if (
      access !== 'ALL' &&
      !access.has(message.conversation.channelId)
    ) {
      throw new NotFoundException('Message not found');
    }

    const content = (message.content ?? {}) as Record<string, any>;

    // 1) Já re-hospedado no nosso servidor → permanente, retorna direto.
    if (
      typeof content.mediaUrl === 'string' &&
      content.mediaUrl.includes('/api/v1/uploads/')
    ) {
      return { url: content.mediaUrl, mimeType: content.mimeType };
    }
    // 2) Mídia confirmada como sumida no provider → não fica retentando.
    if (content.mediaUnavailable === true && typeof content.mediaUrl === 'string') {
      return { url: content.mediaUrl, mimeType: content.mimeType };
    }

    const channel = message.conversation.channel;

    // 3) Descobre uma URL tocável: a externa já cacheada, ou resolve no adapter.
    let sourceUrl: string | undefined =
      typeof content.mediaUrl === 'string' && content.mediaUrl
        ? content.mediaUrl
        : undefined;
    let mimeType: string | undefined =
      typeof content.mimeType === 'string' ? content.mimeType : undefined;

    if (!sourceUrl) {
      const externalId = message.externalId;
      if (!externalId) {
        throw new BadRequestException('Message has no external id to resolve');
      }
      const adapter = this.adapterRegistry.getOutbound(channel.type);
      if (!adapter.resolveInboundMediaUrl) {
        throw new BadRequestException(
          `Media resolution not implemented for ${channel.type}`,
        );
      }
      const resolved = await adapter.resolveInboundMediaUrl(channel, {
        externalMessageId: externalId,
        mediaId: typeof content.mediaId === 'string' ? content.mediaId : undefined,
        mimeType,
        originalFilename:
          typeof content.fileName === 'string' ? content.fileName : undefined,
      });
      sourceUrl = resolved.fileUrl;
      mimeType = mimeType || resolved.mimeType;
    }

    // 4) Re-hospeda (baixa + salva local) pra sobreviver à expiração do
    //    provider. Lazy: só na primeira visualização, fora do hot path de
    //    ingestão. Em caso de falha, cai pro comportamento antigo (URL do
    //    provider) — e marca como indisponível se a mídia sumiu de vez.
    try {
      const rehosted = await this.rehostMedia(
        sourceUrl,
        mimeType,
        channel.id,
        typeof content.fileName === 'string' ? content.fileName : null,
      );
      await this.prisma.message.update({
        where: { id: messageId },
        data: {
          content: {
            ...content,
            mediaUrl: rehosted.url,
            mimeType: rehosted.mimeType,
            mediaRehosted: true,
          } as any,
        },
      });
      return { url: rehosted.url, mimeType: rehosted.mimeType };
    } catch (err: any) {
      const gone = err?.mediaGone === true;
      await this.prisma.message
        .update({
          where: { id: messageId },
          data: {
            content: {
              ...content,
              mediaUrl: sourceUrl,
              ...(mimeType && !content.mimeType ? { mimeType } : {}),
              ...(gone ? { mediaUnavailable: true } : {}),
            } as any,
          },
        })
        .catch(() => undefined);
      this.logger.warn(
        `media rehost failed for ${messageId}: ${err?.message ?? err}`,
      );
      return { url: sourceUrl, mimeType };
    }
  }

  /**
   * Baixa a mídia da URL do provider e salva no nosso storage local,
   * devolvendo uma URL permanente (/api/v1/uploads/...). Lança com
   * `mediaGone=true` quando o provider retorna 403/404/410 (mídia apagada).
   */
  private async rehostMedia(
    sourceUrl: string,
    mimeType: string | undefined,
    channelId: string,
    originalFilename: string | null,
  ): Promise<{ url: string; mimeType: string }> {
    const resp = await fetch(sourceUrl);
    if (!resp.ok) {
      const e: any = new Error(`source returned ${resp.status}`);
      if ([403, 404, 410].includes(resp.status)) e.mediaGone = true;
      throw e;
    }
    const len = Number(resp.headers.get('content-length') || 0);
    if (len && len > UploadsService.MAX_INBOUND_BYTES) {
      throw new Error(`media too large (${len} bytes)`);
    }
    const ct = (resp.headers.get('content-type') || mimeType || 'application/octet-stream')
      .split(';')[0]
      .trim();
    const buffer = Buffer.from(await resp.arrayBuffer());
    const saved = await this.uploads.saveInboundMedia({
      buffer,
      mimeType: ct,
      channelId,
      originalFilename,
    });
    return { url: saved.url, mimeType: saved.mimeType };
  }
}
