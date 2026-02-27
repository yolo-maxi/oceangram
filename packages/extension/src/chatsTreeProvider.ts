import * as vscode from 'vscode';
import { DialogInfo } from './services/telegram';
import { getTelegramApi } from './extension';
import { isChatMuted } from './commsPanel';

export class ChatsTreeProvider implements vscode.TreeDataProvider<DialogInfo> {
  private _onDidChangeTreeData: vscode.EventEmitter<DialogInfo | undefined | null | void> = new vscode.EventEmitter<DialogInfo | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<DialogInfo | undefined | null | void> = this._onDidChangeTreeData.event;

  private totalUnreadCount = 0;
  private view?: vscode.TreeView<DialogInfo>;
  private context: vscode.ExtensionContext;
  
  private static instance?: ChatsTreeProvider;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    ChatsTreeProvider.instance = this;
    this.watchForMessages();
  }

  static getInstance(): ChatsTreeProvider | undefined {
    return ChatsTreeProvider.instance;
  }

  setView(view: vscode.TreeView<DialogInfo>) {
    this.view = view;
    this.updateBadge();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DialogInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    
    const muted = isChatMuted(this.context, element.id);
    const mutePrefix = muted ? '🔇 ' : '';
    
    // Show unread count if > 0
    if (element.unreadCount > 0) {
      item.label = `${mutePrefix}${element.name} (${element.unreadCount})`;
      item.description = `${element.unreadCount} unread`;
    } else {
      item.label = `${mutePrefix}${element.name}`;
    }
    
    item.tooltip = element.lastMessage;
    item.command = {
      command: 'oceangram.openComms',
      title: 'Open Chat',
      arguments: [element.id]
    };

    return item;
  }

  async getChildren(element?: DialogInfo): Promise<DialogInfo[]> {
    if (element) {
      return [];
    }

    // Get recent chats from Telegram API
    const api = getTelegramApi();
    if (!api) {
      return [];
    }

    try {
      await api.connect();
      const dialogs = await api.getDialogs(20); // Get top 20 chats
      
      // Filter out any dialogs without unread count defined and only show chats with unreads or recently active
      const recentDialogs = dialogs.filter(dialog => 
        dialog.unreadCount > 0 || 
        (Date.now() - dialog.lastMessageTime) < 24 * 60 * 60 * 1000 // last 24 hours
      ).slice(0, 10); // Limit to 10 most relevant chats
      
      // Calculate total unread count from all dialogs (not just the filtered ones)
      this.totalUnreadCount = dialogs.reduce((total, dialog) => total + (dialog.unreadCount || 0), 0);
      this.updateBadge();
      
      return recentDialogs;
    } catch (error) {
      console.error('[ChatsTreeProvider] Error fetching chats:', error);
      return [];
    }
  }

  private updateBadge() {
    if (!this.view) return;

    if (this.totalUnreadCount > 0) {
      this.view.badge = {
        tooltip: `${this.totalUnreadCount} unread messages`,
        value: this.totalUnreadCount
      };
    } else {
      this.view.badge = undefined;
    }
  }

  private watchForMessages() {
    // Listen for new messages and refresh the tree + badge
    const api = getTelegramApi();
    if (!api) {
      // Retry in 2 seconds if API not ready yet
      setTimeout(() => this.watchForMessages(), 2000);
      return;
    }

    // Subscribe to dialog updates (when unread counts change)
    api.onDialogUpdate(() => {
      this.refresh(); // This will trigger getChildren() and update the badge
    });

    // Also listen for new messages on individual chats to update unread counts
    // Note: The onDialogUpdate should handle this, but adding this for completeness
    const updateUnreadCounts = () => {
      this.refresh();
    };

    // Set up a periodic refresh every 30 seconds to keep unread counts updated
    setInterval(updateUnreadCounts, 30000);
  }

  // Method to reset unread count when a chat is opened/focused
  resetUnreadForChat(chatId: string) {
    this.refresh(); // Refresh to get updated unread counts
  }
}