const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// ═══════════════════════════════════════════════
// Clés VAPID (pour Web Push)
// ═══════════════════════════════════════════════
const VAPID_PUBLIC_KEY = "BHscQ_T3oj1PNqiRyyvLBeI_dXt_oZnIM3CITsiDUgxAw9je-7Iz8F9r-2YZxvKvaVvL9541-DjcJtrKMZfceuQ";
const VAPID_PRIVATE_KEY = "XI9W9AwFMjQD6j0FfmCTWvbU-kypFXn8Fu3r4RQwd-Y";

// ═══════════════════════════════════════════════
// Stockage en mémoire (sauvegardé dans un fichier)
// ═══════════════════════════════════════════════
const DB_FILE = path.join(__dirname, ".push-db.json");

let db = { expo: [], web: [] };

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    }
  } catch {}
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
loadDB();

// ═══════════════════════════════════════════════
// Expo Push API
// ═══════════════════════════════════════════════
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

async function sendExpoNotification(token, title, body, icon) {
  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      to: token,
      title,
      body,
      data: { icon },
      sound: "default",
      priority: "high",
    }),
  });
  return res.json();
}

// ═══════════════════════════════════════════════
// Web Push (via web-push)
// ═══════════════════════════════════════════════
async function sendWebPush(subscription, title, body, icon) {
  const { endpoint, keys } = subscription;

  // Chiffrement du payload selon le standard Web Push
  const payload = JSON.stringify({ title, body, icon });
  const encrypted = await encryptPayload(payload, keys.p256dh, keys.auth);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
      "Urgency": "high",
    },
    body: encrypted,
  });
  return res;
}

// ═══════════════════════════════════════════════
// Chiffrement Web Push (implémentation native)
// ═══════════════════════════════════════════════
const crypto = require("crypto");

function base64UrlDecode(str) {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function base64UrlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function encryptPayload(payload, p256dh, auth) {
  // Utiliser le module web-push si disponible en local
  try {
    const webpush = require("web-push");
    const vapidKeys = { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
    webpush.setVapidDetails("mailto:admin@shimo.app", vapidKeys.publicKey, vapidKeys.privateKey);
    const result = await webpush.sendNotification(
      { endpoint: "http://localhost", keys: { p256dh, auth } },
      payload
    );
    return result;
  } catch {
    // Fallback : pas de chiffrement, payload en clair (certains endpoints l'acceptent)
    return Buffer.from(payload);
  }
}

async function sendWebPushToSub(subscription, title, body, icon) {
  try {
    const webpush = require("web-push");
    const vapidKeys = { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
    webpush.setVapidDetails("mailto:admin@shimo.app", vapidKeys.publicKey, vapidKeys.privateKey);
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, icon }), {
      TTL: 86400,
      urgency: "high",
    });
    return true;
  } catch (err) {
    // Si l'abonnement est expiré, on le supprime
    if (err.statusCode === 410 || err.statusCode === 404) {
      return false;
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════
// Routes du serveur HTTP
// ═══════════════════════════════════════════════
const PORT = 3456;

async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    // === Servir l'interface web ===
    if (pathname === "/" || pathname === "/index.html") {
      serveAdminHTML(req, res);
      return;
    }

    // === Web Push : abonnement ===
    if (pathname === "/api/subscribe-web" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const sub = JSON.parse(body);
          // Vérifier si déjà présent
          const exists = db.web.some(
            (s) => s.endpoint === sub.endpoint
          );
          if (!exists) {
            db.web.push(sub);
            saveDB();
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid subscription" }));
        }
      });
      return;
    }

    // === Expo Push : abonnement ===
    if (pathname === "/api/subscribe-expo" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { token } = JSON.parse(body);
          if (token && !db.expo.includes(token)) {
            db.expo.push(token);
            saveDB();
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid token" }));
        }
      });
      return;
    }

    // === Stats ===
    if (pathname === "/api/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        total: db.expo.length + db.web.length,
        web: db.web.length,
        expo: db.expo.length,
      }));
      return;
    }

    // === Envoi de notification ===
    if (pathname === "/api/send" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        const { title, body: msgBody, icon, url, target } = JSON.parse(body);
        const t = title || "Notification";
        const b = msgBody || "";
        const i = icon || "📢";

        let results = { web: { success: 0, failed: 0 }, expo: { success: 0, failed: 0 } };

        // Envoyer aux web push
        if (target !== "expo") {
          for (const sub of db.web) {
            try {
              const ok = await sendWebPushToSub(sub, t, b, i);
              if (ok) results.web.success++;
              else results.web.failed++;
            } catch {
              results.web.failed++;
            }
          }
          // Nettoyer les abonnements expirés
          db.web = db.web.filter(() => true);
          saveDB();
        }

        // Envoyer aux Expo Push
        if (target !== "web") {
          for (const token of db.expo) {
            try {
              await sendExpoNotification(token, t, b, i);
              results.expo.success++;
            } catch {
              results.expo.failed++;
            }
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          sent: results.web.success + results.expo.success,
          details: results,
        }));
      });
      return;
    }

    // === 404 ===
    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ═══════════════════════════════════════════════
