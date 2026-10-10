const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray
} = require("electron");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

let window;
let overlayWindow;
let tray;
let wallpaperMode = false;
let compactControl = false;
let foregroundMonitor;
let wallpaperTransition = Promise.resolve();
let wallpaperServer;
let desktopActive = false;
const wallpaperClients = new Set();
const WALLPAPER_PORT = 32145;
const LIVELY_PATH = "C:\\Program Files\\Lively Wallpaper\\Lively.exe";
const LIVELY_INSTALLER = "lively_setup_x86_full_v2210.exe";

function nativeHandle(browserWindow) {
  const handle = browserWindow.getNativeWindowHandle();
  return process.arch === "x64"
    ? handle.readBigUInt64LE(0).toString()
    : handle.readUInt32LE(0).toString();
}

function runLively(args) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(LIVELY_PATH)) {
      reject(new Error("尚未安裝 Lively Wallpaper"));
      return;
    }
    execFile(LIVELY_PATH, args, { windowsHide: true, timeout: 30000 }, (error) => {
      if (error) reject(error);
      else resolve(true);
    });
  });
}

function isLivelyRunning() {
  return new Promise((resolve) => {
    execFile(
      "tasklist.exe",
      ["/FI", "IMAGENAME eq Lively.exe", "/FO", "CSV", "/NH"],
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => resolve(!error && /"Lively\.exe"/i.test(stdout))
    );
  });
}

async function ensureLivelyRunning() {
  if (await isLivelyRunning()) return;
  const livelyProcess = spawn(LIVELY_PATH, [], {
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  livelyProcess.unref();

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await isLivelyRunning()) {
      // Give the single-instance command server time to finish initializing.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return;
    }
  }
  throw new Error("Lively Wallpaper 啟動逾時");
}

function livelyInstallerPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, LIVELY_INSTALLER)
    : path.join(__dirname, "..", LIVELY_INSTALLER);
}

function ensureLivelyInstalled() {
  if (fs.existsSync(LIVELY_PATH)) return Promise.resolve(true);
  const installer = livelyInstallerPath();
  if (!fs.existsSync(installer)) {
    return Promise.reject(new Error("找不到內附的 Lively Wallpaper 安裝程式"));
  }
  return new Promise((resolve, reject) => {
    execFile(
      installer,
      ["/VERYSILENT", "/NORESTART", "/SP-"],
      { windowsHide: true, timeout: 180000 },
      (error) => {
        if (error || !fs.existsSync(LIVELY_PATH)) {
          reject(error || new Error("Lively Wallpaper 安裝未完成"));
        } else {
          resolve(true);
        }
      }
    );
  });
}

function wallpaperHtmlPath() {
  return path.join(__dirname, "..", "lively", "wallpaper.html");
}

function livelyProjectPath() {
  return path.join(
    process.env.LOCALAPPDATA,
    "Lively Wallpaper",
    "Library",
    "wallpapers",
    "desktop-game-meow"
  );
}

function syncLivelyProject() {
  const source = path.join(__dirname, "..", "lively");
  const target = livelyProjectPath();
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(source, "wallpaper.html"), path.join(target, "wallpaper.html"));
  fs.copyFileSync(path.join(source, "LivelyInfo.json"), path.join(target, "LivelyInfo.json"));
  return target;
}

