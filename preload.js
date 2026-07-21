const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('open-file'),
  saveReview: (review) => ipcRenderer.invoke('save-review', review),
  saveDraft: (data) => ipcRenderer.invoke('save-draft', data),
  loadDraft: (filePath) => ipcRenderer.invoke('load-draft', filePath),
  deleteDraft: (filePath) => ipcRenderer.invoke('delete-draft', filePath),
  getConfig: () => ipcRenderer.invoke('get-config'),
  exportMarkdown: (data) => ipcRenderer.invoke('export-markdown', data),
  onLoadDiff: (callback) => ipcRenderer.on('load-diff', (event, data) => callback(data))
});
