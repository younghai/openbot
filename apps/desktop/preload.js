const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openbot", {
  isDesktop: true,
  platform: process.platform,
  onServerExited: (cb) => ipcRenderer.on("server-exited", (_, code) => cb(code)),
});
