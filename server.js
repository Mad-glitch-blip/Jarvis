require("dotenv").config();
const express = require("express");
const Database = require("better-sqlite3");
const path = require("node:path");
const fs = require("node:fs");
const { randomBytes, timingSafeEqual, createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const os = require("node:os");
const { performance } = require("node:perf_hooks");

const app = express();
const HOST = "localhost";
const PORT = 3000;
const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const MODEL = "qwen3.5:4b";
const RP_ID = "localhost";
const EXPECTED_ORIGIN = "http://localhost:3000";

const ownerSessions = new Map();
const appScanResults = new Map();
let pendingRegistration = null;
let pendingAuthentication = null;
let setupCode = null;
let webauthnModulePromise = null;
let playwrightBrowser = null;

function webauthn() {
  if (!webauthnModulePromise) webauthnModulePromise = import("@simplewebauthn/server");
  return webauthnModulePromise;
}

const dataDirectory = path.join(__dirname, "data");
fs.mkdirSync(dataDirectory, { recursive: true });

const db = new Database(path.join(dataDirectory, "jarvis.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'New conversation',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS owner_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const APPROVED_SITES = {
  youtube: "https://www.youtube.com",
  instagram: "https://www.instagram.com",
  google: "https://www.google.com",
  github: "https://github.com",
  gmail: "https://mail.google.com",
  twitter: "https://x.com",
  x: "https://x.com"
};

function ownerConfigured() {
  return Boolean(db.prepare("SELECT id FROM owner_credentials WHERE id = 1").get());
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function getOwnerSession(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const session = ownerSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    ownerSessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + 30 * 60 * 1000;
  return session;
}

function requireOwner(req, res, next) {
  if (!getOwnerSession(req)) {
    return res.status(401).json({
      error: "Owner mode is locked. Verify with Windows Hello first."
    });
  }
  next();
}

function newOwnerSession(res) {
  const token = randomBytes(32).toString("base64url");
  ownerSessions.set(token, { expiresAt: Date.now() + 30 * 60 * 1000 });
  res.json({ authenticated: true, token, expiresInMinutes: 30 });
}

function walkShortcuts(root, output, depth = 0) {
  if (depth > 5 || output.length >= 300) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (output.length >= 300) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkShortcuts(full, output, depth + 1);
    else if (entry.isFile() && /\.lnk$/i.test(entry.name)) output.push(full);
  }
}

function runPowerShell(script, timeoutMs = 10000, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command", script],
      { windowsHide: true, env: { ...process.env, ...extraEnv } }
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("PowerShell command timed out."));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
      if (stdout.length > 100000) child.kill();
    });
    child.stderr.on("data", (c) => {
      stderr += c;
      if (stderr.length > 20000) child.kill();
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr.trim() || `PowerShell exited with code ${code}`).slice(0, 500)));
      } else resolve(stdout.trim());
    });
  });
}

function ensureSetupCode() {
  if (ownerConfigured()) {
    setupCode = null;
    return;
  }
  if (!setupCode) setupCode = randomBytes(4).toString("hex").toUpperCase();
}

function findChrome() {
  const chromePaths = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
  ];
  return chromePaths.find((p) => fs.existsSync(p)) || null;
}

async function openUrlInChrome(url) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error("Google Chrome wasn't found.");
  await runPowerShell(
    "Start-Process -FilePath $env:JARVIS_CHROME_PATH -ArgumentList @('--new-tab', $env:JARVIS_URL)",
    10000,
    { JARVIS_CHROME_PATH: chromePath, JARVIS_URL: url }
  );
  return { opened: true, url, browser: "Google Chrome" };
}

/* ---------- TOOLS (model can request these; server validates) ---------- */

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "open_website",
      description: "Open an approved website in Chrome. Use for youtube, instagram, google, github, gmail, twitter/x.",
      parameters: {
        type: "object",
        properties: {
          site: { type: "string", description: "Key: youtube, instagram, google, github, gmail, twitter, x" }
        },
        required: ["site"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Open Google search results for a query in a new Chrome tab.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "launch_app",
      description: "Launch a Windows app by name after a recent scan. Prefer exact names from scan results.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "App display name to match" }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "system_status",
      description: "Read basic PC status (OS, CPU name, computer name).",
      parameters: { type: "object", properties: {} }
    }
  }
];

