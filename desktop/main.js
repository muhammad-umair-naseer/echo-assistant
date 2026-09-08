/**
 * JARVIS desktop shell (Electron). Double-click the app and everything happens:
 * it finds the system Node, spawns the backend (which also serves the built
 * frontend), waits for the port, and opens its own window. Quitting kills the
 * backend it started (a server that was already running is left alone).
 *
 * The backend deliberately runs under SYSTEM node, not Electron's: the native
 * better-sqlite3 module is compiled for the system Node ABI, and spawning
 * avoids the Electron-ABI rebuild dance entirely.
 */
const { app, BrowserWindow, shell } = require("electron");
const { spawn, execSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const PORT = 8790;
const URL_ROOT = `http://localhost:${PORT}`;
const os = require("node:os");

// Where does the repo live? In dev, one level up from desktop/. In the packaged
// .app, __dirname sits inside the app bundle, so fall back to the known repo
// location. First candidate that actually contains the backend wins.
const REPO = [path.resolve(__dirname, ".."), path.join(os.homedir(), "builds", "echo-assistant")].find((p2) =>
  existsSync(path.join(p2, "backend", "src", "server.ts")),
);

let backend = null; // child process we own (null if we attached to an existing server)
let win = null;

function findNode() {
  try {
    // Finder-launched apps get a bare PATH — ask a login shell where node lives.
    return execSync('/bin/zsh -lc "which node"', { encoding: "utf8" }).trim();
  } catch {
    for (const p of ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"]) {
      if (existsSync(p)) return p;
    }
    return null;
  }
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${URL_ROOT}/api/status`, { timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureBackend() {
  if (await ping()) return true; // already running (dev workflow) — just attach

  const node = findNode();
  if (!node || !REPO) return false;
  backend = spawn(node, ["src/server.ts"], {
    cwd: path.join(REPO, "backend"),
    stdio: "ignore",
    detached: false,
  });
  backend.on("exit", () => {
    backend = null;
  });

  for (let i = 0; i < 60; i++) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "JARVIS",
    backgroundColor: "#070c08",
    show: false,
  });
  win.once("ready-to-show", () => win.show());
  // External links (open_url tool) go to the real browser, not our window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const ok = await ensureBackend();
  if (ok) {
    await win.loadURL(URL_ROOT);
  } else {
    await win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<body style="background:#070c08;color:#4af585;font-family:Menlo,monospace;display:grid;place-items:center;height:100vh;margin:0">
             <div style="max-width:60ch;line-height:1.7">
               <div style="font-size:28px;font-weight:700;letter-spacing:.12em">JARVIS_</div>
               <p>backend failed to start.</p>
               <p style="color:#2c7a4b">needs Node.js on this machine and the repo intact.<br/>
               try from a terminal:&nbsp; cd ${REPO}/backend && npm run server</p>
             </div>
           </body>`,
        ),
    );
  }
}

app.whenReady().then(createWindow);
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
app.on("window-all-closed", () => app.quit());
app.on("quit", () => {
  if (backend) backend.kill();
});
