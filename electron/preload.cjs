const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopMeow", {
  onGlobalMove: (handler) => {
    const listener = (_event, direction) => handler(direction);
    ipcRenderer.on("global-move", listener);
    return () => ipcRenderer.removeListener("global-move", listener);
  },
  onWallpaperMode: (handler) => {
    const listener = (_event, enabled) => handler(enabled);
    ipcRenderer.on("wallpaper-mode", listener);
    return () => ipcRenderer.removeListener("wallpaper-mode", listener);
  },
  onWallpaperError: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on("wallpaper-error", listener);
    return () => ipcRenderer.removeListener("wallpaper-error", listener);
  },
  onControlMode: (handler) => {
    const listener = (_event, compact) => handler(compact);
    ipcRenderer.on("control-mode", listener);
    return () => ipcRenderer.removeListener("control-mode", listener);
  },
  onMouseMove: (handler) => {
    const listener = (_event, position) => handler(position);
    ipcRenderer.on("mouse-move", listener);
    return () => ipcRenderer.removeListener("mouse-move", listener);
  },
  setWallpaperMode: (enabled) => ipcRenderer.send("set-wallpaper-mode", enabled),
  publishWallpaperState: (state) => ipcRenderer.send("wallpaper-state", state),
  toggleControl: () => ipcRenderer.send("toggle-control"),
  collapseControl: () => ipcRenderer.send("collapse-control"),
  minimize: () => ipcRenderer.send("minimize-overlay"),
  close: () => ipcRenderer.send("close-app")
});
