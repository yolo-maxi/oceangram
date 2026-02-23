import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { TelegramService, TelegramEvent } from './telegram';
import { getPort, getAuthToken, writePid, removePid, loadConfig } from './config';
import { getLoginHtml } from './login-page';

export async function createServer(telegram: TelegramService) {
  const app = Fastify({ logger: true, bodyLimit: 52_428_800 }); // 50MB for file uploads
  const port = getPort();
  const authToken = getAuthToken();

  // Enable CORS for browser access
  await app.register(fastifyCors, {
    origin: true, // Allow all origins for POC
    credentials: true,
  });

  await app.register(fastifyWebsocket);

  // Auth middleware
  if (authToken) {
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      const path = request.url;
      if (path === '/health' || path === '/login' || path.startsWith('/login/')) return;

      const header = request.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
      if (token !== authToken) {
        reply.code(401).send({ error: 'Unauthorized' });
      }
    });
  }

  // Connection check middleware
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url;
    if (path === '/health' || path === '/login' || path.startsWith('/login/') || path === '/events') return;
    if (!telegram.isConnected()) {
      reply.code(503).send({ error: 'Telegram not connected', loginUrl: '/login' });
    }
  });

  // --- Health ---
  app.get('/health', async () => ({
    status: 'ok',
    connected: telegram.isConnected(),
    uptime: process.uptime(),
  }));

  // --- Login ---
  app.get('/login', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.type('text/html').send(getLoginHtml());
  });

  app.post<{ Body: { phone: string } }>('/login/phone', async (request) => {
    const { phone } = request.body;
    if (!phone) throw { statusCode: 400, message: 'phone required' };
    const result = await telegram.startLogin(phone);
    return { ok: true, phoneCodeHash: result.phoneCodeHash };
  });

  app.post<{ Body: { phone: string; code: string; phoneCodeHash: string } }>('/login/code', async (request) => {
    const { phone, code, phoneCodeHash } = request.body;
    if (!phone || !code || !phoneCodeHash) throw { statusCode: 400, message: 'phone, code, phoneCodeHash required' };
    try {
      await telegram.completeLogin(phone, code, phoneCodeHash);
      return { ok: true };
    } catch (err: unknown) {
      if (err instanceof Error && err.message === '2FA_REQUIRED') {
        return { ok: false, need2FA: true };
      }
      throw err;
    }
  });

  app.post<{ Body: { password: string } }>('/login/2fa', async (request) => {
    const { password } = request.body;
    if (!password) throw { statusCode: 400, message: 'password required' };
    await telegram.complete2FA(password);
    return { ok: true };
  });

  // --- Me ---
  app.get('/me', async () => {
    const me = await telegram.getMe();
    return {
      id: me.id?.toString(),
      firstName: me.firstName,
      lastName: me.lastName,
      username: me.username,
      phone: me.phone,
    };
  });

  // --- Dialogs ---
  app.get<{ Querystring: { limit?: string } }>('/dialogs', async (request) => {
    const limit = parseInt(request.query.limit || '100', 10);
    return telegram.getDialogs(Math.min(limit, 500));
  });

  app.get<{ Params: { dialogId: string } }>('/dialogs/:dialogId/info', async (request) => {
    return telegram.getDialogInfo(request.params.dialogId);
  });

  app.get<{ Params: { dialogId: string }; Querystring: { limit?: string; offsetId?: string } }>(
    '/dialogs/:dialogId/messages',
    async (request) => {
      const { dialogId } = request.params;
      const limit = parseInt(request.query.limit || '20', 10);
      const offsetId = request.query.offsetId ? parseInt(request.query.offsetId, 10) : undefined;
      return telegram.getMessages(dialogId, Math.min(limit, 100), offsetId);
    }
  );

  app.post<{ Params: { dialogId: string }; Body: { text: string; replyTo?: number; scheduleDate?: number } }>(
    '/dialogs/:dialogId/messages',
    async (request) => {
      const { dialogId } = request.params;
      const { text, replyTo, scheduleDate } = request.body;
      if (!text) throw { statusCode: 400, message: 'text required' };
      if (scheduleDate) {
        return telegram.sendMessageScheduled(dialogId, text, scheduleDate, replyTo);
      }
      return telegram.sendMessage(dialogId, text, replyTo);
    }
  );

  app.get<{ Params: { dialogId: string }; Querystring: { q: string; limit?: string } }>(
    '/dialogs/:dialogId/search',
    async (request) => {
      const { dialogId } = request.params;
      const { q, limit } = request.query;
      if (!q) throw { statusCode: 400, message: 'q required' };
      return telegram.searchMessages(dialogId, q, parseInt(limit || '20', 10));
    }
  );

  app.post<{ Params: { dialogId: string } }>('/dialogs/:dialogId/typing', async (request) => {
    await telegram.sendTyping(request.params.dialogId);
    return { ok: true };
  });

  // --- Messages ---
  app.post<{ Params: { messageId: string }; Body: { dialogId: string } }>(
    '/messages/:messageId/read',
    async (request) => {
      const { dialogId } = request.body;
      if (!dialogId) throw { statusCode: 400, message: 'dialogId required' };
      await telegram.markAsRead(dialogId, parseInt(request.params.messageId, 10));
      return { ok: true };
    }
  );

  app.post<{ Params: { messageId: string }; Body: { dialogId: string; emoji: string } }>(
    '/messages/:messageId/react',
    async (request) => {
      const { dialogId, emoji } = request.body;
      if (!dialogId || !emoji) throw { statusCode: 400, message: 'dialogId, emoji required' };
      await telegram.sendReaction(dialogId, parseInt(request.params.messageId, 10), emoji);
      return { ok: true };
    }
  );

  app.delete<{ Params: { messageId: string }; Body: { dialogId: string } }>(
    '/messages/:messageId',
    async (request) => {
      const { dialogId } = request.body;
      if (!dialogId) throw { statusCode: 400, message: 'dialogId required' };
      await telegram.deleteMessage(dialogId, parseInt(request.params.messageId, 10));
      return { ok: true };
    }
  );

  app.patch<{ Params: { messageId: string }; Body: { dialogId: string; text: string } }>(
    '/messages/:messageId',
    async (request) => {
      const { dialogId, text } = request.body;
      if (!dialogId || !text) throw { statusCode: 400, message: 'dialogId, text required' };
      await telegram.editMessage(dialogId, parseInt(request.params.messageId, 10), text);
      return { ok: true };
    }
  );

  // --- Forward Messages ---
  app.post<{ Params: { messageId: string }; Body: { fromDialogId: string; toDialogId: string; messageIds?: number[] } }>(
    '/messages/:messageId/forward',
    async (request) => {
      const { fromDialogId, toDialogId, messageIds } = request.body;
      if (!fromDialogId || !toDialogId) throw { statusCode: 400, message: 'fromDialogId, toDialogId required' };
      const ids = messageIds || [parseInt(request.params.messageId, 10)];
      const forwarded = await telegram.forwardMessages(fromDialogId, toDialogId, ids);
      return { ok: true, messages: forwarded };
    }
  );

  // --- Pin / Unpin ---
  app.post<{ Params: { messageId: string }; Body: { dialogId: string; silent?: boolean } }>(
    '/messages/:messageId/pin',
    async (request) => {
      const { dialogId, silent } = request.body;
      if (!dialogId) throw { statusCode: 400, message: 'dialogId required' };
      await telegram.pinMessage(dialogId, parseInt(request.params.messageId, 10), silent);
      return { ok: true };
    }
  );

  app.post<{ Params: { messageId: string }; Body: { dialogId: string } }>(
    '/messages/:messageId/unpin',
    async (request) => {
      const { dialogId } = request.body;
      if (!dialogId) throw { statusCode: 400, message: 'dialogId required' };
      await telegram.unpinMessage(dialogId, parseInt(request.params.messageId, 10));
      return { ok: true };
    }
  );

  // --- Archive / Unarchive ---
  app.post<{ Params: { dialogId: string } }>('/dialogs/:dialogId/archive', async (request) => {
    await telegram.archiveChat(request.params.dialogId);
    return { ok: true };
  });

  app.post<{ Params: { dialogId: string } }>('/dialogs/:dialogId/unarchive', async (request) => {
    await telegram.unarchiveChat(request.params.dialogId);
    return { ok: true };
  });

  // --- Mute ---
  app.post<{ Params: { dialogId: string }; Body: { duration?: number } }>(
    '/dialogs/:dialogId/mute',
    async (request) => {
      await telegram.muteChat(request.params.dialogId, request.body?.duration);
      return { ok: true };
    }
  );

  // --- Scheduled Messages ---
  app.get<{ Params: { dialogId: string } }>('/dialogs/:dialogId/scheduled', async (request) => {
    return telegram.getScheduledMessages(request.params.dialogId);
  });

  // --- Drafts ---
  app.get<{ Params: { dialogId: string } }>('/dialogs/:dialogId/draft', async (request) => {
    const draft = await telegram.getDraft(request.params.dialogId);
    return draft || { text: null };
  });

  app.put<{ Params: { dialogId: string }; Body: { text: string; replyTo?: number } }>(
    '/dialogs/:dialogId/draft',
    async (request) => {
      const { text, replyTo } = request.body;
      if (!text) throw { statusCode: 400, message: 'text required' };
      await telegram.saveDraft(request.params.dialogId, text, replyTo);
      return { ok: true };
    }
  );

  app.delete<{ Params: { dialogId: string } }>('/dialogs/:dialogId/draft', async (request) => {
    await telegram.clearDraft(request.params.dialogId);
    return { ok: true };
  });

  // --- Folders ---
  app.get('/folders', async () => {
    return telegram.getFolders();
  });

  app.post<{ Body: { title: string; includePeerIds?: string[]; excludePeerIds?: string[] } }>(
    '/folders',
    async (request) => {
      const { title, includePeerIds, excludePeerIds } = request.body;
      if (!title) throw { statusCode: 400, message: 'title required' };
      return telegram.createFolder(title, includePeerIds, excludePeerIds);
    }
  );

  app.put<{ Params: { folderId: string }; Body: { title: string; includePeerIds?: string[]; excludePeerIds?: string[] } }>(
    '/folders/:folderId',
    async (request) => {
      const { title, includePeerIds, excludePeerIds } = request.body;
      if (!title) throw { statusCode: 400, message: 'title required' };
      await telegram.updateFolder(parseInt(request.params.folderId, 10), title, includePeerIds, excludePeerIds);
      return { ok: true };
    }
  );

  app.delete<{ Params: { folderId: string } }>('/folders/:folderId', async (request) => {
    await telegram.deleteFolder(parseInt(request.params.folderId, 10));
    return { ok: true };
  });

  // --- Create Groups/Channels ---
  app.post<{ Body: { title: string; userIds: string[]; type: 'group' | 'supergroup' | 'channel' } }>(
    '/groups',
    async (request) => {
      const { title, userIds, type } = request.body;
      if (!title || !type) throw { statusCode: 400, message: 'title, type required' };
      return telegram.createGroup(title, userIds || [], type);
    }
  );

  // --- Bot Inline Queries ---
  app.post<{ Body: { botUsername: string; query: string; dialogId: string } }>(
    '/inline',
    async (request) => {
      const { botUsername, query, dialogId } = request.body;
      if (!botUsername || query === undefined || !dialogId) throw { statusCode: 400, message: 'botUsername, query, dialogId required' };
      return telegram.getInlineBotResults(botUsername, query, dialogId);
    }
  );

  app.post<{ Body: { botUsername: string; queryId: string; resultId: string; dialogId: string } }>(
    '/inline/send',
    async (request) => {
      const { botUsername, queryId, resultId, dialogId } = request.body;
      if (!queryId || !resultId || !dialogId) throw { statusCode: 400, message: 'queryId, resultId, dialogId required' };
      return telegram.sendInlineBotResult(botUsername, queryId, resultId, dialogId);
    }
  );

  // --- File Upload ---
  app.post<{ Params: { dialogId: string }; Body: { data: string; fileName: string; mimeType?: string; caption?: string } }>(
    '/dialogs/:dialogId/upload',
    async (request) => {
      const { dialogId } = request.params;
      const { data, fileName, mimeType, caption } = request.body;
      if (!data || !fileName) throw { statusCode: 400, message: 'data (base64) and fileName required' };
      const buffer = Buffer.from(data, 'base64');
      return telegram.sendFile(dialogId, buffer, fileName, mimeType, caption);
    }
  );

  // --- Voice Upload ---
  app.post<{ Params: { dialogId: string }; Body: { data: string; duration: number; waveform?: number[] } }>(
    '/dialogs/:dialogId/voice',
    async (request) => {
      const { dialogId } = request.params;
      const { data, duration, waveform } = request.body;
      if (!data) throw { statusCode: 400, message: 'data (base64) required' };
      const buffer = Buffer.from(data, 'base64');
      return telegram.sendVoice(dialogId, buffer, duration || 0, waveform);
    }
  );

  // --- Media ---
  app.get<{ Params: { messageId: string }; Querystring: { dialogId: string } }>(
    '/media/:messageId',
    async (request, reply) => {
      const { dialogId } = request.query;
      if (!dialogId) throw { statusCode: 400, message: 'dialogId query param required' };
      const result = await telegram.downloadMedia(parseInt(request.params.messageId, 10), dialogId);
      if (!result) { reply.code(404).send({ error: 'No media' }); return; }
      reply.type(result.mimeType).send(result.buffer);
    }
  );

  // --- Profile ---
  app.get<{ Params: { userId: string } }>('/profile/:userId', async (request) => {
    return telegram.getUserProfile(request.params.userId);
  });

  app.get<{ Params: { userId: string } }>('/profile/:userId/photo', async (request, reply) => {
    const result = await telegram.getProfilePhoto(request.params.userId);
    if (!result) { reply.code(404).send({ error: 'No photo' }); return; }
    reply.type(result.mimeType).send(result.buffer);
  });

  // --- Privacy Settings ---
  app.get('/settings/privacy', async () => {
    return telegram.getPrivacySettings();
  });

  app.put<{ Body: { key: string; value: string } }>('/settings/privacy', async (request) => {
    const { key, value } = request.body;
    const validKeys = ['lastSeen', 'phoneNumber', 'profilePhoto', 'forwards', 'calls', 'groups'] as const;
    const validValues = ['everybody', 'contacts', 'nobody'] as const;
    if (!key || !validKeys.includes(key as typeof validKeys[number])) {
      throw { statusCode: 400, message: 'key must be one of: lastSeen, phoneNumber, profilePhoto, forwards, calls, groups' };
    }
    if (!value || !validValues.includes(value as typeof validValues[number])) {
      throw { statusCode: 400, message: 'value must be one of: everybody, contacts, nobody' };
    }
    await telegram.setPrivacySetting(
      key as typeof validKeys[number],
      value as typeof validValues[number],
    );
    return { ok: true };
  });

  // --- Account Settings ---
  app.get('/settings/account', async () => {
    return telegram.getAccountSettings();
  });

  app.put<{ Body: { firstName?: string; lastName?: string; bio?: string } }>('/settings/account', async (request) => {
    const { firstName, lastName, bio } = request.body;
    await telegram.updateProfile({ firstName, lastName, bio });
    return { ok: true };
  });

  app.put<{ Body: { username: string } }>('/settings/username', async (request) => {
    const { username } = request.body;
    if (!username) throw { statusCode: 400, message: 'username required' };
    await telegram.updateUsername(username);
    return { ok: true };
  });

  app.put<{ Body: { data: string } }>('/settings/photo', async (request) => {
    const { data } = request.body;
    if (!data) throw { statusCode: 400, message: 'data (base64) required' };
    await telegram.uploadProfilePhoto(data);
    return { ok: true };
  });

  app.delete('/settings/photo', async () => {
    await telegram.deleteProfilePhoto();
    return { ok: true };
  });

  // --- Two-Step Verification (2FA) ---
  app.get('/settings/2fa', async () => {
    return telegram.get2FAStatus();
  });

  app.post<{ Body: { currentPassword?: string; newPassword: string; hint?: string; email?: string } }>(
    '/settings/2fa',
    async (request) => {
      const { currentPassword, newPassword, hint, email } = request.body;
      if (!newPassword) throw { statusCode: 400, message: 'newPassword required' };
      await telegram.set2FA({ currentPassword, newPassword, hint, email });
      return { ok: true };
    }
  );

  app.delete<{ Body: { password: string } }>('/settings/2fa', async (request) => {
    const { password } = request.body;
    if (!password) throw { statusCode: 400, message: 'password required' };
    await telegram.disable2FA(password);
    return { ok: true };
  });

  // --- Active Sessions ---
  app.get('/settings/sessions', async () => {
    return telegram.getSessions();
  });

  app.delete<{ Params: { hash: string } }>('/settings/sessions/:hash', async (request) => {
    await telegram.terminateSession(request.params.hash);
    return { ok: true };
  });

  app.delete('/settings/sessions', async () => {
    await telegram.terminateAllOtherSessions();
    return { ok: true };
  });

  // --- Blocked Users ---
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/settings/blocked', async (request) => {
    const limit = parseInt(request.query.limit || '20', 10);
    const offset = parseInt(request.query.offset || '0', 10);
    return telegram.getBlockedUsers(limit, offset);
  });

  app.post<{ Body: { userId: string } }>('/settings/blocked', async (request) => {
    const { userId } = request.body;
    if (!userId) throw { statusCode: 400, message: 'userId required' };
    await telegram.blockUser(userId);
    return { ok: true };
  });

  app.delete<{ Params: { userId: string } }>('/settings/blocked/:userId', async (request) => {
    await telegram.unblockUser(request.params.userId);
    return { ok: true };
  });

  // --- Notification Settings ---
  app.get('/settings/notifications', async () => {
    return telegram.getNotificationSettings();
  });

  app.put<{ Body: { scope: string; muteUntil?: number; sound?: string; showPreviews?: boolean } }>(
    '/settings/notifications',
    async (request) => {
      const { scope, muteUntil, sound, showPreviews } = request.body;
      const validScopes = ['private', 'group', 'channel'] as const;
      if (!scope || !validScopes.includes(scope as typeof validScopes[number])) {
        throw { statusCode: 400, message: 'scope must be one of: private, group, channel' };
      }
      await telegram.updateNotificationSettings(
        scope as typeof validScopes[number],
        { muteUntil, sound, showPreviews },
      );
      return { ok: true };
    }
  );

  // --- Auto-Download Settings ---
  app.get('/settings/autodownload', async () => {
    return telegram.getAutoDownloadSettings();
  });

  app.put<{ Body: { photos: boolean; videos: boolean; files: boolean; maxFileSize?: number } }>(
    '/settings/autodownload',
    async (request) => {
      const { photos, videos, files, maxFileSize } = request.body;
      if (photos === undefined || videos === undefined || files === undefined) {
        throw { statusCode: 400, message: 'photos, videos, files required (boolean)' };
      }
      await telegram.saveAutoDownloadSettings({ photos, videos, files, maxFileSize });
      return { ok: true };
    }
  );

  // --- Global Search ---
  app.get<{ Querystring: { q: string; limit?: string; offsetId?: string; offsetPeer?: string } }>(
    '/search',
    async (request) => {
      const { q, limit, offsetId, offsetPeer } = request.query;
      if (!q) throw { statusCode: 400, message: 'q required' };
      return telegram.searchGlobal(
        q,
        parseInt(limit || '20', 10),
        offsetId ? parseInt(offsetId, 10) : undefined,
        offsetPeer,
      );
    }
  );

  // --- Search Dialogs ---
  app.get<{ Querystring: { q: string; limit?: string } }>(
    '/search/dialogs',
    async (request) => {
      const { q, limit } = request.query;
      if (!q) throw { statusCode: 400, message: 'q required' };
      return telegram.searchDialogs(q, parseInt(limit || '20', 10));
    }
  );

  // --- Logout ---
  app.post('/logout', async () => {
    await telegram.logout();
    return { ok: true };
  });

  // --- Mark All as Read ---
  app.post<{ Params: { dialogId: string } }>('/dialogs/:dialogId/readAll', async (request) => {
    await telegram.markAllAsRead(request.params.dialogId);
    return { ok: true };
  });

  // --- Read History (mark as read) ---
  app.post<{ Params: { dialogId: string }; Body: { maxId?: number } }>(
    '/dialogs/:dialogId/read',
    async (request) => {
      const { dialogId } = request.params;
      const maxId = request.body?.maxId;
      await telegram.readHistory(dialogId, maxId);
      return { ok: true };
    }
  );

  // --- Get Single Message ---
  app.get<{ Params: { messageId: string }; Querystring: { dialogId: string } }>(
    '/messages/:messageId',
    async (request) => {
      const { dialogId } = request.query;
      if (!dialogId) throw { statusCode: 400, message: 'dialogId query param required' };
      const msg = await telegram.getMessageById(dialogId, parseInt(request.params.messageId, 10));
      if (!msg) throw { statusCode: 404, message: 'Message not found' };
      return msg;
    }
  );

  // --- Pinned Messages ---
  app.get<{ Params: { dialogId: string } }>('/dialogs/:dialogId/pinned', async (request) => {
    return telegram.getPinnedMessages(request.params.dialogId);
  });

  // --- Leave Chat ---
  app.post<{ Params: { dialogId: string } }>('/dialogs/:dialogId/leave', async (request) => {
    await telegram.leaveChat(request.params.dialogId);
    return { ok: true };
  });

  // --- Delete Chat History ---
  app.delete<{ Params: { dialogId: string } }>('/dialogs/:dialogId/history', async (request) => {
    await telegram.deleteChatHistory(request.params.dialogId);
    return { ok: true };
  });

  // --- Edit Group/Channel Info ---
  app.patch<{ Params: { dialogId: string }; Body: { title?: string; about?: string } }>(
    '/dialogs/:dialogId',
    async (request) => {
      const { title, about } = request.body;
      if (!title && about === undefined) throw { statusCode: 400, message: 'title or about required' };
      await telegram.editDialogInfo(request.params.dialogId, { title, about });
      return { ok: true };
    }
  );

  app.put<{ Params: { dialogId: string }; Body: { data: string } }>(
    '/dialogs/:dialogId/photo',
    async (request) => {
      const { data } = request.body;
      if (!data) throw { statusCode: 400, message: 'data (base64) required' };
      await telegram.editDialogPhoto(request.params.dialogId, data);
      return { ok: true };
    }
  );

  // --- Members ---
  app.get<{ Params: { dialogId: string }; Querystring: { limit?: string; offset?: string; filter?: string; q?: string } }>(
    '/dialogs/:dialogId/members',
    async (request) => {
      const { dialogId } = request.params;
      const { limit, offset, filter, q } = request.query;
      return telegram.getMembers(dialogId, {
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
        filter: filter as 'all' | 'admins' | 'kicked' | 'banned' | 'bots' | undefined,
        q,
      });
    }
  );

  app.post<{ Params: { dialogId: string }; Body: { userIds: string[] } }>(
    '/dialogs/:dialogId/members',
    async (request) => {
      const { userIds } = request.body;
      if (!userIds || !userIds.length) throw { statusCode: 400, message: 'userIds required' };
      await telegram.addMembers(request.params.dialogId, userIds);
      return { ok: true };
    }
  );

  app.delete<{ Params: { dialogId: string; userId: string }; Body: { ban?: boolean } }>(
    '/dialogs/:dialogId/members/:userId',
    async (request) => {
      await telegram.removeMember(request.params.dialogId, request.params.userId, request.body?.ban);
      return { ok: true };
    }
  );

  // --- Ban / Unban ---
  app.post<{ Params: { dialogId: string }; Body: { userId: string; deleteMessages?: boolean } }>(
    '/dialogs/:dialogId/ban',
    async (request) => {
      const { userId, deleteMessages } = request.body;
      if (!userId) throw { statusCode: 400, message: 'userId required' };
      await telegram.banMember(request.params.dialogId, userId, deleteMessages);
      return { ok: true };
    }
  );

  app.post<{ Params: { dialogId: string }; Body: { userId: string } }>(
    '/dialogs/:dialogId/unban',
    async (request) => {
      const { userId } = request.body;
      if (!userId) throw { statusCode: 400, message: 'userId required' };
      await telegram.unbanMember(request.params.dialogId, userId);
      return { ok: true };
    }
  );

  // --- Per-Member Permissions ---
  app.put<{ Params: { dialogId: string; userId: string }; Body: Record<string, unknown> }>(
    '/dialogs/:dialogId/members/:userId/permissions',
    async (request) => {
      const body = request.body as {
        sendMessages?: boolean;
        sendMedia?: boolean;
        sendStickers?: boolean;
        sendGifs?: boolean;
        sendGames?: boolean;
        sendInline?: boolean;
        embedLinks?: boolean;
        sendPolls?: boolean;
        changeInfo?: boolean;
        inviteUsers?: boolean;
        pinMessages?: boolean;
        manageTopics?: boolean;
        untilDate?: number;
      };
      await telegram.setMemberPermissions(request.params.dialogId, request.params.userId, body);
      return { ok: true };
    }
  );

  // --- Admin Management ---
  app.post<{ Params: { dialogId: string; userId: string }; Body: { rights: Record<string, boolean> } }>(
    '/dialogs/:dialogId/admins/:userId',
    async (request) => {
      const { rights } = request.body;
      if (!rights) throw { statusCode: 400, message: 'rights required' };
      await telegram.promoteAdmin(request.params.dialogId, request.params.userId, rights);
      return { ok: true };
    }
  );

  app.delete<{ Params: { dialogId: string; userId: string } }>(
    '/dialogs/:dialogId/admins/:userId',
    async (request) => {
      await telegram.demoteAdmin(request.params.dialogId, request.params.userId);
      return { ok: true };
    }
  );

  // --- Invite Links ---
  app.get<{ Params: { dialogId: string } }>(
    '/dialogs/:dialogId/invite',
    async (request) => {
      return telegram.getPrimaryInviteLink(request.params.dialogId);
    }
  );

  app.post<{ Params: { dialogId: string }; Body: { expireDate?: number; usageLimit?: number; requestNeeded?: boolean; title?: string } }>(
    '/dialogs/:dialogId/invite',
    async (request) => {
      return telegram.createInviteLink(request.params.dialogId, request.body || {});
    }
  );

  app.get<{ Params: { dialogId: string }; Querystring: { limit?: string; revoked?: string } }>(
    '/dialogs/:dialogId/invites',
    async (request) => {
      const { limit, revoked } = request.query;
      return telegram.getInviteLinks(request.params.dialogId, {
        limit: limit ? parseInt(limit, 10) : undefined,
        revoked: revoked === 'true',
      });
    }
  );

  app.delete<{ Params: { dialogId: string }; Body: { link: string } }>(
    '/dialogs/:dialogId/invites',
    async (request) => {
      const { link } = request.body;
      if (!link) throw { statusCode: 400, message: 'link required' };
      await telegram.revokeInviteLink(request.params.dialogId, link);
      return { ok: true };
    }
  );

  // --- Join ---
  app.post<{ Body: { link?: string; username?: string } }>(
    '/join',
    async (request) => {
      const { link, username } = request.body;
      if (!link && !username) throw { statusCode: 400, message: 'link or username required' };
      return telegram.joinChat({ link, username });
    }
  );

  // --- Permissions ---
  app.get<{ Params: { dialogId: string } }>(
    '/dialogs/:dialogId/permissions',
    async (request) => {
      return telegram.getDefaultPermissions(request.params.dialogId);
    }
  );

  app.put<{ Params: { dialogId: string }; Body: Record<string, boolean> }>(
    '/dialogs/:dialogId/permissions',
    async (request) => {
      await telegram.setDefaultPermissions(request.params.dialogId, request.body);
      return { ok: true };
    }
  );

  // --- Slow Mode ---
  app.put<{ Params: { dialogId: string }; Body: { seconds: number } }>(
    '/dialogs/:dialogId/slowmode',
    async (request) => {
      const { seconds } = request.body;
      if (seconds === undefined) throw { statusCode: 400, message: 'seconds required' };
      await telegram.setSlowMode(request.params.dialogId, seconds);
      return { ok: true };
    }
  );

  // --- Bot Callback ---
  app.post<{ Body: { messageId: number; dialogId: string; data: string } }>(
    '/bots/callback',
    async (request) => {
      const { messageId, dialogId, data } = request.body;
      if (!messageId || !dialogId || !data) throw { statusCode: 400, message: 'messageId, dialogId, data required' };
      return telegram.getBotCallbackAnswer(dialogId, messageId, data);
    }
  );

  // --- Contacts ---
  app.get<{ Querystring: { limit?: string } }>(
    '/contacts',
    async (request) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      return telegram.getContacts(limit);
    }
  );

  app.get<{ Querystring: { q: string; limit?: string } }>(
    '/contacts/search',
    async (request) => {
      const { q, limit } = request.query;
      if (!q) throw { statusCode: 400, message: 'q required' };
      return telegram.searchContacts(q, limit ? parseInt(limit, 10) : undefined);
    }
  );

  // --- Saved Messages ---
  app.get<{ Querystring: { limit?: string; offsetId?: string } }>(
    '/saved',
    async (request) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 20;
      const offsetId = request.query.offsetId ? parseInt(request.query.offsetId, 10) : undefined;
      return telegram.getSavedMessages(Math.min(limit, 100), offsetId);
    }
  );

  // --- Forum Topics CRUD ---
  app.get<{ Params: { dialogId: string }; Querystring: { limit?: string; offsetDate?: string; offsetId?: string } }>(
    '/dialogs/:dialogId/topics',
    async (request) => {
      const { dialogId } = request.params;
      const { limit, offsetDate, offsetId } = request.query;
      return telegram.listForumTopics(
        dialogId,
        parseInt(limit || '100', 10),
        offsetDate ? parseInt(offsetDate, 10) : undefined,
        offsetId ? parseInt(offsetId, 10) : undefined,
      );
    }
  );

  app.post<{ Params: { dialogId: string }; Body: { title: string; iconColor?: number; iconEmojiId?: string; sendAs?: string } }>(
    '/dialogs/:dialogId/topics',
    async (request) => {
      const { dialogId } = request.params;
      const { title, iconColor, iconEmojiId, sendAs } = request.body;
      if (!title) throw { statusCode: 400, message: 'title required' };
      return telegram.createForumTopic(dialogId, title, iconColor, iconEmojiId, sendAs);
    }
  );

  app.patch<{ Params: { dialogId: string; topicId: string }; Body: { title?: string; iconEmojiId?: string; closed?: boolean; hidden?: boolean } }>(
    '/dialogs/:dialogId/topics/:topicId',
    async (request) => {
      const { dialogId, topicId } = request.params;
      await telegram.editForumTopic(dialogId, parseInt(topicId, 10), request.body);
      return { ok: true };
    }
  );

  app.delete<{ Params: { dialogId: string; topicId: string } }>(
    '/dialogs/:dialogId/topics/:topicId',
    async (request) => {
      const { dialogId, topicId } = request.params;
      await telegram.deleteForumTopic(dialogId, parseInt(topicId, 10));
      return { ok: true };
    }
  );

  app.post<{ Params: { dialogId: string; topicId: string } }>(
    '/dialogs/:dialogId/topics/:topicId/pin',
    async (request) => {
      const { dialogId, topicId } = request.params;
      await telegram.pinForumTopic(dialogId, parseInt(topicId, 10), true);
      return { ok: true };
    }
  );

  app.post<{ Params: { dialogId: string; topicId: string } }>(
    '/dialogs/:dialogId/topics/:topicId/unpin',
    async (request) => {
      const { dialogId, topicId } = request.params;
      await telegram.pinForumTopic(dialogId, parseInt(topicId, 10), false);
      return { ok: true };
    }
  );

  // --- WebSocket Events ---
  app.register(async function (fastify) {
    fastify.get('/events', { websocket: true }, (socket) => {
      const unsubscribe = telegram.onEvent((event: TelegramEvent) => {
        try {
          socket.send(JSON.stringify(event));
        } catch { /* client disconnected */ }
      });

      socket.on('close', () => unsubscribe());
      socket.on('error', () => unsubscribe());
    });
  });

  // --- Error handler ---
  app.setErrorHandler((error: any, _request, reply) => {
    const statusCode = error.statusCode || 500;
    reply.code(statusCode).send({
      error: error.message || 'Internal Server Error',
      statusCode,
    });
  });

  // --- Start ---
  writePid();

  const shutdown = async () => {
    app.log.info('Shutting down...');
    removePid();
    await telegram.disconnect();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port, host: '127.0.0.1' });
  return app;
}
