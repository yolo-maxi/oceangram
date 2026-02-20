import * as vscode from 'vscode';
import { TelegramService, DialogInfo } from './services/telegram';

interface QuickPickActionItem extends vscode.QuickPickItem {
  action?: () => void;
}

let sharedTelegram: TelegramService | undefined;
function getTelegram(): TelegramService {
  if (!sharedTelegram) sharedTelegram = new TelegramService();
  return sharedTelegram;
}

/** Set a shared TelegramService instance (called from extension.ts to reuse the singleton) */
export function setQuickPickTelegram(tg: TelegramService) {
  sharedTelegram = tg;
}

export async function showQuickPick(context: vscode.ExtensionContext) {
  const qp = vscode.window.createQuickPick<QuickPickActionItem>();
  qp.placeholder = 'Oceangram: search chats, panels, actions…';
  qp.matchOnDescription = true;

  const items: QuickPickActionItem[] = [];

  // --- Chats ---
  try {
    const tg = getTelegram();
    const pinnedIds = new Set(tg.getPinnedIds());
    const cached = tg.getCachedDialogs();
    const dialogs: DialogInfo[] = cached && cached.length > 0 ? cached : [];
    const dialogMap = new Map(dialogs.map(d => [d.id, d]));

    // Helper to create chat item
    const makeChatItem = (d: DialogInfo, showPin: boolean): QuickPickActionItem => {
      const pin = showPin && pinnedIds.has(d.id) ? '$(pin) ' : '';
      const unread = d.unreadCount > 0 ? ` · ${d.unreadCount} unread` : '';
      const desc = `💬 ${d.lastMessage || ''}${unread}`;
      return {
        label: `${pin}${d.name}`,
        description: desc,
        action: () => {
          vscode.commands.executeCommand('oceangram.openComms');
          // Small delay to let panel init, then open the chat
          setTimeout(() => {
            vscode.commands.executeCommand('oceangram.openChat', d.id);
          }, 300);
        },
      };
    };

    // Get pinned chats
    const pinnedChats = dialogs.filter(d => pinnedIds.has(d.id));
    if (pinnedChats.length > 0) {
      items.push({ label: 'Pinned', kind: vscode.QuickPickItemKind.Separator });
      for (const d of pinnedChats) {
        items.push(makeChatItem(d, true));
      }
    }

    // Get recently opened chats (excluding pinned)
    const recentEntries = tg.getRecentChats();
    const recentChats: DialogInfo[] = [];
    for (const entry of recentEntries) {
      if (pinnedIds.has(entry.id)) continue; // Skip pinned (already shown)
      const dialog = dialogMap.get(entry.id);
      if (dialog) recentChats.push(dialog);
    }

    if (recentChats.length > 0) {
      items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
      for (const d of recentChats.slice(0, 10)) {
        items.push(makeChatItem(d, false));
      }
    }
  } catch {
    // No telegram data available — skip chats section
  }

  // --- Panels ---
  items.push({ label: 'Panels', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: '$(comment-discussion) Open Comms',
    description: 'Telegram chat panel',
    action: () => vscode.commands.executeCommand('oceangram.openComms'),
  });
  items.push({
    label: '$(checklist) Open Kanban',
    description: 'Project kanban board',
    action: () => vscode.commands.executeCommand('oceangram.openKanban'),
  });
  items.push({
    label: '$(pulse) Open Agent Status',
    description: 'AI agent monitoring',
    action: () => vscode.commands.executeCommand('oceangram.openAgent'),
  });
  items.push({
    label: '$(database) Open Resources',
    description: 'Project resources',
    action: () => vscode.commands.executeCommand('oceangram.openResources'),
  });

  // --- Actions ---
  items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: '$(key) Login to Telegram',
    description: 'Login or switch Telegram account',
    action: () => vscode.commands.executeCommand('oceangram.telegramLogin'),
  });
  items.push({
    label: '$(refresh) Refresh',
    description: 'Refresh current panel',
    action: () => vscode.commands.executeCommand('oceangram.openComms'),
  });
  items.push({
    label: '$(pin) Pin/Unpin Current Chat',
    description: 'Toggle pin on the active chat',
    action: () => vscode.commands.executeCommand('oceangram.togglePin'),
  });

  qp.items = items;

  qp.onDidAccept(() => {
    const selected = qp.selectedItems[0];
    if (selected?.action) {
      selected.action();
    }
    qp.dispose();
  });

  qp.onDidHide(() => qp.dispose());
  qp.show();
}
