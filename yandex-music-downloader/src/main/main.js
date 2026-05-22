const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const os = require('os');

// ─────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────
let storePath;
try { storePath = path.join(app.getPath('userData'), 'settings.json'); }
catch(e) { storePath = path.join(os.homedir(), '.ymd-settings.json'); }

function readStore() {
  try {
    if (fs.existsSync(storePath)) return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch (e) {}
  return {};
}

function writeStore(data) {
  try {
    fs.writeFileSync(storePath, JSON.stringify({ ...readStore(), ...data }, null, 2));
  } catch (e) { console.error('writeStore error:', e.message); }
}

// ─────────────────────────────────────────────
// Window
// ─────────────────────────────────────────────
let mainWindow;

function createWindow() {
  nativeTheme.themeSource = 'dark';

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    transparent: false,
    backgroundColor: '#0d0d0f',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,       // ← CRITICAL: allows require('electron') in preload on Electron 20+
      webSecurity: true,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Uncomment to open DevTools for debugging:
    // mainWindow.webContents.openDevTools();
  });

  mainWindow.on('maximize',   () => mainWindow.webContents.send('window-state', 'maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state', 'normal'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─────────────────────────────────────────────
// Window controls
// ─────────────────────────────────────────────
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

// ─────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────
ipcMain.handle('get-settings', () => readStore());
ipcMain.handle('save-settings', (_, settings) => { writeStore(settings); return true; });
ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Выбрать папку для сохранения',
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─────────────────────────────────────────────
// Yandex Music API
// ─────────────────────────────────────────────
const YM_BASE = 'https://api.music.yandex.net';
const YM_HEADERS = (token) => ({
  Authorization: `OAuth ${token}`,
  'X-Yandex-Music-Client': 'WindowsPhone/3.20',
  'User-Agent': 'Yandex-Music-API',
  Accept: 'application/json',
});

async function ymGet(endpoint, token, params = {}) {
  const axios = require('axios');
  try {
    const res = await axios.get(`${YM_BASE}${endpoint}`, {
      params,
      headers: YM_HEADERS(token),
      timeout: 15000,
    });
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
    throw new Error(msg);
  }
}

// Auth
ipcMain.handle('auth-check', async (_, token) => {
  try {
    const data = await ymGet('/account/status', token);
    const acc = data.result?.account;
    if (!acc) throw new Error('Неверный токен — аккаунт не найден');
    return {
      success: true,
      user: {
        uid: acc.uid,
        login: acc.login,
        name: acc.fullName || acc.displayName || acc.login,
        plus: !!data.result?.plus?.hasPlus,
      },
    };
  } catch (e) { return { success: false, error: e.message }; }
});

// Search
ipcMain.handle('search', async (_, { token, query, type = 'track', page = 0 }) => {
  try {
    const data = await ymGet('/search', token, { text: query, type, page, nococrrect: false });
    return { success: true, result: data.result };
  } catch (e) { return { success: false, error: e.message }; }
});

// Album
ipcMain.handle('get-album', async (_, { token, albumId }) => {
  try {
    const data = await ymGet(`/albums/${albumId}/with-tracks`, token);
    return { success: true, result: data.result };
  } catch (e) { return { success: false, error: e.message }; }
});

// Playlist
ipcMain.handle('get-playlist', async (_, { token, uid, kind }) => {
  try {
    const data = await ymGet(`/users/${uid}/playlists/${kind}`, token);
    return { success: true, result: data.result };
  } catch (e) { return { success: false, error: e.message }; }
});

// Liked tracks
ipcMain.handle('get-liked-tracks', async (_, { token }) => {
  try {
    const axios = require('axios');
    const status = await ymGet('/account/status', token);
    const uid = status.result?.account?.uid;
    const data = await ymGet(`/users/${uid}/likes/tracks`, token);
    const ids = (data.result?.library?.tracks || []).map(t => t.id);
    if (!ids.length) return { success: true, result: [] };

    let tracks = [];
    for (let i = 0; i < ids.length; i += 150) {
      const batch = ids.slice(i, i + 150);
      const r = await axios.post(
        `${YM_BASE}/tracks`,
        `track-ids=${batch.join(',')}`,
        { headers: { Authorization: `OAuth ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      tracks = tracks.concat(r.data.result || []);
    }
    return { success: true, result: tracks };
  } catch (e) { return { success: false, error: e.message }; }
});

// Parse URL
ipcMain.handle('parse-url', async (_, { token, url }) => {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'album' && parts[2] === 'track') {
      const data = await ymGet(`/tracks/${parts[3]}`, token);
      return { success: true, type: 'track', result: data.result };
    } else if (parts[0] === 'album') {
      const data = await ymGet(`/albums/${parts[1]}/with-tracks`, token);
      return { success: true, type: 'album', result: data.result };
    } else if (parts[0] === 'users' && parts[2] === 'playlists') {
      const data = await ymGet(`/users/${parts[1]}/playlists/${parts[3]}`, token);
      return { success: true, type: 'playlist', result: data.result };
    }
    return { success: false, error: 'Неизвестный формат ссылки Яндекс Музыки' };
  } catch (e) { return { success: false, error: e.message }; }
});

// ─────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────
async function getDownloadUrl(token, trackId) {
  const axios = require('axios');
  const infoRes = await axios.get(`${YM_BASE}/tracks/${trackId}/download-info`, {
    headers: YM_HEADERS(token),
  });
  const infos = infoRes.data.result;
  if (!infos?.length) throw new Error('Нет информации для скачивания');

  const sorted = infos.filter(i => i.codec === 'mp3').sort((a, b) => b.bitrateInKbps - a.bitrateInKbps);
  const info = sorted[0] || infos[0];

  const xmlRes = await axios.get(info.downloadInfoUrl + '&format=json');
  const dl = xmlRes.data;
  const sign = crypto.createHash('md5')
    .update('XGRlBW9FXlekgbPrRHuSiA' + dl.path.slice(1) + dl.s)
    .digest('hex');
  return {
    url: `https://${dl.host}/get-mp3/${sign}/${dl.ts}${dl.path}`,
    codec: info.codec,
    bitrate: info.bitrateInKbps,
  };
}

const activeDownloads = new Map();

ipcMain.handle('download-track', async (_, { token, track, outputDir, filenameTemplate }) => {
  const trackId = track.id;
  const emit = (data) => mainWindow?.webContents.send('download-progress', data);

  try {
    emit({ trackId, status: 'preparing', progress: 0 });

    // Ensure output dir exists
    const saveDir = outputDir || os.homedir();
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

    const { url, codec } = await getDownloadUrl(token, trackId);

    const sanitize = require('sanitize-filename');
    const artists = (track.artists || []).map(a => a.name).join(', ') || 'Unknown';
    const title = track.title || 'Unknown';
    const albumTitle = track.albums?.[0]?.title || '';
    const year = String(track.albums?.[0]?.year || '');

    const rawName = (filenameTemplate || '{artist} - {title}')
      .replace('{artist}', artists)
      .replace('{title}',  title)
      .replace('{album}',  albumTitle)
      .replace('{year}',   year)
      .replace('{id}',     String(trackId));

    const filename = sanitize(rawName) + '.' + codec;
    const filePath = path.join(saveDir, filename);

    // Skip existing
    if (fs.existsSync(filePath)) {
      emit({ trackId, status: 'done', progress: 100, filePath });
      return { success: true, filePath };
    }

    // Download file
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      let downloaded = 0;
      let total = 0;
      const protocol = url.startsWith('https') ? https : http;
      const req = protocol.get(url, res => {
        total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', chunk => {
          downloaded += chunk.length;
          file.write(chunk);
          if (total > 0) emit({ trackId, status: 'downloading', progress: Math.round(downloaded/total*100) });
        });
        res.on('end', () => { file.end(); resolve(); });
        res.on('error', reject);
      });
      req.on('error', err => { file.destroy(); reject(err); });
      activeDownloads.set(String(trackId), req);
    });

    activeDownloads.delete(String(trackId));

    // ID3 tags
    try {
      const NodeID3 = require('node-id3');
      const tags = { title, artist: artists, album: albumTitle, year };
      if (track.coverUri) {
        const axios = require('axios');
        const coverUrl = 'https://' + track.coverUri.replace('%%', '400x400');
        try {
          const imgRes = await axios.get(coverUrl, { responseType: 'arraybuffer', timeout: 8000 });
          tags.image = {
            mime: 'image/jpeg',
            type: { id: 3, name: 'front cover' },
            description: 'Cover',
            imageBuffer: Buffer.from(imgRes.data),
          };
        } catch (_) {}
      }
      NodeID3.update(tags, filePath);
    } catch (_) {}

    emit({ trackId, status: 'done', progress: 100, filePath });
    return { success: true, filePath };

  } catch (e) {
    activeDownloads.delete(String(trackId));
    emit({ trackId, status: 'error', error: e.message });
    return { success: false, error: e.message };
  }
});

ipcMain.on('cancel-download', (_, trackId) => {
  const req = activeDownloads.get(String(trackId));
  if (req) { req.destroy(); activeDownloads.delete(String(trackId)); }
});

ipcMain.on('open-folder', (_, folderPath) => {
  try { shell.openPath(folderPath || os.homedir()); } catch (_) {}
});

ipcMain.on('open-file', (_, filePath) => {
  try { shell.showItemInFolder(filePath); } catch (_) {}
});

// ─────────────────────────────────────────────
// Auth via login + password (most reliable)
// ─────────────────────────────────────────────
ipcMain.handle('auth-login-password', async (_, { login, password }) => {
  const axios = require('axios');
  try {
    // Step 1: get OAuth token via password grant
    const tokenRes = await axios.post(
      'https://oauth.yandex.ru/token',
      new URLSearchParams({
        grant_type:    'password',
        client_id:     '23cabbbdc6cd418abb4b39c32c41195d',
        client_secret: '53bc75238f0a4d08a2aebc38680c7049',
        username:      login,
        password:      password,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );
    const token = tokenRes.data.access_token;
    if (!token) throw new Error('Токен не получен от Яндекса');

    // Step 2: verify with Yandex Music
    const data = await ymGet('/account/status', token);
    const acc  = data.result?.account;
    if (!acc) throw new Error('Аккаунт Яндекс Музыки не найден');

    return {
      success: true,
      token,
      user: {
        uid:   acc.uid,
        login: acc.login,
        name:  acc.fullName || acc.displayName || acc.login,
        plus:  !!data.result?.plus?.hasPlus,
      },
    };
  } catch (e) {
    const msg = e.response?.data?.error_description
             || e.response?.data?.error
             || e.message;
    return { success: false, error: msg };
  }
});
