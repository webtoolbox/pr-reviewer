const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('open-file'),
  saveReview: (review) => ipcRenderer.invoke('save-review', review),
  saveDraft: (data) => ipcRenderer.invoke('save-draft', data),
  loadDraft: (filePath) => ipcRenderer.invoke('load-draft', filePath),
  deleteDraft: (filePath) => ipcRenderer.invoke('delete-draft', filePath),
  getConfig: () => ipcRenderer.invoke('get-config'),
  exportMarkdown: (data) => ipcRenderer.invoke('export-markdown', data),
  saveImage: (data) => ipcRenderer.invoke('save-image', data),
  loadPr: (prNumber) => ipcRenderer.invoke('load-pr', prNumber),
  listPrs: () => ipcRenderer.invoke('list-prs'),
  openPrNewWindow: (prNumber) => ipcRenderer.invoke('open-pr-new-window', prNumber),
  getPrCommits: (prNumber) => ipcRenderer.invoke('get-pr-commits', prNumber),
  getFileBlame: (data) => ipcRenderer.invoke('get-file-blame', data),
  submitGitHubReview: (data) => ipcRenderer.invoke('submit-github-review', data),
  openFileInEditor: (data) => ipcRenderer.invoke('open-file-in-editor', data),
  getAgentRules: () => ipcRenderer.invoke('get-agent-rules'),
  proposeRules: (data) => ipcRenderer.invoke('propose-rules', data),
  saveAgentRules: (data) => ipcRenderer.invoke('save-agent-rules', data),
  deletePrFiles: (prNumber) => ipcRenderer.invoke('delete-pr-files', prNumber),
  getNextPr: (prNumber) => ipcRenderer.invoke('get-next-pr', prNumber),
  onLoadDiff: (callback) => ipcRenderer.on('load-diff', (event, data) => callback(data)),
  onTriggerOpenFile: (callback) => ipcRenderer.on('trigger-open-file', () => callback())
});
