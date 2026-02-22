/**
 * Chat picker QuickPick — reusable dialog selector.
 * Returns the selected DialogInfo or undefined if cancelled.
 */
import * as vscode from 'vscode';
import { TelegramApiClient } from './services/telegramApi';
import type { DialogInfo } from './services/telegram';

interface ChatPickItem extends vscode.QuickPickItem {
  dialog: DialogInfo;
}

/**
 * Show a QuickPick to select a Telegram chat.
 * Returns the chosen DialogInfo, or undefined if the user cancelled.
 */
export async function showChatPicker(api: TelegramApiClient): Promise<DialogInfo | undefined> {
  const qp = vscode.window.createQuickPick<ChatPickItem>();
  qp.placeholder = 'Select a chat to send to…';
  qp.matchOnDescription = true;
  qp.busy = true;
  qp.show();

  // Load dialogs
  try {
    const pinnedIds = new Set(api.getPinnedIds());
    const cached = api.getCachedDialogs();
    let dialogs: DialogInfo[] = cached && cached.length > 0 ? cached : await api.getDialogs(100);

    const items: ChatPickItem[] = [];

    // Pinned first
    const pinned = dialogs.filter(d => pinnedIds.has(d.id));
    const unpinned = dialogs.filter(d => !pinnedIds.has(d.id));

    for (const d of [...pinned, ...unpinned]) {
      const pin = pinnedIds.has(d.id) ? '$(pin) ' : '';
      const unread = d.unreadCount > 0 ? ` · ${d.unreadCount} unread` : '';
      items.push({
        label: `${pin}${d.name}`,
        description: `💬 ${d.lastMessage || ''}${unread}`,
        dialog: d,
      });
    }

    qp.items = items;
    qp.busy = false;
  } catch (err: any) {
    qp.dispose();
    vscode.window.showErrorMessage(`Failed to load chats: ${err.message}`);
    return undefined;
  }

  // Enable filtering via search
  qp.onDidChangeValue(async (value) => {
    if (value.length >= 2) {
      try {
        const results = api.searchDialogsFromCache(value);
        if (results.length > 0) {
          qp.items = results.map(d => ({
            label: d.name,
            description: `💬 ${d.lastMessage || ''}`,
            dialog: d,
          }));
        }
      } catch { /* keep existing items */ }
    }
  });

  return new Promise<DialogInfo | undefined>((resolve) => {
    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      qp.dispose();
      resolve(selected?.dialog);
    });

    qp.onDidHide(() => {
      qp.dispose();
      resolve(undefined);
    });
  });
}
