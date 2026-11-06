const { contextBridge, ipcRenderer } = require('electron');

function bind(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload || {});
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktopOverlay', {
  onLyricsState: (callback) => bind('mineradio-desktop-lyrics-state', callback),
  onLyricsHotBoundsRequested: (callback) => bind('mineradio-desktop-lyrics-request-hot-bounds', callback),
  onWallpaperState: (callback) => bind('mineradio-wallpaper-state', callback),
  setLyricsDrag: (dragging, cancel, sessionId) => ipcRenderer.invoke('mineradio-desktop-lyrics-set-dragging', !!dragging, !!cancel, sessionId == null ? null : Number(sessionId)),
  setLyricsPointerCapture: (active) => ipcRenderer.invoke('mineradio-desktop-lyrics-set-pointer-capture', !!active),
  setLyricsHotBounds: (bounds, layoutId) => ipcRenderer.invoke('mineradio-desktop-lyrics-set-hot-bounds', bounds == null ? null : bounds, layoutId == null ? null : Number(layoutId)),
  setLyricsLockState: (locked) => ipcRenderer.invoke('mineradio-desktop-lyrics-set-lock-state', !!locked),
  moveLyricsBy: (dx, dy, sessionId) => ipcRenderer.invoke('mineradio-desktop-lyrics-move-by', Number(dx) || 0, Number(dy) || 0, sessionId == null ? null : Number(sessionId)),
  closeLyrics: () => ipcRenderer.invoke('mineradio-desktop-lyrics-set-enabled', false, {}),
});