async function executeTool(name, args, ownerTokenPresent) {
  if (!ownerTokenPresent) {
    return { ok: false, error: "Owner mode required for computer actions. Ask the user to unlock Owner Mode." };
  }

  try {
    if (name === "open_website") {
      const key = String(args.site || "").trim().toLowerCase();
      const url = APPROVED_SITES[key];
      if (!url) {
        return {
          ok: false,
          error: `Site not approved. Allowed: ${Object.keys(APPROVED_SITES).join(", ")}`
        };
      }
      const result = await openUrlInChrome(url);
      return { ok: true, ...result, site: key };
    }

    if (name === "search_web") {
      const q = String(args.query || "").trim().slice(0, 200);
      if (!q) return { ok: false, error: "Empty search query." };
      const url = "https://www.google.com/search?q=" + encodeURIComponent(q);
      const result = await openUrlInChrome(url);
      return { ok: true, ...result, query: q };
    }

    if (name === "launch_app") {
      const want = String(args.name || "").trim().toLowerCase();
      if (!want) return { ok: false, error: "No app name given." };
      let match = null;
      for (const item of appScanResults.values()) {
        if (item.name.toLowerCase() === want) {
          match = item;
          break;
        }
      }
      if (!match) {
        for (const item of appScanResults.values()) {
          if (item.name.toLowerCase().includes(want)) {
            match = item;
            break;
          }
        }
      }
      if (!match) {
        return {
          ok: false,
          error: "App not found in latest scan. Ask the user to press SCAN first, then try again."
        };
      }

      if (match.type === "aumid") {
        await runPowerShell(
          'Start-Process -FilePath "explorer.exe" -ArgumentList @("shell:AppsFolder\\$env:JARVIS_APP_ID")',
          10000,
          { JARVIS_APP_ID: match.appId }
        );
      } else if (match.type === "shortcut" && match.path && fs.existsSync(match.path)) {
        await runPowerShell("Start-Process -FilePath $env:JARVIS_TARGET_PATH", 10000, {
          JARVIS_TARGET_PATH: match.path
        });
      } else {
        return { ok: false, error: "Unsupported launch type or missing shortcut." };
      }
      return { ok: true, launched: true, name: match.name };
    }

    if (name === "system_status") {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$os = Get-CimInstance Win32_OperatingSystem",
        "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1",
        "[PSCustomObject]@{ computerName = $env:COMPUTERNAME; os = $os.Caption; cpu = $cpu.Name } | ConvertTo-Json -Compress"
      ].join("\n");
      const output = await runPowerShell(script, 15000);
      return { ok: true, status: JSON.parse(output) };
    }

    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function parseToolCallsFromText(text) {
  // Fallback for models that emit JSON tool blocks instead of native tool_calls
  const calls = [];
  const re = /```tool\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj.name) calls.push({ function: { name: obj.name, arguments: JSON.stringify(obj.arguments || obj.args || {}) } });
    } catch {}
  }
  return calls;
}

app.use(express.json({ limit: "40kb" }));
app.use(express.static(path.join(__dirname, "public")));

function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

app.get("/api/health", (req, res) => {
  res.json({ status: "online", assistant: "JARVIS", database: "connected", model: MODEL });
});

app.get("/api/conversations", (req, res) => {
  const conversations = db
    .prepare(
      `
    SELECT c.id, c.title, c.created_at,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c ORDER BY c.id DESC LIMIT 100
  `
    )
    .all();
  res.json(conversations);
});

app.post("/api/conversations", (req, res) => {
  try {
    const result = db.prepare("INSERT INTO conversations (title) VALUES ('New conversation')").run();
    res.status(201).json({ id: Number(result.lastInsertRowid), title: "New conversation" });
  } catch (error) {
    res.status(500).json({ error: "Could not create a new conversation." });
  }
});

app.post("/api/apps/scan", requireOwner, async (req, res) => {
  try {
    const query =
      typeof req.body?.query === "string" ? req.body.query.trim().slice(0, 100).toLowerCase() : "";

    const startAppsOutput = await runPowerShell(
      "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress",
      20000
    );

    let registeredApps = [];
    if (startAppsOutput) {
      const parsed = JSON.parse(startAppsOutput);
      registeredApps = Array.isArray(parsed) ? parsed : [parsed];
    }

    const allApps = [];
    const seen = new Set();

    for (const item of registeredApps) {
      const name = String(item.Name || "").trim();
      const appId = String(item.AppID || "").trim();
      if (!name || !appId) continue;
      const id = createHash("sha256").update(`aumid:${appId}`).digest("hex").slice(0, 16);
      if (seen.has(id)) continue;
      seen.add(id);
      allApps.push({ id, name, type: "aumid", appId, source: "Windows registered app" });
    }

    const roots = [
      path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs"),
      path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
      path.join(os.homedir(), "Desktop"),
      path.join(os.homedir(), "OneDrive", "Desktop")
    ];

    const shortcuts = [];
    for (const root of [...new Set(roots)]) walkShortcuts(root, shortcuts);
    const uniqueShortcuts = [...new Set(shortcuts)];

    for (const fullPath of uniqueShortcuts) {
      const name = path.basename(fullPath, path.extname(fullPath));
      if (!name) continue;
      const id = createHash("sha256").update(`shortcut:${fullPath.toLowerCase()}`).digest("hex").slice(0, 16);
      if (seen.has(id)) continue;
      seen.add(id);
      allApps.push({ id, name, type: "shortcut", path: fullPath, source: "Desktop / Start Menu shortcut" });
    }

    const matches = query ? allApps.filter((i) => i.name.toLowerCase().includes(query)) : allApps;
    const visibleApps = matches.slice(0, 100);
    appScanResults.clear();
    for (const item of visibleApps) appScanResults.set(item.id, item);

    res.json({
      scannedShortcuts: uniqueShortcuts.length,
      registeredAppsFound: registeredApps.length,
      totalAppsFound: allApps.length,
      query,
      apps: visibleApps.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        source: item.source,
        canLaunch: true
      }))
    });
  } catch (error) {
    console.error("App scan failed:", error.message);
    res.status(500).json({ error: "App scan failed. Check that Windows PowerShell is available." });
  }
});

app.post("/api/apps/launch", requireOwner, async (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  const appItem = appScanResults.get(id);
  if (!appItem) {
    return res.status(400).json({ error: "That app wasn't found in the latest scan. Search again first." });
  }
  try {
    if (appItem.type === "aumid") {
      await runPowerShell(
        'Start-Process -FilePath "explorer.exe" -ArgumentList @("shell:AppsFolder\\$env:JARVIS_APP_ID")',
        10000,
        { JARVIS_APP_ID: appItem.appId }
      );
    } else if (appItem.type === "shortcut" && /\.lnk$/i.test(appItem.path) && fs.existsSync(appItem.path)) {
      await runPowerShell("Start-Process -FilePath $env:JARVIS_TARGET_PATH", 10000, {
        JARVIS_TARGET_PATH: appItem.path
      });
    } else {
      return res.status(400).json({ error: "This app entry has an unsupported launch type." });
    }
    res.json({ launched: true, name: appItem.name });
  } catch (error) {
    res.status(500).json({
      error: `Could not launch ${appItem.name}. It may have been removed or may not support this launch method.`
    });
  }
});

app.post("/api/websites/open", requireOwner, async (req, res) => {
  const site = String(req.body?.site || "").trim().toLowerCase();
  const url = APPROVED_SITES[site];
  if (!url) {
    return res.status(400).json({
      error: `Only approved sites: ${Object.keys(APPROVED_SITES).join(", ")}`
    });
  }
  try {
    const result = await openUrlInChrome(url);
    res.json({ opened: true, site, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/conversations/:id/messages", (req, res) => {
  const id = validId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid conversation ID." });
  const exists = db.prepare("SELECT id FROM conversations WHERE id = ?").get(id);
  if (!exists) return res.status(404).json({ error: "Conversation not found." });
  const messages = db
    .prepare(`SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id`)
    .all(id);
  res.json(messages);
});

app.patch("/api/conversations/:id", (req, res) => {
  const id = validId(req.params.id);
  const title = req.body?.title;
  if (!id) return res.status(400).json({ error: "Invalid conversation ID." });
  if (typeof title !== "string" || !title.trim() || title.trim().length > 100) {
    return res.status(400).json({ error: "Title must contain 1–100 characters." });
  }
  const result = db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title.trim(), id);
  if (!result.changes) return res.status(404).json({ error: "Conversation not found." });
  res.json({ id, title: title.trim() });
});

app.delete("/api/conversations/:id", (req, res) => {
  const id = validId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid conversation ID." });
  const result = db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  if (!result.changes) return res.status(404).json({ error: "Conversation not found." });
  res.json({ deleted: true, id });
});

app.get("/api/memories", (req, res) => {
  res.json(db.prepare(`SELECT id, content, category, created_at FROM memories ORDER BY id DESC`).all());
});

app.post("/api/memories", requireOwner, (req, res) => {
  const content = req.body?.content;
  const category = req.body?.category || "general";
  if (typeof content !== "string" || !content.trim() || content.trim().length > 2000) {
    return res.status(400).json({ error: "Memory must contain 1–2000 characters." });
  }
  const result = db
    .prepare("INSERT INTO memories (content, category) VALUES (?, ?)")
    .run(content.trim(), String(category).slice(0, 50));
  res.status(201).json({ id: Number(result.lastInsertRowid), content: content.trim(), category });
});

app.delete("/api/memories/:id", requireOwner, (req, res) => {
  const id = validId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid memory ID." });
  const result = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  if (!result.changes) return res.status(404).json({ error: "Memory not found." });
  res.json({ deleted: true, id });
});

app.get("/api/owner/status", (req, res) => {
  ensureSetupCode();
  res.json({
    configured: ownerConfigured(),
    authenticated: Boolean(getOwnerSession(req)),
    setupRequired: !ownerConfigured()
  });
});

app.post("/api/owner/register/options", async (req, res) => {
  try {
    if (ownerConfigured()) {
      return res.status(409).json({ error: "Owner authentication is already configured." });
    }
    ensureSetupCode();
    const provided = String(req.body?.setupCode || "").trim().toUpperCase();
    if (!setupCode || !safeEqual(provided, setupCode)) {
      return res.status(403).json({ error: "Invalid one-time setup code. Check the server terminal." });
    }
    const { generateRegistrationOptions } = await webauthn();
    const options = await generateRegistrationOptions({
      rpName: "JARVIS",
      rpID: RP_ID,
      userName: "Owner",
      userDisplayName: "JARVIS Owner",
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" }
    });
    pendingRegistration = { challenge: options.challenge, expiresAt: Date.now() + 5 * 60 * 1000 };
    res.json(options);
  } catch (error) {
    res.status(500).json({ error: "Could not prepare owner registration." });
  }
});

app.post("/api/owner/register/verify", async (req, res) => {
  try {
    if (!pendingRegistration || pendingRegistration.expiresAt < Date.now()) {
      pendingRegistration = null;
      return res.status(400).json({ error: "Registration expired. Try again." });
    }
    const { verifyRegistrationResponse } = await webauthn();
    const credentialBody = req.body?.credential || req.body;
    const verification = await verifyRegistrationResponse({
      response: credentialBody,
      expectedChallenge: pendingRegistration.challenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: "Windows Hello registration could not be verified." });
    }
    const credential = verification.registrationInfo.credential;
    db.prepare(
      `INSERT INTO owner_credentials (id, credential_id, public_key, counter, transports) VALUES (1, ?, ?, ?, ?)`
    ).run(
      credential.id,
      Buffer.from(credential.publicKey).toString("base64"),
      credential.counter,
      JSON.stringify(credential.transports || [])
    );
    pendingRegistration = null;
    setupCode = null;
    newOwnerSession(res);
  } catch (error) {
    res.status(500).json({ error: "Owner registration failed: " + error.message });
  }
});

app.post("/api/owner/login/options", async (req, res) => {
  try {
    if (!ownerConfigured()) {
      return res.status(400).json({ error: "Set up owner authentication first." });
    }
    const { generateAuthenticationOptions } = await webauthn();
    const credential = db
      .prepare("SELECT credential_id, transports FROM owner_credentials WHERE id = 1")
      .get();
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "required",
      allowCredentials: [
        { id: credential.credential_id, transports: JSON.parse(credential.transports || "[]") }
      ]
    });
    pendingAuthentication = { challenge: options.challenge, expiresAt: Date.now() + 5 * 60 * 1000 };
    res.json(options);
  } catch (error) {
    res.status(500).json({ error: "Could not prepare Windows Hello login." });
  }
});

app.post("/api/owner/login/verify", async (req, res) => {
  try {
    if (!pendingAuthentication || pendingAuthentication.expiresAt < Date.now()) {
      pendingAuthentication = null;
      return res.status(400).json({ error: "Authentication expired. Try again." });
    }
    const stored = db.prepare("SELECT * FROM owner_credentials WHERE id = 1").get();
    if (!stored) return res.status(400).json({ error: "Owner authentication is not configured." });
    const { verifyAuthenticationResponse } = await webauthn();
    const credentialBody = req.body?.credential || req.body;
    const verification = await verifyAuthenticationResponse({
      response: credentialBody,
      expectedChallenge: pendingAuthentication.challenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: stored.credential_id,
        publicKey: new Uint8Array(Buffer.from(stored.public_key, "base64")),
        counter: stored.counter,
        transports: JSON.parse(stored.transports || "[]")
      },
      requireUserVerification: true
    });
    pendingAuthentication = null;
    if (!verification.verified) return res.status(401).json({ error: "Owner authentication failed." });
    db.prepare("UPDATE owner_credentials SET counter = ? WHERE id = 1").run(
      verification.authenticationInfo.newCounter
    );
    newOwnerSession(res);
  } catch (error) {
    console.error("Login verification failed:", error);
    res.status(500).json({ error: "Login failed: " + error.message });
  }
});

app.post("/api/owner/logout", (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token) ownerSessions.delete(token);
  res.json({ locked: true });
});
app.post("/api/owner/lock", (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token) ownerSessions.delete(token);
  res.json({ locked: true });
});

/* Chat with optional tools + streaming */
app.post("/api/chat", async (req, res) => {
  const message = req.body?.text ?? req.body?.message;
  let conversationId = validId(req.body?.conversationId);
  const ownerTokenPresent = Boolean(getOwnerSession(req));

  if (typeof message !== "string" || !message.trim() || message.trim().length > 10000) {
    return res.status(400).json({ error: "Message must contain 1–10000 characters." });
  }

  const started = performance.now();

  try {
    if (!conversationId) {
      const created = db
        .prepare("INSERT INTO conversations (title) VALUES (?)")
        .run(message.trim().slice(0, 60));
      conversationId = Number(created.lastInsertRowid);
    }

    const conversation = db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversationId);
    if (!conversation) return res.status(404).json({ error: "Conversation not found." });

    db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)`).run(
      conversationId,
      message.trim()
    );

    const history = db
      .prepare(
        `SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 20`
      )
      .all(conversationId)
      .reverse();

    const memories = db.prepare(`SELECT content FROM memories ORDER BY id DESC LIMIT 20`).all();

    const systemPrompt = [
  "You are JARVIS, Tony Stark's local desktop assistant.",
  "Be concise, calm, and slightly formal. Address the user as sir when natural.",
  "CRITICAL STYLE RULES:",
  "- Never use Markdown. No asterisks, no bold, no bullet symbols like * or - for lists.",
  "- Do not use numbered lists with markdown. Write short plain sentences or simple lines.",
  "- No hashtags, no code fences, no emojis unless the user uses them first.",
  "- Sound spoken aloud: clear, direct, one idea at a time.",
  "CAPABILITIES:",
  "- Answer questions from knowledge.",
  "- Computer actions only via tools when Owner Mode is unlocked: open_website, search_web, launch_app, system_status, save_memory, list_memories.",
  "- Never claim you did an action unless a tool result says ok:true.",
  "Owner mode: " + (ownerTokenPresent ? "UNLOCKED" : "LOCKED — tell the user to unlock Owner Mode for PC actions."),
  "Approved sites: " + Object.keys(APPROVED_SITES).join(", ") + ".",
  memories.length
    ? "Saved memories:\n" + memories.map((m) => m.content).join("\n")
    : "No saved memories yet.",
].join("\n");

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders?.();

    const write = (obj) => res.write(JSON.stringify(obj) + "\n");

    async function callOllama(messages, useTools) {
      const body = {
        model: MODEL,
        stream: true,
        messages,
        options: { temperature: 0.5 }
      };
      // Many small models ignore tools; we still send them when supported
      if (useTools) body.tools = TOOL_DEFS;

      const ollamaResponse = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000)
      });
      if (!ollamaResponse.ok) {
        const detail = await ollamaResponse.text();
        throw new Error(`Ollama HTTP ${ollamaResponse.status}: ${detail.slice(0, 300)}`);
      }
      return ollamaResponse;
    }

    async function streamOllama(ollamaResponse) {
      let full = "";
      let nativeToolCalls = [];
      const reader = ollamaResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk;
          try {
            chunk = JSON.parse(line);
          } catch {
            continue;
          }
          const token = chunk.message?.content || "";
          if (token) {
            full += token;
            write({ token });
          }
          if (chunk.message?.tool_calls?.length) {
            nativeToolCalls = chunk.message.tool_calls;
          }
        }
      }
      if (buffer.trim()) {
        try {
          const chunk = JSON.parse(buffer);
          const token = chunk.message?.content || "";
          if (token) {
            full += token;
            write({ token });
          }
          if (chunk.message?.tool_calls?.length) nativeToolCalls = chunk.message.tool_calls;
        } catch {}
      }
      return { full, nativeToolCalls };
    }

    let messages = [{ role: "system", content: systemPrompt }, ...history];
    let ollamaResponse = await callOllama(messages, true);
    let { full, nativeToolCalls } = await streamOllama(ollamaResponse);

    let toolCalls = nativeToolCalls.length ? nativeToolCalls : parseToolCallsFromText(full);

    // One tool round (keeps latency low on small models)
    if (toolCalls.length) {
      for (const tc of toolCalls.slice(0, 3)) {
        const name = tc.function?.name || tc.name;
        let args = {};
        try {
          args =
            typeof tc.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments || "{}")
              : tc.function?.arguments || tc.arguments || {};
        } catch {
          args = {};
        }

        write({ token: `\n[Executing ${name}…]\n` });
        const result = await executeTool(name, args, ownerTokenPresent);
        write({
          token: result.ok
            ? `[Tool ${name} succeeded]\n`
            : `[Tool ${name} failed: ${result.error}]\n`
        });

        messages = [
          ...messages,
          { role: "assistant", content: full },
          {
            role: "user",
            content:
              `Tool result for ${name}:\n` +
              JSON.stringify(result) +
              "\nContinue as JARVIS. Only report success if ok is true. Be brief."
          }
        ];
      }

      ollamaResponse = await callOllama(messages, false);
      const second = await streamOllama(ollamaResponse);
      full = (full + "\n" + second.full).trim();
    }

    const answer = full.trim() || "Standing by, sir.";
    db.prepare(`INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`).run(
      conversationId,
      answer
    );

    write({
      done: true,
      conversationId,
      responseTimeMs: Math.round(performance.now() - started)
    });
    res.end();
  } catch (error) {
    console.error("Chat failed:", error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: "JARVIS couldn't get a response. Check that Ollama is running and the model is installed."
      });
    } else {
      res.write(
        JSON.stringify({
          error: "JARVIS couldn't finish. Check Ollama is running."
        }) + "\n"
      );
      res.end();
    }
  }
});

