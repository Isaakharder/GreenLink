import { db } from './db';
import type { TournamentMessage } from '../types/database';

// Write-through caching for chat, mirrors offlineCache.ts's shape for the
// tournament tables (one cacheX() per server response shape).

export async function cacheMessages(tournamentId: string, messages: TournamentMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await db.cachedMessages.bulkPut(
    messages.map((m) => ({
      id: m.id,
      tournamentId,
      senderUserId: m.sender_user_id,
      senderTeamId: m.sender_team_id,
      messageText: m.message_text,
      createdAt: m.created_at,
      deletedAt: m.deleted_at,
    })),
  );
}
