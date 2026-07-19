import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { supabase } from '../lib/supabaseClient';
import { db } from '../lib/db';
import { cacheMessages } from '../lib/chatCache';
import { queueMessage, flushMessageQueue } from '../lib/chatSync';
import { formatTeamName } from '../lib/leaderboard';
import { showToast } from '../lib/toast';
import { useAuth } from '../auth/useAuth';
import type { TournamentChatSummary, TournamentMessage, TournamentTeam } from '../types/database';

async function fetchMessages(tournamentId: string): Promise<TournamentMessage[]> {
  const { data, error } = await supabase
    .from('tournament_messages')
    .select('*')
    .eq('tournament_id', tournamentId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function fetchTeams(tournamentId: string): Promise<TournamentTeam[]> {
  const { data, error } = await supabase.from('tournament_teams').select('*').eq('tournament_id', tournamentId);
  if (error) throw error;
  return data ?? [];
}

async function fetchSenderNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const { data, error } = await supabase.from('profiles').select('id, first_name, last_name').in('id', userIds);
  if (error) throw error;
  return new Map((data ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`]));
}

export interface ChatMessageDisplay {
  id: string;
  senderUserId: string;
  senderName: string;
  senderTeamName: string | null;
  messageText: string;
  createdAt: string;
  deletedAt: string | null;
  isOwn: boolean;
  canDelete: boolean;
  pending: boolean;
  failed: boolean;
  operationUuid: string | null;
}

export type ChatAvailability = 'not-started' | 'live' | 'completed';

interface UseTournamentChatOptions {
  tournamentId: string | undefined;
  isMember: boolean;
  isOrganizer: boolean;
  tournamentStatus: string | undefined;
  tournamentName: string;
  /** Whether the chat panel is currently open -- while it is, an incoming message is already visible live in the transcript, so it must not also bump the unread badge or fire a toast ("do not interrupt score entry" cuts both ways: no redundant interruption while the user is already looking at the chat). */
  isPanelOpen: boolean;
}

/**
 * Fetch + realtime merge-in-place + offline fallback (mirrors
 * useLeaderboardData.ts's shape) plus unread tracking and send/delete,
 * scoped to one tournament's shared chat channel.
 */
export function useTournamentChat({
  tournamentId,
  isMember,
  isOrganizer,
  tournamentStatus,
  tournamentName,
  isPanelOpen,
}: UseTournamentChatOptions) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Read via a ref (not a dependency) inside the realtime callback below --
  // toggling the panel open/closed must never tear down and recreate the
  // channel subscription itself.
  const isPanelOpenRef = useRef(isPanelOpen);
  isPanelOpenRef.current = isPanelOpen;

  const availability: ChatAvailability =
    tournamentStatus === 'live' ? 'live' : tournamentStatus === 'completed' ? 'completed' : 'not-started';
  const canRead = isMember || isOrganizer;
  const enabled = !!tournamentId && canRead && availability !== 'not-started';
  const canSend = enabled && availability === 'live';

  const [isOffline, setIsOffline] = useState(typeof navigator !== 'undefined' && !navigator.onLine);
  useEffect(() => {
    function handleOffline() {
      setIsOffline(true);
    }
    function handleOnline() {
      setIsOffline(false);
    }
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  const messagesQuery = useQuery({
    queryKey: ['chat-messages', tournamentId],
    queryFn: () => fetchMessages(tournamentId!),
    enabled,
  });

  const teamsQuery = useQuery({
    queryKey: ['chat-teams', tournamentId],
    queryFn: () => fetchTeams(tournamentId!),
    enabled,
  });

  const senderIds = useMemo(
    () => [...new Set((messagesQuery.data ?? []).map((m) => m.sender_user_id))].sort(),
    [messagesQuery.data],
  );
  const sendersQuery = useQuery({
    queryKey: ['chat-senders', tournamentId, senderIds.join(',')],
    queryFn: () => fetchSenderNames(senderIds),
    enabled: enabled && senderIds.length > 0,
  });

  useEffect(() => {
    if (tournamentId && messagesQuery.data) void cacheMessages(tournamentId, messagesQuery.data);
  }, [tournamentId, messagesQuery.data]);

  // --- Unread tracking -------------------------------------------------
  const [unreadCount, setUnreadCount] = useState(0);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const seededRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !tournamentId || seededRef.current === tournamentId) return;
    seededRef.current = tournamentId;
    void supabase
      .rpc('get_tournament_chat_summary', { p_tournament_id: tournamentId })
      .then(({ data, error }) => {
        if (error) return;
        const summary = data as TournamentChatSummary;
        setUnreadCount(summary.unread_count);
        setLastReadAt(summary.last_read_at);
      });
  }, [enabled, tournamentId]);

  // --- Realtime ----------------------------------------------------------
  useEffect(() => {
    if (!enabled || !tournamentId) return;
    if (channelRef.current) return; // guard against StrictMode double-invoke

    const channel = supabase
      .channel(`tournament-messages-${tournamentId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tournament_messages', filter: `tournament_id=eq.${tournamentId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as TournamentMessage | undefined;
          if (!row) return;

          queryClient.setQueryData<TournamentMessage[]>(['chat-messages', tournamentId], (old) => {
            if (!old) return old;
            const index = old.findIndex((m) => m.id === row.id);
            if (index === -1) return [...old, row].sort((a, b) => a.created_at.localeCompare(b.created_at));
            const next = [...old];
            next[index] = row;
            return next;
          });
          void cacheMessages(tournamentId, [row]);

          if (payload.eventType === 'INSERT' && row.sender_user_id !== user?.id && !isPanelOpenRef.current) {
            setUnreadCount((count) => count + 1);
            showToast({
              title: 'New tournament message',
              body: row.message_text,
              tone: 'chat',
              action: { label: 'Open', context: { tournamentId } },
            });
          }
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [enabled, tournamentId, queryClient, user?.id]);

  // --- Offline fallback ----------------------------------------------------
  const usingCache = enabled && (isOffline || messagesQuery.isError);
  // Not gated behind usingCache (see the matching fix/comment in
  // useTournamentAccess.ts): a query that only starts once the fallback is
  // needed is unresolved (indistinguishable from "empty") for the first
  // render or two, which would show "No messages yet" for a real cached
  // history right as the user goes offline. Running it from mount keeps it
  // warm.
  const cachedMessages = useLiveQuery(
    () => (tournamentId ? db.cachedMessages.where('tournamentId').equals(tournamentId).sortBy('createdAt') : []),
    [tournamentId],
  );
  const pendingMessages = useLiveQuery(
    () => (tournamentId ? db.pendingMessages.where('tournamentId').equals(tournamentId).sortBy('createdAt') : []),
    [tournamentId],
  );

  const confirmed: TournamentMessage[] =
    messagesQuery.data ??
    (cachedMessages ?? []).map((m) => ({
      id: m.id,
      operation_uuid: m.id,
      tournament_id: m.tournamentId,
      sender_user_id: m.senderUserId,
      sender_team_id: m.senderTeamId,
      message_text: m.messageText,
      created_at: m.createdAt,
      edited_at: null,
      deleted_at: m.deletedAt,
      deleted_by: null,
    }));

  const teamNameById = useMemo(() => new Map((teamsQuery.data ?? []).map((t) => [t.id, formatTeamName(t)])), [teamsQuery.data]);

  const displayMessages: ChatMessageDisplay[] = useMemo(() => {
    const senderNameById = sendersQuery.data ?? new Map<string, string>();
    const fromServer: ChatMessageDisplay[] = confirmed.map((m) => ({
      id: m.id,
      senderUserId: m.sender_user_id,
      senderName: senderNameById.get(m.sender_user_id) ?? 'Unknown player',
      senderTeamName: m.sender_team_id ? (teamNameById.get(m.sender_team_id) ?? null) : null,
      messageText: m.message_text,
      createdAt: m.created_at,
      deletedAt: m.deleted_at,
      isOwn: m.sender_user_id === user?.id,
      canDelete: m.deleted_at === null && (m.sender_user_id === user?.id || isOrganizer),
      pending: false,
      failed: false,
      operationUuid: m.operation_uuid,
    }));

    const fromQueue: ChatMessageDisplay[] = (pendingMessages ?? []).map((p) => ({
      id: p.operationUuid,
      senderUserId: user?.id ?? '',
      senderName: 'You',
      senderTeamName: null,
      messageText: p.messageText,
      createdAt: p.createdAt,
      deletedAt: null,
      isOwn: true,
      canDelete: false,
      pending: p.state !== 'failed',
      failed: p.state === 'failed',
      operationUuid: p.operationUuid,
    }));

    return [...fromServer, ...fromQueue].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [confirmed, pendingMessages, sendersQuery.data, teamNameById, user?.id, isOrganizer]);

  async function sendMessage(text: string): Promise<void> {
    if (!tournamentId) return;
    await queueMessage(tournamentId, text);
  }

  async function deleteMessage(messageId: string): Promise<void> {
    const { error } = await supabase.rpc('delete_tournament_message', { p_message_id: messageId });
    if (error) throw error;
  }

  async function markRead(): Promise<void> {
    if (!tournamentId || !canRead) return;
    setUnreadCount(0);
    const { data, error } = await supabase.rpc('mark_tournament_chat_read', { p_tournament_id: tournamentId });
    if (!error) setLastReadAt((data as { last_read_at: string }).last_read_at);
  }

  return {
    tournamentName,
    availability,
    canSend,
    canRead,
    messages: displayMessages,
    isLoading: messagesQuery.isLoading && !usingCache,
    usingCache,
    unreadCount,
    lastReadAt,
    sendMessage,
    deleteMessage,
    markRead,
    retrySend: flushMessageQueue,
  };
}
