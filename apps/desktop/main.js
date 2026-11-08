/**
 * OpenBot Desktop — minimal Electron shell (OpenMausBot/dinobot pattern).
 * Spawns the server as a child process, opens a BrowserWindow at localhost:8940,
 * sits in the tray. One command: `cd apps/desktop && npm i && npm start`.
 */

const { app, BrowserWindow, Tray, Menu, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");

const PORT = Number(process.env.OPENBOT_PORT || 8940);
const HOST = "127.0.0.1";
const URL = `http://${HOST}:${PORT}`;

let serverProcess = null;
let mainWindow = null;
let tray = null;

// ---- server lifecycle ----

function startServer() {
  if (serverProcess) return;
  const serverDir = path.resolve(__dirname, "..", "server");
  const tsxPath = path.resolve(__dirname, "..", "..", "node_modules", ".bin", "tsx");
  serverProcess = spawn(tsxPath, [path.join(serverDir, "src", "index.ts")], {
    cwd: serverDir,
    env: { ...process.env, OPENBOT_PORT: String(PORT), OPENBOT_HOST: HOST },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  serverProcess.stdout.on("data", (d) => process.env.OPENBOT_DESKTOP_VERBOSE && console.log("[server]", String(d).trim()));
  serverProcess.stderr.on("data", (d) => console.error("[server:err]", String(d).trim()));
  serverProcess.on("exit", (code) => {
    console.log("[server] exited", code);
    serverProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("server-exited", code);
    }
  });
}

function stopServer() {
  if (!serverProcess) return;
  serverProcess.kill("SIGTERM");
  serverProcess = null;
}

function waitForServer(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const socket = net.connect(PORT, HOST);
      socket.on("connect", () => { socket.destroy(); resolve(true); });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() < deadline) setTimeout(check, 500);
        else resolve(false);
      });
    };
    check();
  });
}

// ---- window ----

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0b0e14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.loadURL(URL);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });

  // open external links in the default browser, not in-app
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("http") && !target.startsWith(URL)) {
      require("electron").shell.openExternal(target);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

// ---- tray ----

function createTray() {
  // Use a 16x16 template image; Electron auto-adapts to dark/light mode
  const icon = require("electron").nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAhGVYSWZNTQAqAAAACAAFARIAAwAAAAEAAQAAARoABQAAAAEAAABKARsABQAAAAEAAABSASgAAwAAAAEAAgAAh2kABAAAAAEAAABaAAAAAAAAAJAAAAABAAAAkAAAAAEAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEgAAAAAACXIGyAAAAmJLR0QA/4ePzL8AAAAJcEhZcwAAAOwAAADsAB2jejAAAAAWSURBVDhLY/j//z8DEMhgCJgYGBiIAQAkBgDAlEnozgAAAABJRU5ErkJggg=="
  );
  tray = new Tray(icon);
  tray.setToolTip("OpenBot");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open OpenBot", click: () => (mainWindow ? mainWindow.show() : createWindow()) },
    { type: "separator" },
    { label: "Restart Server", click: () => { stopServer(); setTimeout(() => { startServer(); waitForServer(URL).then((ok) => ok && mainWindow?.reload()); }, 1000); } },
    { type: "separator" },
    { label: "Quit", click: () => { stopServer(); app.quit(); } },
  ]));
  tray.on("click", () => (mainWindow ? (mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()) : createWindow()));
}

// ---- lifecycle ----

app.whenReady().then(async () => {
  startServer();
  const ok = await waitForServer(URL);
  if (!ok) {
    dialog.showErrorBox("OpenBot", `Server failed to start on ${URL} within 15s.\nCheck that port ${PORT} is free and the server dependencies are installed.`);
    app.quit();
    return;
  }
  createWindow();
  createTray();
});

app.on("window-all-closed", () => {
  // keep running in tray on macOS; quit on others
  if (process.platform !== "darwin") { stopServer(); app.quit(); }
});

app.on("before-quit", () => stopServer());
