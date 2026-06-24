import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerIpc } from './handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.ONE_AGENT_DEV === '1';

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hiddenInset', // Codex-like clean Mac chrome
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    void win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS-only build: keep default behaviour but quit cleanly elsewhere.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
