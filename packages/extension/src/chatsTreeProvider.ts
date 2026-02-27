import * as vscode from 'vscode';
import { DialogInfo } from './services/telegram';
import { getTelegramApi } from './extension';

export class ChatsTreeProvider implements vscode.TreeDataProvider<DialogInfo> {
  private _onDidChangeTreeData: vscode.EventEmitter<DialogInfo | undefined | null | void> = new vscode.EventEmitter<DialogInfo | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<DialogInfo | undefined | null | void> = this._onDidChangeTreeData.event;

  private totalUnreadCount = 0;
  private view?: vscode.TreeView<DialogInfo>;
  
  private static instance?: ChatsTreeProvider;

  constructor() {
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
    
    // Show unread count if > 0
    if (element.unreadCount > 0) {
      item.label = `${element.name} (${element.unreadCount})`;
      item.description = `${element.unreadCount} unread`;
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
      
      // Calculate total unread count
      this.totalUnreadCount = dialogs.reduce((total, dialog) => total + dialog.unreadCount, 0);
      this.updateBadge();
      
      return dialogs;
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
  }

  // Method to reset unread count when a chat is opened/focused
  resetUnreadForChat(chatId: string) {
    this.refresh(); // Refresh to get updated unread counts
  }
}