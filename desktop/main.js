/* Electron main process — boots the window, hosts the <webview> that "acts as a
 * browser", reads the page HTML, and delegates all scraper work to core.js.
 * Anonymous end-to-end: the Supabase client uses the anon key only, no auth. */

'use strict';

const { app, BrowserWindow, ipcMain, webContents, shell } = require('electron');
const path = require('path');

// Load the shared anonymous Supabase client into the global scope (core.js reads
// it from `Supabase`). `global.self` is aliased so the predefined scraper module
// (which references `self.ProductScraper`) works under Node.
global.self = globalThis;
require(path.join(__dirname, 'renderer', 'supabase.js'));
const Supabase = globalThis.Supabase;

let mainWindow = null;

const core = require('./core.js')({
  Supabase,
  sendProgress: (step, state, detail) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('addScraperProgress', { step, state, detail });
    }
  },
  sendThinking: (text) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agentThinking', String(text || ''));
    }
  },
});

// Resolve the webview's webContents by id (captured in the renderer) and read the
// full rendered HTML — the exact Electron equivalent of the extension's
// `getTabHtml` (chrome.scripting.executeScript → document.documentElement.outerHTML).
async function getWebviewHtml(wcId) {
  const wc = webContents.fromId(wcId);
  if (!wc) throw new Error('Browser is not ready. Load a page first.');
  return wc.executeJavaScript('document.documentElement.outerHTML', true) || '';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Universal Scrapper',
    backgroundColor: '#121218',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // allow the embedded <webview> browser
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open external links in the OS browser instead of hijacking the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC handlers (mirror the extension's chrome.runtime.sendMessage API) ───────
ipcMain.handle('scrape', async (_e, { url, webContentsId, productType }) => {
  try {
    const html = await getWebviewHtml(webContentsId);
    return await core.handleScrape({ url, html, productType: productType || 'auto' });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('addScraper', async (_e, { url, webContentsId }) => {
  try {
    const html = await getWebviewHtml(webContentsId);
    return await core.handleAddScraper({ url, html });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('fixScraper', async (_e, { url, webContentsId, type, corrections }) => {
  try {
    const html = await getWebviewHtml(webContentsId);
    return await core.fixScraper({ url, html, type, corrections });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('verifyScraper', async (_e, { url, type }) => core.verifyScraper({ url, type }));
ipcMain.handle('wcTest', async (_e, { store, authKey }) => core.wcTest({ store, authKey }));
ipcMain.handle('wcImport', async (_e, { store, authKey, csv, skipResize }) => core.wcImport({ store, authKey, csv, skipResize }));
ipcMain.handle('fetchSwatchDataUrl', async (_e, { swatchUrl }) => ({ dataUrl: await core.fetchSwatchAsDataUrl(swatchUrl) }));
