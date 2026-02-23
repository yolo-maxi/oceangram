// loginPreload.ts — Secure IPC bridge for the login window
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('oceangram', {
  // Notify main process that login succeeded
  loginSuccess: (): void => ipcRenderer.send('login-success'),

  // Close the login window
  closeLogin: (): void => ipcRenderer.send('close-login'),
});