const ALLOWED_TERMINAL = {
  help: null,
  "system status": [
    "$ErrorActionPreference = 'Stop'",
    "$os = Get-CimInstance Win32_OperatingSystem",
    "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1",
    "[PSCustomObject]@{ computerName = $env:COMPUTERNAME; os = $os.Caption; cpu = $cpu.Name } | ConvertTo-Json -Compress"
  ].join("\n"),
  "list processes":
    "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 ProcessName, Id, CPU | ConvertTo-Json -Compress",
  "list files":
    "Get-ChildItem -LiteralPath $env:USERPROFILE -Force | Select-Object -First 30 Name, Mode, Length | ConvertTo-Json -Compress"
};

async function runOwnerTerminal(req, res) {
  const command = String(req.body?.command || "").trim().toLowerCase();
  if (command === "help" || command === "?") {
    return res.json({
      command: "help",
      output: "Approved: help, system status, list processes, list files\n"
    });
  }
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_TERMINAL, command) || !ALLOWED_TERMINAL[command]) {
    return res.status(400).json({ error: "Command not allowed. Type help." });
  }
  try {
    const output = await runPowerShell(ALLOWED_TERMINAL[command], 15000);
    res.json({ command, output: output.slice(0, 12000) });
  } catch (error) {
    res.status(500).json({ error: "The approved system command failed." });
  }
}