function startWallpaperServer() {
  wallpaperServer = http.createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      response.end();
      return;
    }

    if (request.url === "/move" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        if (body.length < 4096) body += chunk;
      });
      request.on("end", () => {
        try {
          const position = JSON.parse(body);
          const x = Number(position.x);
          const y = Number(position.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error("Invalid pointer position");
          }
          window?.webContents.send("mouse-move", {
            x,
            y
          });
          response.writeHead(204, { "Access-Control-Allow-Origin": "*" });
        } catch {
          response.writeHead(400, { "Access-Control-Allow-Origin": "*" });
        }
        response.end();
      });
      return;
    }

    if (request.url === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });
      response.write("event: ready\ndata: {}\n\n");
      wallpaperClients.add(response);
      request.on("close", () => wallpaperClients.delete(response));
      return;
    }

    if (request.url === "/" || request.url?.startsWith("/wallpaper.html")) {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      fs.createReadStream(wallpaperHtmlPath()).pipe(response);
      return;
    }

    if (request.url === "/control.html" || request.url?.startsWith("/assets/")) {
      const distRoot = path.resolve(__dirname, "..", "dist");
      const relativePath = request.url === "/control.html"
        ? "control.html"
        : decodeURIComponent(request.url.slice(1).split("?")[0]);
      const requestedFile = path.resolve(distRoot, relativePath);
      if (!requestedFile.startsWith(`${distRoot}${path.sep}`) || !fs.existsSync(requestedFile)) {
        response.writeHead(404);
        response.end();
        return;
      }
      const extension = path.extname(requestedFile).toLowerCase();
      const contentTypes = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".svg": "image/svg+xml"
      };
      response.writeHead(200, {
        "Content-Type": contentTypes[extension] || "application/octet-stream",
        "Cache-Control": "no-store"
      });
      fs.createReadStream(requestedFile).pipe(response);
      return;
    }

    response.writeHead(404);
    response.end();
  });
  wallpaperServer.listen(WALLPAPER_PORT, "127.0.0.1");
}

function broadcastWallpaperState(state) {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  wallpaperClients.forEach((client) => client.write(payload));
}

function startForegroundMonitor() {
  foregroundMonitor = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, "foreground-monitor.ps1")
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
  );
  let pending = "";
  foregroundMonitor.stdout.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    lines.forEach((line) => {
      const message = line.trim();
      if (message.startsWith("MOVE:")) {
        window?.webContents.send("global-move", message.slice(5));
      } else if (message === "ACTIVE:desktop") {
        setOverlayDesktopActive(true);
      } else if (message === "ACTIVE:app") {
        setOverlayDesktopActive(false);
      }
    });
  });
  foregroundMonitor.stderr.on("data", (chunk) => {
    console.error("Arrow-key monitor:", chunk.toString().trim());
  });
  foregroundMonitor.on("exit", (code) => {
    if (code && !app.isQuitting) {
      console.error(`Arrow-key monitor exited with code ${code}`);
    }
  });
}

function overlayBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const top = workArea.y + Math.round(workArea.height * 0.5);
  return {
    x: workArea.x,
    y: top,
    width: workArea.width,
    height: workArea.y + workArea.height - top
  };
}

function setOverlayDesktopActive(active) {
  desktopActive = active;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (active) {
    // The overlay sits above Explorer only while the desktop is active.
    // Ordinary applications remove this flag and naturally cover it.
    overlayWindow.setAlwaysOnTop(true, "normal");
    overlayWindow.showInactive();
  } else {
    overlayWindow.setAlwaysOnTop(false);
    // Hiding guarantees that Windows 10 applications, including borderless
    // games, fully cover the desktop layer without relying on newer DWM APIs.
    overlayWindow.hide();
  }
}

function createOverlayWindow() {
  const bounds = overlayBounds();
  overlayWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  overlayWindow.setFullScreenable(false);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  const offsetY = encodeURIComponent(bounds.y);
  overlayWindow.loadURL(`http://127.0.0.1:${WALLPAPER_PORT}/wallpaper.html?overlay=1&offsetY=${offsetY}`);
  overlayWindow.once("ready-to-show", () => {
    if (desktopActive) overlayWindow.showInactive();
  });
}

