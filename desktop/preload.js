/* Preload — exposes a minimal, promise-based bridge from the renderer to the
 * main process (the Electron equivalent of chrome.runtime.sendMessage) plus
 * push channels for the add-scraper progress / agent-thinking events. */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  scrape: (payload) => ipcRenderer.invoke('scrape', payload),
  addScraper: (payload) => ipcRenderer.invoke('addScraper', payload),
  fixScraper: (payload) => ipcRenderer.invoke('fixScraper', payload),
  verifyScraper: (payload) => ipcRenderer.invoke('verifyScraper', payload),
  wcTest: (payload) => ipcRenderer.invoke('wcTest', payload),
  wcImport: (payload) => ipcRenderer.invoke('wcImport', payload),
  fetchSwatchDataUrl: (payload) => ipcRenderer.invoke('fetchSwatchDataUrl', payload),

  onAddScraperProgress: (cb) => ipcRenderer.on('addScraperProgress', (_e, data) => cb(data)),
  onAgentThinking: (cb) => ipcRenderer.on('agentThinking', (_e, text) => cb(text)),
});