app.post("/api/owner/terminal", requireOwner, runOwnerTerminal);
app.post("/api/system/command", requireOwner, runOwnerTerminal);

app.get("/api/system/status", requireOwner, async (req, res) => {
  try {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$os = Get-CimInstance Win32_OperatingSystem",
      "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1",
      "$memory = Get-CimInstance Win32_ComputerSystem",
      "[PSCustomObject]@{",
      "  computerName = $env:COMPUTERNAME",
      "  os = $os.Caption",
      "  cpu = $cpu.Name",
      "  totalMemoryGB = [math]::Round($memory.TotalPhysicalMemory / 1GB, 2)",
      "} | ConvertTo-Json -Compress"
    ].join("\n");
    const output = await runPowerShell(script, 15000);
    res.json({ online: true, ...JSON.parse(output), ollamaModel: MODEL });
  } catch (error) {
    res.status(500).json({ error: "Could not retrieve system status." });
  }
});

app.use((err, req, res, next) => {
  console.error("Unhandled:", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

const FISH_API_KEY = process.env.FISH_API_KEY || "";
const FISH_VOICE_ID = process.env.FISH_VOICE_ID || "14129c3e320149449d6bada6862f7338";
const FISH_MODEL = process.env.FISH_MODEL || "s2.1-pro-free";

app.post("/api/tts", async (req, res) => {
  try {
    if (!FISH_API_KEY) {
      return res.status(503).json({
        error: "FISH_API_KEY is not set. Set it in the terminal before starting the server."
      });
    }

    const text = String(req.body?.text || "")
      .replace(/\[Executing[^\]]*\]/gi, "")
      .replace(/\[Tool[^\]]*\]/gi, "")
      .replace(/^JARVIS:\s*/i, "")
      .trim()
      .slice(0, 1000);

    if (!text) {
      return res.status(400).json({ error: "No text to speak." });
    }

    const fishRes = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FISH_API_KEY}`,
        "Content-Type": "application/json",
        model: FISH_MODEL
      },
      body: JSON.stringify({
        text,
        format: "mp3",
        reference_id: FISH_VOICE_ID
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!fishRes.ok) {
      const detail = await fishRes.text();
      console.error("Fish TTS failed:", fishRes.status, detail.slice(0, 300));
      return res.status(502).json({
        error: `Fish TTS failed (${fishRes.status}). Check key, model, or credits.`
      });
    }

    const buf = Buffer.from(await fishRes.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  } catch (error) {
    console.error("TTS route error:", error.message);
    res.status(500).json({ error: "TTS request failed." });
  }
});

app.listen(PORT, HOST, () => {
  ensureSetupCode();
  console.log(`JARVIS server running at http://${HOST}:${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log("Owner auth:", ownerConfigured() ? "configured" : "not configured");
  if (!ownerConfigured() && setupCode) {
    console.log(`ONE-TIME OWNER SETUP CODE: ${setupCode}`);
  }
});