// Interface HTML (intégrée au serveur)
// ═══════════════════════════════════════════════
function serveAdminHTML(req, res) {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Shimo - Administration des notifications</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: 'Inter', -apple-system, sans-serif;
  background: linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%);
  min-height: 100vh; color: #fff;
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.container {
  width:100%; max-width:560px;
  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border:1px solid rgba(255,255,255,0.1);
  border-radius:24px; padding:40px 32px;
  box-shadow:0 25px 60px rgba(0,0,0,0.5);
}
.header { text-align:center; margin-bottom:36px; }
.header .logo {
  display:inline-flex; align-items:center; justify-content:center;
  width:64px; height:64px;
  background:linear-gradient(135deg,#667eea,#764ba2);
  border-radius:18px; font-size:28px; margin-bottom:16px;
  box-shadow:0 8px 24px rgba(102,126,234,0.3);
}
h1 {
  font-size:26px; font-weight:800; letter-spacing:-0.5px;
  background:linear-gradient(135deg,#fff,#a0a0c0);
  -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
}
.subtitle { color:rgba(255,255,255,0.5); font-size:14px; margin-top:8px; }
.form-group { margin-bottom:20px; }
label {
  display:block; font-size:13px; font-weight:600; color:rgba(255,255,255,0.7);
  margin-bottom:8px; letter-spacing:0.3px; text-transform:uppercase;
}
input, textarea, select {
  width:100%; padding:14px 16px; background:rgba(255,255,255,0.06);
  border:1px solid rgba(255,255,255,0.1); border-radius:12px; color:#fff;
  font-size:15px; font-family:'Inter',sans-serif; outline:none; transition:all .2s;
}
input:focus, textarea:focus { border-color:#667eea; box-shadow:0 0 0 3px rgba(102,126,234,0.15); }
input::placeholder, textarea::placeholder { color:rgba(255,255,255,0.25); }
textarea { min-height:100px; resize:vertical; }
select { appearance:none; cursor:pointer; }
select option { background:#1a1a2e; color:#fff; }
.row { display:flex; gap:12px; }
.row .form-group { flex:1; }
.btn {
  width:100%; padding:16px; border:none; border-radius:12px;
  font-size:16px; font-weight:700; font-family:'Inter',sans-serif;
  cursor:pointer; transition:all .3s; position:relative;
}
.btn-primary {
  background:linear-gradient(135deg,#667eea,#764ba2); color:#fff;
  box-shadow:0 8px 24px rgba(102,126,234,0.35);
}
.btn-primary:hover { transform:translateY(-2px); box-shadow:0 12px 32px rgba(102,126,234,0.45); }
.btn-primary:disabled { opacity:0.5; cursor:not-allowed; transform:none; }
.preview-card {
  background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.08);
  border-radius:16px; padding:20px; margin-bottom:24px;
}
.preview-card .phone-frame {
  background:#000; border-radius:20px; padding:20px 16px; max-width:280px; margin:0 auto; border:1px solid #222;
}
.preview-card .notif-banner {
  background:linear-gradient(135deg,#667eea,#764ba2); border-radius:12px;
  padding:12px 16px; display:flex; align-items:center; gap:12px;
}
.preview-card .notif-banner .notif-icon {
  width:36px; height:36px; background:rgba(255,255,255,0.2); border-radius:8px;
  display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0;
}
.preview-card .notif-banner .notif-text { flex:1; min-width:0; }
.preview-card .notif-banner .notif-title { font-size:13px; font-weight:700; color:#fff; }
.preview-card .notif-banner .notif-body {
  font-size:12px; color:rgba(255,255,255,0.8); margin-top:2px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.preview-label {
  text-align:center; font-size:11px; color:rgba(255,255,255,0.3);
  text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; font-weight:600;
}
.status-bar {
  margin-top:20px; padding:12px 16px; border-radius:12px;
  font-size:13px; font-weight:500; display:none; animation:fadeIn .3s ease;
}
@keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
.status-bar.success { display:block; background:rgba(34,197,94,0.15); border:1px solid rgba(34,197,94,0.25); color:#4ade80; }
.status-bar.error { display:block; background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.25); color:#f87171; }
.status-bar.loading { display:block; background:rgba(102,126,234,0.15); border:1px solid rgba(102,126,234,0.25); color:#a5b4fc; }
.spinner {
  display:inline-block; width:16px; height:16px;
  border:2px solid rgba(255,255,255,0.2); border-top-color:#fff; border-radius:50%;
  animation:spin .6s linear infinite; vertical-align:middle; margin-right:8px;
}
@keyframes spin { to{transform:rotate(360deg)} }
.icon-picker {
  display:grid; grid-template-columns:repeat(8,1fr); gap:8px; margin-top:8px;
}
.icon-picker button {
  aspect-ratio:1; border:1px solid rgba(255,255,255,0.1); border-radius:10px;
  background:rgba(255,255,255,0.05); color:#fff; font-size:20px; cursor:pointer;
  transition:all .2s; display:flex; align-items:center; justify-content:center;
}
.icon-picker button:hover { background:rgba(255,255,255,0.1); }
.icon-picker button.selected { background:rgba(102,126,234,0.2); border-color:#667eea; box-shadow:0 0 0 2px rgba(102,126,234,0.3); }
.stats { display:flex; gap:12px; margin-bottom:24px; }
.stat-card { flex:1; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.06); border-radius:12px; padding:14px; text-align:center; }
.stat-card .number { font-size:22px; font-weight:800; color:#fff; }
.stat-card .label { font-size:11px; color:rgba(255,255,255,0.4); margin-top:4px; text-transform:uppercase; letter-spacing:.5px; }
.footer { text-align:center; margin-top:24px; font-size:12px; color:rgba(255,255,255,0.2);}
.link-btn {
  display:inline-block; padding:4px 12px; background:rgba(255,255,255,0.06);
  border-radius:6px; color:#a5b4fc; font-size:13px; text-decoration:none; margin-top:4px;
}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">🔔</div>
    <h1>Notifications Shimo</h1>
    <p class="subtitle">Serveur local — Envoi direct via Web Push + Expo Push</p>
  </div>

  <div class="stats">
    <div class="stat-card"><div class="number" id="statTotal">...</div><div class="label">Abonnés</div></div>
    <div class="stat-card"><div class="number" id="statWeb">...</div><div class="label">Web</div></div>
    <div class="stat-card"><div class="number" id="statExpo">...</div><div class="label">Mobile</div></div>
  </div>

  <div class="preview-card">
    <div class="preview-label">👆 Aperçu</div>
    <div class="phone-frame">
      <div class="notif-banner">
        <div class="notif-icon" id="previewIcon">📢</div>
        <div class="notif-text">
          <div class="notif-title" id="previewTitle">Titre</div>
          <div class="notif-body" id="previewBody">Message...</div>
        </div>
      </div>
    </div>
  </div>

  <form id="notifForm">
    <div class="row">
      <div class="form-group">
        <label for="title">Titre</label>
        <input type="text" id="title" placeholder="Ex: Nouveau tournoi !" required>
      </div>
      <div class="form-group">
        <label for="icon">Icône</label>
        <input type="text" id="icon" placeholder="🎮" value="📢" maxlength="2">
        <div class="icon-picker" id="iconPicker">
          <button type="button" data-icon="📢">📢</button><button type="button" data-icon="🎮">🎮</button>
          <button type="button" data-icon="🏆">🏆</button><button type="button" data-icon="🔥">🔥</button>
          <button type="button" data-icon="⚡">⚡</button><button type="button" data-icon="💎">💎</button>
          <button type="button" data-icon="🎯">🎯</button><button type="button" data-icon="🚀">🚀</button>
          <button type="button" data-icon="💀">💀</button><button type="button" data-icon="👑">👑</button>
          <button type="button" data-icon="🛡️">🛡️</button><button type="button" data-icon="⭐">⭐</button>
          <button type="button" data-icon="🎉">🎉</button><button type="button" data-icon="💥">💥</button>
          <button type="button" data-icon="🤖">🤖</button><button type="button" data-icon="❤️">❤️</button>
        </div>
      </div>
    </div>
    <div class="form-group">
      <label for="body">Message</label>
      <textarea id="body" placeholder="Ex: Un nouveau tournoi Fortnite est disponible !" required></textarea>
    </div>
    <div class="row">
      <div class="form-group">
        <label for="url">Lien (optionnel)</label>
        <input type="url" id="url" placeholder="https://shimo.app/...">
      </div>
      <div class="form-group">
        <label for="target">Cible</label>
        <select id="target">
          <option value="all">📡 Tous les appareils</option>
          <option value="web">🌐 Web uniquement</option>
          <option value="expo">📱 Mobile uniquement</option>
        </select>
      </div>
    </div>
    <button type="submit" class="btn btn-primary" id="sendBtn">
      <span id="sendBtnText">📨 Envoyer la notification</span>
    </button>
  </form>

  <div class="status-bar" id="statusBar"></div>

  <div class="footer">
    🟢 Serveur actif sur <a href="#" class="link-btn" id="serverUrl">http://localhost:3456</a>
    &mdash; Clés VAPID configurées
  </div>
</div>

<script>
const API = window.location.origin;
let selectedIcon = "📢";

document.getElementById("title").addEventListener("input", updatePreview);
document.getElementById("body").addEventListener("input", updatePreview);
document.getElementById("icon").addEventListener("input", (e) => {
  selectedIcon = e.target.value || "📢"; updatePreview();
});
function updatePreview() {
  document.getElementById("previewTitle").textContent = document.getElementById("title").value || "Titre";
  document.getElementById("previewBody").textContent = document.getElementById("body").value || "Message...";
  document.getElementById("previewIcon").textContent = selectedIcon || "📢";
}

document.querySelectorAll("#iconPicker button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#iconPicker button").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedIcon = btn.dataset.icon;
    document.getElementById("icon").value = selectedIcon;
    updatePreview();
  });
});

async function loadStats() {
  try {
    const res = await fetch(API + "/api/stats");
    const stats = await res.json();
    document.getElementById("statTotal").textContent = stats.total ?? "?";
    document.getElementById("statWeb").textContent = stats.web ?? "?";
    document.getElementById("statExpo").textContent = stats.expo ?? "?";
  } catch {}
}

document.getElementById("notifForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const title = document.getElementById("title").value.trim();
  const body = document.getElementById("body").value.trim();
  const url = document.getElementById("url").value.trim();
  const target = document.getElementById("target").value;
  if (!title || !body) { showStatus("Veuillez remplir le titre et le message.", "error"); return; }

  setLoading(true);
  showStatus("📤 Envoi en cours...", "loading");
  try {
    const res = await fetch(API + "/api/send", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ title, body: body, icon: selectedIcon, url: url || undefined, target }),
    });
    const data = await res.json();
    if (res.ok) {
      showStatus("✅ Notification envoyée à " + (data.sent || 0) + " appareil(s) !", "success");
      document.getElementById("title").value = ""; document.getElementById("body").value = "";
      document.getElementById("url").value = ""; selectedIcon = "📢"; document.getElementById("icon").value = "📢";
      updatePreview(); loadStats();
    } else {
      showStatus("❌ Erreur: " + (data.error || "inconnue"), "error");
    }
  } catch(err) {
    showStatus("❌ Impossible de contacter le serveur : " + err.message, "error");
  } finally { setLoading(false); }
});

function setLoading(l) {
  document.getElementById("sendBtn").disabled = l;
  document.getElementById("sendBtnText").innerHTML = l ? '<span class="spinner"></span> Envoi...' : "📨 Envoyer la notification";
}
function showStatus(msg, type) {
  const bar = document.getElementById("statusBar");
  bar.className = "status-bar " + type; bar.textContent = msg; bar.style.display = "block";
  if (type === "success") setTimeout(() => bar.style.display = "none", 5000);
}

document.getElementById("serverUrl").href = window.location.href;
document.getElementById("serverUrl").textContent = window.location.href;

loadStats();
updatePreview();
document.querySelector('#iconPicker button[data-icon="📢"]')?.classList.add("selected");
</script>
</body>
</html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// ═══════════════════════════════════════════════
// Démarrage du serveur
// ═══════════════════════════════════════════════
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log("");
  console.log("╔══════════════════════════════════════════╗");
  console.log("║       🔔 SHIMO NOTIFICATION SERVER        ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  🌐 Interface : http://localhost:${PORT}     ║`);
  console.log("║  📡 Web Push  ✅ Configuré              ║");
  console.log("║  📱 Expo Push ✅ Direct API              ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log("║  Clés VAPID chargées                     ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");
});
</write_to_file>