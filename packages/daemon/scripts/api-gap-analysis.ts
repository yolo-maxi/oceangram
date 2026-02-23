#!/usr/bin/env npx tsx
/**
 * Oceangram Daemon — API Gap Analysis
 * 
 * Compares our daemon endpoints against Telegram's full API surface.
 * Reference: https://core.telegram.org/methods
 * 
 * Run: npx tsx scripts/api-gap-analysis.ts
 */

import fs from 'fs';
import path from 'path';

// ── Our daemon's current endpoints (parsed from server.ts) ──

function parseServerRoutes(): { method: string; path: string }[] {
  const serverPath = path.join(__dirname, '..', 'src', 'server.ts');
  const content = fs.readFileSync(serverPath, 'utf-8');
  const routes: { method: string; path: string }[] = [];
  
  const regex = /app\.(get|post|put|patch|delete).*?'(\/[^']+)'/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    routes.push({ method: match[1].toUpperCase(), path: match[2] });
  }
  
  // Also catch multiline route definitions
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const methodMatch = line.match(/app\.(get|post|put|patch|delete)/);
    if (methodMatch && !line.includes("'")) {
      // Path might be on next line
      const nextLine = lines[i + 1] || '';
      const pathMatch = nextLine.match(/'(\/[^']+)'/);
      if (pathMatch) {
        routes.push({ method: methodMatch[1].toUpperCase(), path: pathMatch[1] });
      }
    }
  }
  
  // Dedupe
  const seen = new Set<string>();
  return routes.filter(r => {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseTelegramMethods(): string[] {
  const telegramPath = path.join(__dirname, '..', 'src', 'telegram.ts');
  const content = fs.readFileSync(telegramPath, 'utf-8');
  const methods: string[] = [];
  
  const regex = /async\s+(\w+)\s*\(/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    methods.push(match[1]);
  }
  return methods;
}

// ── Telegram's full API surface (categorized) ──
// Based on https://core.telegram.org/methods + Telegram Desktop features

interface Feature {
  name: string;
  description: string;
  telegramApi: string; // Primary MTProto method
  priority: 'P0' | 'P1' | 'P2' | 'P3'; // P0=critical, P3=niche
  status: 'done' | 'partial' | 'missing';
}

interface Category {
  name: string;
  features: Feature[];
}

const TELEGRAM_FEATURES: Category[] = [
  {
    name: '🔐 Authentication',
    features: [
      { name: 'QR code login', telegramApi: 'auth.exportLoginToken', priority: 'P0', status: 'done', description: 'Login via QR code scan' },
      { name: 'Phone number login', telegramApi: 'auth.sendCode', priority: 'P0', status: 'done', description: 'Login via phone + SMS code' },
      { name: '2FA password', telegramApi: 'auth.checkPassword', priority: 'P0', status: 'done', description: 'Two-factor authentication' },
      { name: 'Logout', telegramApi: 'auth.logOut', priority: 'P1', status: 'done', description: 'End current session' },
      { name: 'Session management', telegramApi: 'account.getAuthorizations', priority: 'P1', status: 'done', description: 'View/terminate sessions' },
    ],
  },
  {
    name: '👤 Account & Profile',
    features: [
      { name: 'Get current user', telegramApi: 'users.getFullUser', priority: 'P0', status: 'done', description: 'Get own profile info' },
      { name: 'Update profile', telegramApi: 'account.updateProfile', priority: 'P1', status: 'done', description: 'Change name, bio' },
      { name: 'Update username', telegramApi: 'account.updateUsername', priority: 'P1', status: 'done', description: 'Change @username' },
      { name: 'Update profile photo', telegramApi: 'photos.uploadProfilePhoto', priority: 'P1', status: 'done', description: 'Change avatar' },
      { name: 'Delete profile photo', telegramApi: 'photos.deletePhotos', priority: 'P2', status: 'done', description: 'Remove avatar' },
      { name: 'Get user profile', telegramApi: 'users.getFullUser', priority: 'P0', status: 'done', description: 'View other user profile' },
      { name: 'Get profile photo', telegramApi: 'photos.getUserPhotos', priority: 'P0', status: 'done', description: 'Download avatar' },
    ],
  },
  {
    name: '🔒 Privacy & Security',
    features: [
      { name: 'Privacy settings (get/set)', telegramApi: 'account.getPrivacy', priority: 'P1', status: 'done', description: 'Last seen, phone, photo, forwards, calls, groups' },
      { name: '2FA management', telegramApi: 'account.getPassword', priority: 'P1', status: 'done', description: 'Enable/disable/change 2FA' },
      { name: 'Blocked users', telegramApi: 'contacts.getBlocked', priority: 'P1', status: 'done', description: 'List/block/unblock users' },
      { name: 'Active sessions', telegramApi: 'account.getAuthorizations', priority: 'P1', status: 'done', description: 'View and terminate sessions' },
    ],
  },
  {
    name: '💬 Dialogs / Chat List',
    features: [
      { name: 'List dialogs', telegramApi: 'messages.getDialogs', priority: 'P0', status: 'done', description: 'Get chat list' },
      { name: 'Get dialog info', telegramApi: 'messages.getPeerDialogs', priority: 'P0', status: 'done', description: 'Get single chat details' },
      { name: 'Archive chat', telegramApi: 'folders.editPeerFolders', priority: 'P1', status: 'done', description: 'Move to archive' },
      { name: 'Unarchive chat', telegramApi: 'folders.editPeerFolders', priority: 'P1', status: 'done', description: 'Remove from archive' },
      { name: 'Mute chat', telegramApi: 'account.updateNotifySettings', priority: 'P1', status: 'done', description: 'Mute notifications' },
      { name: 'Delete chat history', telegramApi: 'messages.deleteHistory', priority: 'P1', status: 'done', description: 'Clear chat history' },
      { name: 'Leave chat', telegramApi: 'messages.deleteChatUser / channels.leaveChannel', priority: 'P1', status: 'done', description: 'Leave group/channel' },
      { name: 'Mark all as read', telegramApi: 'messages.readHistory', priority: 'P1', status: 'done', description: 'Mark entire chat as read' },
      { name: 'Global search', telegramApi: 'messages.searchGlobal', priority: 'P0', status: 'done', description: 'Search across all chats' },
      { name: 'Search dialogs by name', telegramApi: 'contacts.search', priority: 'P1', status: 'done', description: 'Find chats/users by name' },
    ],
  },
  {
    name: '📨 Messages',
    features: [
      { name: 'Get messages', telegramApi: 'messages.getHistory', priority: 'P0', status: 'done', description: 'Fetch message history' },
      { name: 'Send message', telegramApi: 'messages.sendMessage', priority: 'P0', status: 'done', description: 'Send text message' },
      { name: 'Edit message', telegramApi: 'messages.editMessage', priority: 'P0', status: 'done', description: 'Edit sent message' },
      { name: 'Delete message', telegramApi: 'messages.deleteMessages', priority: 'P0', status: 'done', description: 'Delete messages' },
      { name: 'Forward message', telegramApi: 'messages.forwardMessages', priority: 'P0', status: 'done', description: 'Forward to another chat' },
      { name: 'Pin message', telegramApi: 'messages.updatePinnedMessage', priority: 'P1', status: 'done', description: 'Pin in chat' },
      { name: 'Unpin message', telegramApi: 'messages.updatePinnedMessage', priority: 'P1', status: 'done', description: 'Unpin from chat' },
      { name: 'Send reaction', telegramApi: 'messages.sendReaction', priority: 'P1', status: 'done', description: 'React with emoji' },
      { name: 'Mark as read', telegramApi: 'messages.readHistory', priority: 'P0', status: 'done', description: 'Read receipts' },
      { name: 'Send typing', telegramApi: 'messages.setTyping', priority: 'P1', status: 'done', description: 'Typing indicator' },
      { name: 'Search in chat', telegramApi: 'messages.search', priority: 'P0', status: 'done', description: 'Search messages in a chat' },
      { name: 'Scheduled messages', telegramApi: 'messages.getScheduledHistory', priority: 'P2', status: 'done', description: 'View/send scheduled' },
      { name: 'Get single message by ID', telegramApi: 'messages.getMessages', priority: 'P1', status: 'done', description: 'Fetch specific message(s) by ID' },
      { name: 'Get pinned messages', telegramApi: 'messages.search (filter=pinned)', priority: 'P1', status: 'done', description: 'List all pinned messages in chat' },
      { name: 'Report message/spam', telegramApi: 'messages.report', priority: 'P3', status: 'missing', description: 'Report content' },
      { name: 'Translate message', telegramApi: 'messages.translateText', priority: 'P2', status: 'missing', description: 'Translate message text' },
    ],
  },
  {
    name: '📎 Media & Files',
    features: [
      { name: 'Upload file', telegramApi: 'messages.sendMedia', priority: 'P0', status: 'done', description: 'Send photos/docs/files' },
      { name: 'Send voice', telegramApi: 'messages.sendMedia', priority: 'P1', status: 'done', description: 'Send voice message' },
      { name: 'Download media', telegramApi: 'upload.getFile', priority: 'P0', status: 'done', description: 'Download attachments' },
      { name: 'Send sticker', telegramApi: 'messages.sendMedia', priority: 'P2', status: 'missing', description: 'Send sticker' },
      { name: 'Search stickers', telegramApi: 'messages.getStickers', priority: 'P2', status: 'missing', description: 'Search sticker packs' },
      { name: 'Search GIFs', telegramApi: 'messages.getInlineBotResults (@gif)', priority: 'P2', status: 'missing', description: 'Search and send GIFs' },
      { name: 'Send video note (round)', telegramApi: 'messages.sendMedia', priority: 'P2', status: 'missing', description: 'Send round video' },
      { name: 'Send location', telegramApi: 'messages.sendMedia', priority: 'P2', status: 'missing', description: 'Share location' },
      { name: 'Send contact', telegramApi: 'messages.sendMedia', priority: 'P3', status: 'missing', description: 'Share contact card' },
    ],
  },
  {
    name: '✏️ Drafts',
    features: [
      { name: 'Get draft', telegramApi: 'messages.getPeerDialogs', priority: 'P2', status: 'done', description: 'Get saved draft' },
      { name: 'Save draft', telegramApi: 'messages.saveDraft', priority: 'P2', status: 'done', description: 'Save draft message' },
      { name: 'Clear draft', telegramApi: 'messages.saveDraft (empty)', priority: 'P2', status: 'done', description: 'Delete draft' },
    ],
  },
  {
    name: '📁 Folders',
    features: [
      { name: 'List folders', telegramApi: 'messages.getDialogFilters', priority: 'P1', status: 'done', description: 'Get custom folders' },
      { name: 'Create folder', telegramApi: 'messages.updateDialogFilter', priority: 'P1', status: 'done', description: 'Create custom folder' },
      { name: 'Edit folder', telegramApi: 'messages.updateDialogFilter', priority: 'P1', status: 'done', description: 'Modify folder' },
      { name: 'Delete folder', telegramApi: 'messages.updateDialogFilter', priority: 'P1', status: 'done', description: 'Remove folder' },
      { name: 'Reorder folders', telegramApi: 'messages.updateDialogFiltersOrder', priority: 'P2', status: 'missing', description: 'Change folder order' },
    ],
  },
  {
    name: '👥 Groups & Channels',
    features: [
      { name: 'Create group', telegramApi: 'messages.createChat', priority: 'P1', status: 'done', description: 'Create basic group' },
      { name: 'Create supergroup', telegramApi: 'channels.createChannel', priority: 'P1', status: 'done', description: 'Create supergroup' },
      { name: 'Create channel', telegramApi: 'channels.createChannel', priority: 'P1', status: 'done', description: 'Create broadcast channel' },
      { name: 'Edit group/channel info', telegramApi: 'channels.editTitle / editPhoto / editAbout', priority: 'P1', status: 'done', description: 'Change title, description, photo' },
      { name: 'Get members list', telegramApi: 'channels.getParticipants', priority: 'P1', status: 'done', description: 'List group/channel members' },
      { name: 'Add members', telegramApi: 'channels.inviteToChannel', priority: 'P1', status: 'done', description: 'Add users to group' },
      { name: 'Remove member / kick', telegramApi: 'channels.editBanned', priority: 'P1', status: 'done', description: 'Kick user from group' },
      { name: 'Ban user', telegramApi: 'channels.editBanned', priority: 'P2', status: 'done', description: 'Ban user permanently' },
      { name: 'Promote to admin', telegramApi: 'channels.editAdmin', priority: 'P1', status: 'done', description: 'Set admin rights' },
      { name: 'Demote admin', telegramApi: 'channels.editAdmin', priority: 'P1', status: 'done', description: 'Remove admin rights' },
      { name: 'Get admin list', telegramApi: 'channels.getParticipants (filter=admins)', priority: 'P1', status: 'done', description: 'List admins' },
      { name: 'Create invite link', telegramApi: 'messages.exportChatInvite', priority: 'P1', status: 'done', description: 'Generate invite link' },
      { name: 'Revoke invite link', telegramApi: 'messages.editExportedChatInvite', priority: 'P2', status: 'done', description: 'Revoke invite' },
      { name: 'List invite links', telegramApi: 'messages.getExportedChatInvites', priority: 'P2', status: 'done', description: 'Get all invite links' },
      { name: 'Join chat by link/username', telegramApi: 'messages.importChatInvite / channels.joinChannel', priority: 'P1', status: 'done', description: 'Join via invite link' },
      { name: 'Leave chat', telegramApi: 'channels.leaveChannel', priority: 'P1', status: 'done', description: 'Leave group/channel' },
      { name: 'Set slow mode', telegramApi: 'channels.toggleSlowMode', priority: 'P2', status: 'done', description: 'Set posting cooldown' },
      { name: 'Channel stats', telegramApi: 'stats.getBroadcastStats', priority: 'P3', status: 'missing', description: 'Channel analytics' },
      { name: 'Set default permissions', telegramApi: 'messages.editChatDefaultBannedRights', priority: 'P2', status: 'done', description: 'Group base permissions' },
    ],
  },
  {
    name: '💬 Forum Topics',
    features: [
      { name: 'List topics', telegramApi: 'channels.getForumTopics', priority: 'P0', status: 'done', description: 'Get forum topics with full CRUD endpoint' },
      { name: 'Create topic', telegramApi: 'channels.createForumTopic', priority: 'P1', status: 'done', description: 'Create new topic in forum' },
      { name: 'Edit topic', telegramApi: 'channels.editForumTopic', priority: 'P1', status: 'done', description: 'Rename, change icon' },
      { name: 'Close/reopen topic', telegramApi: 'channels.editForumTopic', priority: 'P1', status: 'done', description: 'Toggle topic open/closed' },
      { name: 'Delete topic', telegramApi: 'channels.deleteTopicHistory', priority: 'P2', status: 'done', description: 'Delete topic and messages' },
      { name: 'Pin topic', telegramApi: 'channels.updatePinnedForumTopic', priority: 'P2', status: 'done', description: 'Pin topic to top' },
    ],
  },
  {
    name: '📖 Stories',
    features: [
      { name: 'Get stories', telegramApi: 'stories.getPeerStories', priority: 'P2', status: 'missing', description: 'View user stories' },
      { name: 'Post story', telegramApi: 'stories.sendStory', priority: 'P2', status: 'missing', description: 'Create new story' },
      { name: 'Delete story', telegramApi: 'stories.deleteStories', priority: 'P2', status: 'missing', description: 'Remove story' },
      { name: 'React to story', telegramApi: 'stories.sendReaction', priority: 'P3', status: 'missing', description: 'React to story' },
      { name: 'View story viewers', telegramApi: 'stories.getStoryViewsList', priority: 'P3', status: 'missing', description: 'See who viewed' },
      { name: 'Story privacy', telegramApi: 'stories.sendStory (privacy)', priority: 'P3', status: 'missing', description: 'Set story visibility' },
    ],
  },
  {
    name: '⭐ Stars & Payments',
    features: [
      { name: 'Stars balance', telegramApi: 'payments.getStarsStatus', priority: 'P2', status: 'missing', description: 'Check stars balance' },
      { name: 'Stars transactions', telegramApi: 'payments.getStarsTransactions', priority: 'P2', status: 'missing', description: 'Transaction history' },
      { name: 'Send stars', telegramApi: 'payments.sendStarsForm', priority: 'P2', status: 'missing', description: 'Send stars to user' },
      { name: 'Bot payments', telegramApi: 'payments.getPaymentForm', priority: 'P3', status: 'missing', description: 'Bot payment invoices' },
    ],
  },
  {
    name: '🤖 Bots',
    features: [
      { name: 'Inline query', telegramApi: 'messages.getInlineBotResults', priority: 'P1', status: 'done', description: 'Query inline bots' },
      { name: 'Send inline result', telegramApi: 'messages.sendInlineBotResult', priority: 'P1', status: 'done', description: 'Send inline bot result' },
      { name: 'Bot commands menu', telegramApi: 'bots.getBotCommands', priority: 'P2', status: 'missing', description: 'Get bot command list' },
      { name: 'Callback button press', telegramApi: 'messages.getBotCallbackAnswer', priority: 'P1', status: 'done', description: 'Press inline keyboard button' },
      { name: 'Bot web app', telegramApi: 'messages.requestWebView', priority: 'P2', status: 'missing', description: 'Open bot mini app' },
    ],
  },
  {
    name: '🔔 Notifications',
    features: [
      { name: 'Global notification settings', telegramApi: 'account.getNotifySettings', priority: 'P1', status: 'done', description: 'Get/set global notifications' },
      { name: 'Per-chat notifications', telegramApi: 'account.updateNotifySettings', priority: 'P1', status: 'done', description: 'Mute specific chats' },
      { name: 'Auto-download settings', telegramApi: 'account.getAutoDownloadSettings', priority: 'P2', status: 'done', description: 'Media auto-download prefs' },
    ],
  },
  {
    name: '📡 Real-time Events',
    features: [
      { name: 'New message events', telegramApi: 'updates.getState', priority: 'P0', status: 'done', description: 'Real-time new messages' },
      { name: 'Edit message events', telegramApi: 'updates', priority: 'P0', status: 'done', description: 'Real-time edits' },
      { name: 'Delete message events', telegramApi: 'updates', priority: 'P0', status: 'done', description: 'Real-time deletions' },
      { name: 'Typing events', telegramApi: 'updates', priority: 'P1', status: 'done', description: 'User typing notifications via WS' },
      { name: 'Online status events', telegramApi: 'updates', priority: 'P2', status: 'missing', description: 'User online/offline via WS' },
      { name: 'Read receipt events', telegramApi: 'updates', priority: 'P1', status: 'done', description: 'Message read events via WS' },
    ],
  },
  {
    name: '📇 Contacts',
    features: [
      { name: 'Get contacts', telegramApi: 'contacts.getContacts', priority: 'P1', status: 'done', description: 'Full contact list' },
      { name: 'Search contacts', telegramApi: 'contacts.search', priority: 'P1', status: 'done', description: 'Search by name/username' },
      { name: 'Add contact', telegramApi: 'contacts.addContact', priority: 'P2', status: 'missing', description: 'Add to contacts' },
      { name: 'Delete contact', telegramApi: 'contacts.deleteContacts', priority: 'P2', status: 'missing', description: 'Remove from contacts' },
    ],
  },
  {
    name: '🌐 Misc',
    features: [
      { name: 'Saved messages', telegramApi: 'messages.getHistory (savedPeer)', priority: 'P1', status: 'done', description: 'Access Saved Messages chat' },
      { name: 'Translate text', telegramApi: 'messages.translateText', priority: 'P2', status: 'missing', description: 'Translate message' },
      { name: 'Get app config', telegramApi: 'help.getConfig', priority: 'P3', status: 'missing', description: 'Telegram server config' },
      { name: 'Check username availability', telegramApi: 'account.checkUsername', priority: 'P2', status: 'missing', description: 'Check if username is taken' },
    ],
  },
];

// ── Analysis ──

function analyze() {
  const routes = parseServerRoutes();
  const methods = parseTelegramMethods();
  
  let totalFeatures = 0;
  let doneFeatures = 0;
  let partialFeatures = 0;
  let missingFeatures = 0;
  
  const byPriority: Record<string, { total: number; done: number; missing: number }> = {
    P0: { total: 0, done: 0, missing: 0 },
    P1: { total: 0, done: 0, missing: 0 },
    P2: { total: 0, done: 0, missing: 0 },
    P3: { total: 0, done: 0, missing: 0 },
  };
  
  console.log('═══════════════════════════════════════════════════════');
  console.log('  OCEANGRAM DAEMON — API GAP ANALYSIS');
  console.log('═══════════════════════════════════════════════════════\n');
  
  console.log(`📡 Server routes: ${routes.length}`);
  console.log(`🔧 Telegram service methods: ${methods.length}\n`);
  
  for (const category of TELEGRAM_FEATURES) {
    const catDone = category.features.filter(f => f.status === 'done').length;
    const catTotal = category.features.length;
    const pct = Math.round((catDone / catTotal) * 100);
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
    
    console.log(`\n${category.name} [${bar}] ${pct}% (${catDone}/${catTotal})`);
    
    for (const feature of category.features) {
      totalFeatures++;
      byPriority[feature.priority].total++;
      
      const icon = feature.status === 'done' ? '✅' : feature.status === 'partial' ? '🟡' : '❌';
      
      if (feature.status === 'done') {
        doneFeatures++;
        byPriority[feature.priority].done++;
      } else if (feature.status === 'partial') {
        partialFeatures++;
      } else {
        missingFeatures++;
        byPriority[feature.priority].missing++;
      }
      
      // Only show missing/partial features in detail
      if (feature.status !== 'done') {
        console.log(`  ${icon} [${feature.priority}] ${feature.name} — ${feature.description}`);
        console.log(`       API: ${feature.telegramApi}`);
      }
    }
  }
  
  // Summary
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════\n');
  
  const overallPct = Math.round((doneFeatures / totalFeatures) * 100);
  console.log(`Total features: ${totalFeatures}`);
  console.log(`  ✅ Done:    ${doneFeatures} (${overallPct}%)`);
  console.log(`  🟡 Partial: ${partialFeatures}`);
  console.log(`  ❌ Missing: ${missingFeatures}`);
  
  console.log('\nBy priority:');
  for (const [p, stats] of Object.entries(byPriority)) {
    const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
    console.log(`  ${p}: ${stats.done}/${stats.total} (${pct}%) — ${stats.missing} missing`);
  }
  
  // Critical missing (P0 + P1)
  const criticalMissing = TELEGRAM_FEATURES
    .flatMap(c => c.features)
    .filter(f => f.status === 'missing' && (f.priority === 'P0' || f.priority === 'P1'));
  
  if (criticalMissing.length > 0) {
    console.log(`\n🚨 CRITICAL GAPS (P0+P1 missing): ${criticalMissing.length}`);
    for (const f of criticalMissing) {
      console.log(`  [${f.priority}] ${f.name} — ${f.telegramApi}`);
    }
  }
}

analyze();
