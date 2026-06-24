import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType, MessageDirection } from '@prisma/client';
import { HistorySyncPort } from '../../ports/history-sync.port';
import {
  FetchConversationsResult,
  FetchMessagesResult,
  HistorySyncFilters,
  NormalizedHistoricalConversation,
  NormalizedHistoricalMessage,
  SyncCapabilities,
} from '../../ports/types';
import { ZappfyHttpClient } from './zappfy.http-client';
import { ZappfyMessageMapper } from './zappfy.message-mapper';

/**
 * History-sync implementation for Zappfy / Uazapi. Mirrors the webhook mapper
 * to guarantee that messages imported by sync look identical to messages
 * received in real-time — removes the previous divergence between the two
 * code paths.
 */
@Injectable()
export class ZappfySyncAdapter implements HistorySyncPort {
  readonly channelType = ChannelType.WHATSAPP_ZAPPFY;
  private readonly logger = new Logger(ZappfySyncAdapter.name);

  constructor(
    private readonly httpClient: ZappfyHttpClient,
    private readonly mapper: ZappfyMessageMapper,
  ) {}

  getSyncCapabilities(): SyncCapabilities {
    return {
      supportsHistoryImport: true,
      supportsDeltaSync: true,
      defaultLookbackDays: 180,
      maxLookbackDays: 365,
    };
  }

  async fetchConversations(
    channel: Channel,
    filters: HistorySyncFilters,
    cursor?: string,
    limit = 50,
  ): Promise<FetchConversationsResult> {
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;
    const response = await this.httpClient.fetchChats(channel, { limit, offset });
    const rawChats: any[] = response?.chats || [];

    const conversations: NormalizedHistoricalConversation[] = [];
    for (const chat of rawChats) {
      const externalId = chat.wa_chatid || chat.chatid || chat.id;
      if (!externalId) continue;

      const isGroup = !!chat.wa_isGroup || String(externalId).endsWith('@g.us');
      const name =
        chat.wa_contactName || chat.wa_name || chat.name || chat.phone || externalId;
      const phone = isGroup
        ? undefined
        : chat.phone || String(externalId).replace(/@.*/, '');
      const lastMessageAt = this.parseTs(chat.wa_lastMsgTimestamp);

      if (filters.sinceTimestamp && lastMessageAt && lastMessageAt < filters.sinceTimestamp) {
        continue;
      }

      conversations.push({
        externalConversationId: String(externalId),
        externalContactId: String(externalId),
        contactName: name,
        contactPhone: phone,
        contactAvatarUrl: chat.wa_profilePicUrl || undefined,
        isGroup,
        lastMessageAt,
        unreadCount: Number(chat.wa_unreadCount ?? 0),
        rawPayload: chat,
      });
    }

    const hasNext = response?.pagination?.hasNextPage ?? rawChats.length >= limit;
    return {
      conversations,
      nextCursor: hasNext ? String(offset + rawChats.length) : undefined,
    };
  }

  async fetchMessages(
    channel: Channel,
    externalConversationId: string,
    filters: HistorySyncFilters,
    cursor?: string,
    limit = 50,
  ): Promise<FetchMessagesResult> {
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;
    const response = await this.httpClient.fetchMessages(
      channel,
      externalConversationId,
      limit,
      offset,
    );
    const rawMessages: any[] = response?.messages || [];

    const messages: NormalizedHistoricalMessage[] = [];
    let reachedLookbackLimit = false;

    for (const raw of rawMessages) {
      // Feed the same mapper used by the webhook path (message wrapper shape).
      const event = { message: raw, chat: { chatid: externalConversationId } };
      const normalized = this.mapper.normalizeInbound(event as any);
      if (!normalized) continue;

      if (filters.sinceTimestamp && normalized.timestamp < filters.sinceTimestamp) {
        reachedLookbackLimit = true;
        break;
      }

      const direction = raw.fromMe
        ? MessageDirection.OUTBOUND
        : MessageDirection.INBOUND;

      messages.push({
        externalMessageId: normalized.externalMessageId,
        externalConversationId,
        externalContactId: externalConversationId,
        direction,
        timestamp: normalized.timestamp,
        type: normalized.type,
        content: normalized.content,
        senderName: normalized.senderName,
        replyToExternalId: normalized.replyTo?.externalMessageId,
        rawPayload: raw,
      });
    }

    const hasNext =
      !reachedLookbackLimit &&
      (response?.pagination?.hasNextPage ?? rawMessages.length >= limit);
    return {
      messages,
      nextCursor: hasNext ? String(offset + rawMessages.length) : undefined,
    };
  }

  private parseTs(ts: any): Date | undefined {
    if (!ts) return undefined;
    const num = typeof ts === 'string' ? parseInt(ts, 10) : Number(ts);
    if (!num || isNaN(num)) return undefined;
    return new Date(num > 9999999999 ? num : num * 1000);
  }
}
