/**
 * Remote filesystem utility.
 * 
 * When the extension runs with extensionKind: ["ui"], Node.js fs reads local files.
 * Server files must be accessed through vscode.workspace.fs which tunnels through
 * the Remote SSH connection.
 * 
 * This module provides helpers to read/write/stat/watch remote files.
 */
import * as vscode from 'vscode';

/**
 * Build a vscode.Uri for an absolute path on the remote server.
 * Uses the workspace folder's scheme and authority so that
 * vscode.workspace.fs routes through the SSH tunnel.
 */
export function getRemoteUri(absolutePath: string): vscode.Uri {
  const wf = vscode.workspace.workspaceFolders?.[0];
  if (wf && wf.uri.scheme !== 'file') {
    // Remote workspace — reuse scheme + authority
    return wf.uri.with({ path: absolutePath });
  }
  // Local / no workspace — plain file URI
  return vscode.Uri.file(absolutePath);
}

/**
 * Read a UTF-8 text file from the remote server.
 */
export async function readRemoteFile(absolutePath: string): Promise<string> {
  const uri = getRemoteUri(absolutePath);
  const data = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(data).toString('utf-8');
}

/**
 * Write a UTF-8 text file on the remote server.
 */
export async function writeRemoteFile(absolutePath: string, content: string): Promise<void> {
  const uri = getRemoteUri(absolutePath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

/**
 * Check if a file exists on the remote server.
 */
export async function remoteFileExists(absolutePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(getRemoteUri(absolutePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Stat a remote file. Returns undefined if not found.
 */
export async function remoteFileStat(absolutePath: string): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(getRemoteUri(absolutePath));
  } catch {
    return undefined;
  }
}

/**
 * Read a remote directory listing.
 */
export async function readRemoteDir(absolutePath: string): Promise<[string, vscode.FileType][]> {
  const uri = getRemoteUri(absolutePath);
  return vscode.workspace.fs.readDirectory(uri);
}

/**
 * Create a file system watcher for a remote file or glob pattern.
 * Returns a vscode.FileSystemWatcher.
 */
export function watchRemoteFile(absolutePath: string): vscode.FileSystemWatcher {
  const uri = getRemoteUri(absolutePath);
  // Use a RelativePattern so it works with remote URIs
  const pattern = new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), uri.path.split('/').pop()!);
  return vscode.workspace.createFileSystemWatcher(pattern);
}

/**
 * Create a file system watcher for all files matching a glob inside a remote directory.
 */
export function watchRemoteGlob(dirPath: string, glob: string): vscode.FileSystemWatcher {
  const uri = getRemoteUri(dirPath);
  const pattern = new vscode.RelativePattern(uri, glob);
  return vscode.workspace.createFileSystemWatcher(pattern);
}

/**
 * Resolve a path that may contain ~ to an absolute path using a configured home directory.
 * Since we run on the UI side, os.homedir() returns the LOCAL home.
 * The remote home must be provided via settings.
 */
export function resolveRemotePath(p: string, remoteHome: string = '/home/xiko'): string {
  if (p.startsWith('~/')) {
    return remoteHome + p.slice(1);
  }
  return p;
}

// --- Settings helpers ---

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('oceangram');
}

export function getKanbanProjectsPath(): string {
  return cfg().get<string>('kanbanProjectsPath', '/home/xiko/kanban-projects');
}

export function getProjectsJsonPath(): string {
  return cfg().get<string>('projectsJsonPath', '/home/xiko/kanban-app/data/projects.json');
}

export function getOpenclawDir(): string {
  return cfg().get<string>('openclawConfigPath', '/home/xiko/.openclaw');
}

export function getBriefsDir(): string {
  return cfg().get<string>('briefsPath', '/home/xiko/clawd/memory/projects');
}

export function getMemoryDir(): string {
  return cfg().get<string>('memoryPath', '/home/xiko/clawd/memory');
}

export function getRemoteHome(): string {
  return cfg().get<string>('remoteHome', '/home/xiko');
}
