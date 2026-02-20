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

    // pinned first, then by lastMessageTime
    const sorted = [...dialogs].sort((a, b) => {
      const ap = pinnedIds.has(a.id) ? 1 : 0;
      const bp = pinnedIds.has(b.id) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return (b.lastMessageTime || 0) - (a.lastMessageTime || 0);
    });

    const chatItems = sorted.slice(0, 20);
    if (chatItems.length > 0) {
      items.push({ label: 'Chats', kind: vscode.QuickPickItemKind.Separator });
      for (const d of chatItems) {
        const pin = pinnedIds.has(d.id) ? '$(pin) ' : '';
        const unread = d.unreadCount > 0 ? ` · ${d.unreadCount} unread` : '';
        const desc = `💬 ${d.lastMessage || ''}${unread}`;
        items.push({
          label: `${pin}${d.name}`,
          description: desc,
          action: () => {
            vscode.commands.executeCommand('oceangram.openComms');
            // Small delay to let panel init, then open the chat
            setTimeout(() => {
              vscode.commands.executeCommand('oceangram.openChat', d.id);
            }, 300);
          },
        });
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