function setControlWindow(compact) {
  if (!window || window.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  compactControl = compact;
  const width = compact ? 82 : 390;
  const height = compact ? 82 : Math.min(680, workArea.height - 24);
  window.setBounds({
    x: workArea.x + workArea.width - width - 18,
    y: workArea.y + workArea.height - height - 18,
    width,
    height
  });
  window.setAlwaysOnTop(true, "floating");
  window.showInactive();
  if (!compact) window.focus();
  window.webContents.send("control-mode", compact);
}

function setWallpaperMode(enabled) {
  wallpaperTransition = wallpaperTransition
    .catch(() => {})
    .then(async () => {
      if (!window || (enabled && wallpaperMode)) return;

      if (enabled) {
        await ensureLivelyInstalled();
        const project = syncLivelyProject();
        await ensureLivelyRunning();
        await runLively(["setwp", "--file", project]);
        // The wallpaper is already active at this point. Some Lively versions
        // return a non-zero status for this auxiliary command even though the
        // desktop is healthy, so it must not roll back wallpaper mode.
        await runLively(["app", "--showIcons", "true"]).catch((error) => {
          console.warn("Unable to request desktop icons from Lively:", error.message);
        });
        wallpaperMode = true;
        window.webContents.send("wallpaper-mode", true);
      } else {
        await runLively(["closewp", "--monitor", "-1"]).catch(() => {});
        wallpaperMode = false;
        window.webContents.send("wallpaper-mode", false);
      }
    })
    .catch((error) => {
      wallpaperMode = false;
      window?.webContents.send("wallpaper-error", error.message);
    });

  return wallpaperTransition;
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 390;
  const height = Math.min(680, workArea.height - 24);
  window = new BrowserWindow({
    x: workArea.x + workArea.width - width - 18,
    y: workArea.y + workArea.height - height - 18,
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    skipTaskbar: true,
    resizable: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  window.setFullScreenable(false);
  window.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      parent: window,
      modal: false,
      width: 520,
      height: 720,
      minWidth: 420,
      minHeight: 600,
      show: true,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      backgroundColor: "#ffffff",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    }
  }));
  window.webContents.on("did-create-window", (childWindow) => {
    childWindow.setAlwaysOnTop(true, "pop-up-menu");
    childWindow.center();
    childWindow.show();
    childWindow.focus();
  });
  window.loadURL(
    app.isPackaged
      ? `http://127.0.0.1:${WALLPAPER_PORT}/control.html`
      : "http://127.0.0.1:5173/control.html"
  );
}

function createTray() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="#ff92c9"/><stop offset="1" stop-color="#78d9ed"/>
      </linearGradient></defs>
      <circle cx="16" cy="16" r="14" fill="url(#g)"/>
      <path d="M9 13l2-5 4 4h2l4-4 2 5v7c0 4-3 7-7 7s-7-3-7-7z" fill="white"/>
      <circle cx="13" cy="18" r="1.2" fill="#75536f"/>
      <circle cx="19" cy="18" r="1.2" fill="#75536f"/>
    </svg>`;
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
  );
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("桌面遊戲喵");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "開啟控制介面",
        click: () => setControlWindow(false)
      },
      {
        label: "啟用動態桌布",
        click: () => setWallpaperMode(true)
      },
      {
        label: "停止動態桌布",
        click: () => setWallpaperMode(false)
      },
      { type: "separator" },
      { label: "結束桌面遊戲喵", click: () => app.quit() }
    ])
  );
  tray.on("double-click", () => setControlWindow(false));
}

app.whenReady().then(async () => {
  startWallpaperServer();
  createOverlayWindow();
  createWindow();
  createTray();
  startForegroundMonitor();

  const controls = {
    Left: "left",
    Right: "right",
    Up: "up",
    Down: "down"
  };

  Object.entries(controls).forEach(([key, direction]) => {
    globalShortcut.register(`CommandOrControl+Alt+${key}`, () => {
      window?.webContents.send("global-move", direction);
    });
  });

  const toggleControl = () => setControlWindow(!compactControl);
  globalShortcut.register("CommandOrControl+Alt+M", toggleControl);
  globalShortcut.register("CommandOrControl+Shift+M", toggleControl);
  globalShortcut.register("F9", () => setControlWindow(false));

  screen.on("display-metrics-changed", () => {
    setControlWindow(compactControl);
    overlayWindow?.setBounds(overlayBounds());
  });
});

ipcMain.on("minimize-overlay", () => window?.minimize());
ipcMain.on("close-app", () => app.quit());
ipcMain.on("set-wallpaper-mode", (_event, enabled) => setWallpaperMode(Boolean(enabled)));
ipcMain.on("wallpaper-state", (_event, state) => broadcastWallpaperState(state));
ipcMain.on("toggle-control", () => setControlWindow(!compactControl));
ipcMain.on("collapse-control", () => setControlWindow(true));

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  foregroundMonitor?.kill();
  wallpaperServer?.close();
  if (wallpaperMode) runLively(["closewp", "--monitor", "-1"]).catch(() => {});
});
app.on("window-all-closed", () => app.quit());
