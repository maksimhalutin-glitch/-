const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimize:        () => ipcRenderer.send('window-minimize'),
  maximize:        () => ipcRenderer.send('window-maximize'),
  close:           () => ipcRenderer.send('window-close'),
  onWindowState:   (cb) => ipcRenderer.on('window-state', (_, s) => cb(s)),

  // Settings
  getSettings:     ()  => ipcRenderer.invoke('get-settings'),
  saveSettings:    (s) => ipcRenderer.invoke('save-settings', s),
  chooseFolder:    ()  => ipcRenderer.invoke('choose-folder'),

  // Auth
  authCheck:            (token)        => ipcRenderer.invoke('auth-check', token),
  authLoginPassword:    (opts)         => ipcRenderer.invoke('auth-login-password', opts),

  // Content
  search:          (opts) => ipcRenderer.invoke('search', opts),
  getAlbum:        (opts) => ipcRenderer.invoke('get-album', opts),
  getPlaylist:     (opts) => ipcRenderer.invoke('get-playlist', opts),
  getLikedTracks:  (opts) => ipcRenderer.invoke('get-liked-tracks', opts),
  parseUrl:        (opts) => ipcRenderer.invoke('parse-url', opts),

  // Downloads
  downloadTrack:       (opts) => ipcRenderer.invoke('download-track', opts),
  cancelDownload:      (id)   => ipcRenderer.send('cancel-download', id),
  onDownloadProgress:  (cb)   => ipcRenderer.on('download-progress', (_, d) => cb(d)),

  // Shell
  openFolder: (p) => ipcRenderer.send('open-folder', p),
  openFile:   (p) => ipcRenderer.send('open-file', p),
});
