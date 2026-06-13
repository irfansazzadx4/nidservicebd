/**
 * NID Service Bot - WhatsApp Cloud API
 * ✅ Caption আলাদা text message, PDF আলাদা document
 * ✅ Arial + Bangla font via pdf-server
 * ✅ Pro Admin Panel UI
 */

const express = require("express");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");
const FormData = require("form-data");

// ========== CONFIG ==========
const CONFIG = {
  PORT: process.env.PORT || 3000,
  ADMIN_PASS: process.env.ADMIN_PASS || "admin123",

  WA_TOKEN:        process.env.WHATSAPP_TOKEN,
  WA_PHONE_ID:     process.env.WHATSAPP_PHONE_ID,
  WA_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || "myVerifyToken123",
  WA_API_VERSION:  "v21.0",

  API_EXTRACT_URL: "https://onlinebd.kesug.com/Signtonid_api_one.php",
  API_GENERATE_URL:"https://onlinebd.kesug.com/bot/nid-bn.php",
  PDF_API_URL:     process.env.PDF_API_URL,
  PDF_API_SECRET:  process.env.PDF_API_SECRET,

  BASE_URL:    process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || "https://nidservicebd.onrender.com",
  STORAGE_DIR: path.join(__dirname, "storage"),
  DATA_DIR:    path.join(__dirname, "data"),

  MONGO_URI: process.env.MONGO_URI,
};

if (!fs.existsSync(CONFIG.STORAGE_DIR)) fs.mkdirSync(CONFIG.STORAGE_DIR, { recursive: true });
if (!fs.existsSync(CONFIG.DATA_DIR))    fs.mkdirSync(CONFIG.DATA_DIR,    { recursive: true });

const USERS_FILE    = path.join(CONFIG.DATA_DIR, "users.json");
const STATS_FILE    = path.join(CONFIG.DATA_DIR, "stats.json");
const SETTINGS_FILE = path.join(CONFIG.DATA_DIR, "settings.json");

// ========== HELPERS ==========
const loadJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
const saveJSON = (f, d)   => fs.writeFileSync(f, JSON.stringify(d, null, 2));

const getUsers    = () => loadJSON(USERS_FILE,    []);
const saveUsers   = (u) => saveJSON(USERS_FILE,   u);
const getStats    = () => loadJSON(STATS_FILE,    {});
const saveStats   = (s) => saveJSON(STATS_FILE,   s);
const getSettings = () => loadJSON(SETTINGS_FILE, { cardPrice: 0 });
const saveSettings= (s) => saveJSON(SETTINGS_FILE, s);

function normalizeNumber(num) {
  let n = String(num).replace(/\D/g, "");
  if (n.startsWith("0")) n = "880" + n.slice(1);
  if (!n.startsWith("880") && n.length === 10) n = "880" + n;
  return n;
}

function isAllowed(number) {
  const users = getUsers();
  if (users.length === 0) return false;
  const u = users.find(x => normalizeNumber(x.number) === normalizeNumber(number));
  return u && u.active !== false;
}

function getUserBalance(number) {
  const u = getUsers().find(x => normalizeNumber(x.number) === normalizeNumber(number));
  return u ? (u.balance || 0) : 0;
}

function deductBalance(number) {
  const users = getUsers();
  const price = getSettings().cardPrice || 0;
  const idx   = users.findIndex(x => normalizeNumber(x.number) === normalizeNumber(number));
  if (idx === -1) return false;
  if ((users[idx].balance || 0) < price) return false;
  users[idx].balance = (users[idx].balance || 0) - price;
  saveUsers(users);
  return true;
}

function recordStat(number) {
  const stats = getStats();
  const key   = normalizeNumber(number);
  if (!stats[key]) stats[key] = { count: 0, lastUsed: null };
  stats[key].count++;
  stats[key].lastUsed = new Date().toISOString();
  saveStats(stats);
}

// ========== MONGODB ==========
let mongoClient = null;

async function getMongoClient() {
  if (mongoClient) return mongoClient;
  if (!CONFIG.MONGO_URI) return null;
  try {
    const { MongoClient } = require("mongodb");
    mongoClient = new MongoClient(CONFIG.MONGO_URI);
    await mongoClient.connect();
    console.log("✅ MongoDB connected");
    return mongoClient;
  } catch (e) {
    console.error("MongoDB connect error:", e.message);
    return null;
  }
}

async function saveToMongo(collection, key, data) {
  try {
    const client = await getMongoClient();
    if (!client) return;
    await client.db("nidbot").collection(collection)
      .replaceOne({ _id: key }, { _id: key, data }, { upsert: true });
  } catch (e) { console.error("MongoDB save error:", e.message); }
}

async function loadFromMongo(collection, key) {
  try {
    const client = await getMongoClient();
    if (!client) return null;
    const doc = await client.db("nidbot").collection(collection).findOne({ _id: key });
    return doc ? doc.data : null;
  } catch (e) { return null; }
}

async function backupData() {
  try {
    await Promise.all([
      saveToMongo("backups", "users",    getUsers()),
      saveToMongo("backups", "stats",    getStats()),
      saveToMongo("backups", "settings", getSettings()),
    ]);
    console.log("✅ MongoDB backup done");
  } catch (e) { console.error("Backup error:", e.message); }
}

async function restoreData() {
  try {
    const [users, stats, settings] = await Promise.all([
      loadFromMongo("backups", "users"),
      loadFromMongo("backups", "stats"),
      loadFromMongo("backups", "settings"),
    ]);
    if (users    && !fs.existsSync(USERS_FILE))    saveUsers(users);
    if (stats    && !fs.existsSync(STATS_FILE))    saveStats(stats);
    if (settings && !fs.existsSync(SETTINGS_FILE)) saveSettings(settings);
    if (users || stats || settings) console.log("✅ Data restored from MongoDB");
    else console.log("ℹ️ No MongoDB data — starting fresh");
  } catch (e) { console.error("Restore error:", e.message); }
}

// ========== WHATSAPP API ==========
const WA_BASE    = () => `https://graph.facebook.com/${CONFIG.WA_API_VERSION}/${CONFIG.WA_PHONE_ID}`;
const WA_HEADERS = () => ({ Authorization: `Bearer ${CONFIG.WA_TOKEN}`, "Content-Type": "application/json" });

async function sendText(to, body) {
  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body }
    }, { headers: WA_HEADERS() });
  } catch (e) { console.error("sendText error:", e.response?.data || e.message); }
}

async function markRead(messageId) {
  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp", status: "read", message_id: messageId
    }, { headers: WA_HEADERS() });
  } catch {}
}

async function uploadMedia(buffer, filename, mimetype) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mimetype });
  form.append("type", mimetype);
  const res = await axios.post(`${WA_BASE()}/media`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${CONFIG.WA_TOKEN}` },
    maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  return res.data.id;
}

// ✅ PDF শুধু document হিসেবে পাঠাও, caption ছাড়া
async function sendDocument(to, mediaId, filename) {
  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp", to, type: "document",
      document: { id: mediaId, filename }
    }, { headers: WA_HEADERS() });
  } catch (e) { console.error("sendDocument error:", e.response?.data || e.message); }
}

async function downloadMedia(mediaId) {
  const meta = await axios.get(
    `https://graph.facebook.com/${CONFIG.WA_API_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` } }
  );
  const fileRes = await axios.get(meta.data.url, {
    headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` },
    responseType: "arraybuffer",
  });
  return { buffer: Buffer.from(fileRes.data), mimetype: meta.data.mime_type };
}

// ========== NID EXTRACTION ==========
function mapAPIData(d) {
  return {
    nid:         d.nationalId || d.nid || d.NID || d.national_id || "",
    pin:         d.pin || "",
    pin_status:  "disabled",
    nameBangla:  d.nameBangla || d.name_bn || "",
    nameEnglish: d.nameEnglish || d.name_en || "",
    dob:         d.dateOfBirth || d.dob || "",
    nameFather:  d.fatherName || d.father_name || "",
    nameMother:  d.motherName || d.mother_name || "",
    fulladdress: d.address || d.permanent_address || "",
    birthPlace:  d.birthPlace || d.birth_place || "",
    bloodGroup:  d.bloodGroup || d.blood_group || "",
    issueDate:   d.dateOfToday || "",
    imageUrl12:  d.userIMG || d.imageUrl12 || "",
    imageUrl22:  d.signIMG || d.imageUrl22 || "",
  };
}

async function extractNIDFromPDF(buffer) {
  const form = new FormData();
  form.append("pdf", buffer, { filename: "nid.pdf", contentType: "application/pdf" });
  try {
    const res = await axios.post(CONFIG.API_EXTRACT_URL, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 60000,
    });
    console.log("📦 API Response:", JSON.stringify(res.data).slice(0, 200));
    const raw    = res.data?.data ? res.data.data : res.data;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return mapAPIData(parsed);
  } catch (err) {
    console.error("❌ Extract API failed:", err.response?.status, err.message);
    throw new Error("Extract API: " + (err.response?.data?.message || err.message));
  }
}

// ========== PATH FIX ==========
function fixRelativePaths(html) {
  const BASE = "https://onlinebd.kesug.com/bot";
  const patterns = [
    [/(src\s*=\s*["'])(assets\/)/gi,   `$1${BASE}/assets/`],
    [/(href\s*=\s*["'])(assets\/)/gi,  `$1${BASE}/assets/`],
    [/(src\s*=\s*["'])(photo\/)/gi,    `$1${BASE}/photo/`],
    [/(url\s*\(\s*["']?)(assets\/)/gi, `$1${BASE}/assets/`],
    [/(url\s*\(\s*["']?)(photo\/)/gi,  `$1${BASE}/photo/`],
    [/(url\s*\(\s*["']?)(\/fonts\/)/gi,`$1https://onlinebd.kesug.com/fonts/`],
  ];
  for (const [r, rep] of patterns) html = html.replace(r, rep);
  return html;
}

async function fetchHTMLFromData(data) {
  const params = new URLSearchParams();
  Object.entries(data).forEach(([k, v]) => params.append(k, v || ""));
  const res = await axios.post(CONFIG.API_GENERATE_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 60000,
  });
  return fixRelativePaths(res.data);
}

async function buildAndSaveHTML(data) {
  const html     = await fetchHTMLFromData(data);
  const filename = `nid_${data.nid || Date.now()}_${Date.now()}.html`;
  const filepath = path.join(CONFIG.STORAGE_DIR, filename);
  fs.writeFileSync(filepath, html);
  setTimeout(() => { fs.unlink(filepath, () => {}); }, 10 * 60 * 1000);
  return `${CONFIG.BASE_URL}/storage/${filename}`;
}

async function generatePDF(data) {
  const html = await fetchHTMLFromData(data);
  // Font embed pdf-server এ হয়, এখানে plain HTML পাঠাও
  const res = await axios.post(`${CONFIG.PDF_API_URL}/pdf`, {
    secret: CONFIG.PDF_API_SECRET,
    html,
  }, { timeout: 90000 });
  const base64 = res.data.pdf || res.data.base64 || res.data;
  return Buffer.from(base64, "base64");
}

// ========== MESSAGE HANDLER ==========
async function handleIncoming(msg, contact) {
  const from  = msg.from;
  const msgId = msg.id;
  markRead(msgId);

  if (msg.type === "text") {
    const text = msg.text.body.trim().toLowerCase();

    if (text === ".ping" || text === "ping") {
      return sendText(from, "🟢 Pong! Bot সচল আছে।");
    }

    if (text === ".status" || text === "status") {
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      const bal   = getUserBalance(from);
      const price = getSettings().cardPrice || 0;
      return sendText(from,
        `✅ আপনি authorized।\n💰 Balance: ${bal} টাকা\n💳 Card Price: ${price} টাকা`
      );
    }

    return sendText(from,
      "📄 NID Card বানাতে আপনার NID PDF টা এই chat এ পাঠান।\n\nCommands:\n.ping - bot check\n.status - balance check"
    );
  }

  if (msg.type === "document") {
    const doc = msg.document;
    if (!doc.mime_type?.includes("pdf")) {
      return sendText(from, "❌ শুধু PDF file পাঠাতে হবে।");
    }
    if (!isAllowed(from)) {
      return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");
    }

    const price = getSettings().cardPrice || 0;
    if (price > 0 && getUserBalance(from) < price) {
      return sendText(from,
        `❌ Balance কম! কমপক্ষে ${price} টাকা থাকতে হবে।\nCurrent balance: ${getUserBalance(from)} টাকা`
      );
    }

    await sendText(from, "⏳ আপনার NID PDF process হচ্ছে... একটু wait করুন।");

    try {
      const { buffer: pdfBuf } = await downloadMedia(doc.id);
      const data = await extractNIDFromPDF(pdfBuf);
      if (!data.nid) throw new Error("NID extract করতে পারিনি");

      if (price > 0) deductBalance(from);

      const [htmlUrl, pdfBuffer] = await Promise.all([
        buildAndSaveHTML(data),
        generatePDF(data),
      ]);

      recordStat(from);
      backupData();

      // ✅ Caption আলাদা text message
      const captionLines = [
        `✅ আপনার NID Card তৈরি হয়েছে!`,
        ``,
        `👤 নাম: ${data.nameBangla || data.nameEnglish}`,
        `🆔 NID: ${data.nid}`,
        `🎂 DOB: ${data.dob}`,
        price > 0 ? `💰 Remaining Balance: ${getUserBalance(from)} টাকা` : "",
        `🖨️ Print করতে (১০ মিনিট): ${htmlUrl}`,
      ].filter(Boolean).join("\n");

      await sendText(from, captionLines);

      // ✅ PDF আলাদা document (caption ছাড়া)
      const safeName = (data.nameEnglish || data.nameBangla || "NID").replace(/[/\\?%*:|"<>]/g, "").trim();
      const filename = `nid-${data.nid}.pdf`;
      const mediaId  = await uploadMedia(pdfBuffer, filename, "application/pdf");
      await sendDocument(from, mediaId, filename);

    } catch (err) {
      console.error("Process error:", err.message);
      await sendText(from, `❌ Error: ${err.message}\nআবার চেষ্টা করুন বা admin কে জানান।`);
    }
  }
}

// ========== EXPRESS ==========
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === CONFIG.WA_VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const entry    = req.body.entry?.[0];
    const change   = entry?.changes?.[0]?.value;
    const messages = change?.messages || [];
    const contacts = change?.contacts || [];
    for (const msg of messages) await handleIncoming(msg, contacts[0]);
  } catch (e) { console.error("Webhook error:", e.message); }
});

app.get("/privacy", (_, res) => res.send(`<html><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;"><h1>Privacy Policy</h1><p>NID Service Bot processes NID PDFs temporarily and does not store personal data permanently.</p></body></html>`));
app.use("/storage", express.static(CONFIG.STORAGE_DIR));
app.get("/", (_, res) => res.send("✅ NID Bot is running"));

// ========== ADMIN PANEL ==========
const adminSessions = new Set();

function adminAuth(req, res, next) {
  const sess = (req.headers.cookie || "").split(";").map(s => s.trim())
    .find(s => s.startsWith("admin_sess="))?.split("=")[1];
  if (sess && adminSessions.has(sess)) return next();
  res.redirect("/admin/login");
}

const ADMIN_CSS = `
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    --primary: #4f46e5;
    --primary-dark: #4338ca;
    --success: #10b981;
    --danger: #ef4444;
    --warning: #f59e0b;
    --bg: #f1f5f9;
    --card: #ffffff;
    --text: #1e293b;
    --muted: #64748b;
    --border: #e2e8f0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  .topbar { background: var(--primary); color: #fff; padding: 0 24px; height: 56px; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 2px 8px rgba(79,70,229,.3); position: sticky; top: 0; z-index: 100; }
  .topbar h1 { font-size: 18px; font-weight: 700; letter-spacing: -.3px; }
  .topbar a { color: rgba(255,255,255,.8); text-decoration: none; font-size: 13px; padding: 6px 14px; border: 1px solid rgba(255,255,255,.3); border-radius: 6px; transition: all .2s; }
  .topbar a:hover { background: rgba(255,255,255,.15); color: #fff; }
  .wrap { max-width: 1300px; margin: 0 auto; padding: 24px 20px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: var(--card); border-radius: 12px; padding: 18px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.07); border: 1px solid var(--border); }
  .stat-card .label { font-size: 12px; color: var(--muted); font-weight: 500; text-transform: uppercase; letter-spacing: .5px; }
  .stat-card .value { font-size: 28px; font-weight: 700; margin-top: 4px; color: var(--primary); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  @media(max-width:700px) { .grid2 { grid-template-columns: 1fr; } }
  .card { background: var(--card); border-radius: 12px; padding: 20px 24px; box-shadow: 0 1px 3px rgba(0,0,0,.07); border: 1px solid var(--border); margin-bottom: 16px; }
  .card h3 { font-size: 14px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 14px; }
  .form-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  input[type=text], input[type=password], input[type=number], select {
    border: 1.5px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 13px; color: var(--text);
    background: #fff; outline: none; transition: border .2s;
  }
  input:focus, select:focus { border-color: var(--primary); }
  input[placeholder] { min-width: 160px; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 0; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .2s; }
  .btn-primary { background: var(--primary); color: #fff; }
  .btn-primary:hover { background: var(--primary-dark); }
  .btn-success { background: var(--success); color: #fff; }
  .btn-success:hover { background: #059669; }
  .btn-danger  { background: var(--danger);  color: #fff; }
  .btn-danger:hover  { background: #dc2626; }
  .btn-warning { background: var(--warning); color: #fff; }
  .btn-warning:hover { background: #d97706; }
  .btn-ghost { background: var(--border); color: var(--text); }
  .btn-ghost:hover { background: #cbd5e1; }
  .btn-teal { background: #0891b2; color: #fff; }
  .btn-teal:hover { background: #0e7490; }
  .section-title { font-size: 16px; font-weight: 700; color: var(--text); margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th { background: #f8fafc; color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: .5px; padding: 10px 12px; text-align: left; border-bottom: 2px solid var(--border); }
  tbody td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: #f8fafc; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
  .badge-green  { background: #d1fae5; color: #065f46; }
  .badge-red    { background: #fee2e2; color: #991b1b; }
  .badge-blue   { background: #dbeafe; color: #1e40af; }
  .badge-yellow { background: #fef3c7; color: #92400e; }
  .action-row { display: flex; gap: 4px; flex-wrap: wrap; }
  .bal-positive { color: var(--success); font-weight: 700; }
  .bal-negative { color: var(--danger);  font-weight: 700; }
  .mongo-ok  { background: #d1fae5; color: #065f46; padding: 6px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; }
  .mongo-err { background: #fee2e2; color: #991b1b; padding: 6px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; }
  .login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); }
  .login-box { background: var(--card); border-radius: 16px; padding: 40px; width: 100%; max-width: 380px; box-shadow: 0 4px 24px rgba(0,0,0,.1); }
  .login-box h2 { font-size: 22px; font-weight: 700; margin-bottom: 24px; color: var(--text); }
  .login-box input { width: 100%; margin-bottom: 12px; }
  .login-box .btn { width: 100%; justify-content: center; padding: 10px; font-size: 15px; }
</style>`;

app.get("/admin/login", (_, res) => {
  res.send(`<html><head>${ADMIN_CSS}</head><body>
  <div class="login-wrap">
    <div class="login-box">
      <h2>🔐 NID Bot Admin</h2>
      <form method="POST" action="/admin/login">
        <input name="password" type="password" placeholder="Password" required/>
        <button class="btn btn-primary">Login →</button>
      </form>
    </div>
  </div>
  </body></html>`);
});

app.post("/admin/login", (req, res) => {
  if (req.body.password === CONFIG.ADMIN_PASS) {
    const tok = crypto.randomBytes(16).toString("hex");
    adminSessions.add(tok);
    res.setHeader("Set-Cookie", `admin_sess=${tok}; HttpOnly; Path=/; Max-Age=86400`);
    return res.redirect("/admin");
  }
  res.send(`<html><head>${ADMIN_CSS}</head><body>
  <div class="login-wrap">
    <div class="login-box">
      <h2>🔐 NID Bot Admin</h2>
      <p style="color:var(--danger);margin-bottom:12px;font-size:13px;">❌ Wrong password</p>
      <form method="POST" action="/admin/login">
        <input name="password" type="password" placeholder="Password" required/>
        <button class="btn btn-primary">Login →</button>
      </form>
    </div>
  </div></body></html>`);
});

app.get("/admin/logout", (req, res) => {
  const c = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("admin_sess="));
  if (c) adminSessions.delete(c.split("=")[1]);
  res.setHeader("Set-Cookie", "admin_sess=; Max-Age=0; Path=/");
  res.redirect("/admin/login");
});

app.get("/admin", adminAuth, (req, res) => {
  const users    = getUsers();
  const stats    = getStats();
  const settings = getSettings();

  const totalCards   = Object.values(stats).reduce((s, x) => s + (x.count || 0), 0);
  const totalBalance = users.reduce((s, u) => s + (u.balance || 0), 0);
  const activeUsers  = users.filter(u => u.active !== false).length;
  const mongoOK      = !!CONFIG.MONGO_URI;

  const rows = users.map(u => {
    const s   = stats[normalizeNumber(u.number)] || { count: 0, lastUsed: "—" };
    const bal = u.balance || 0;
    const lastUsed = s.lastUsed ? new Date(s.lastUsed).toLocaleString("en-BD", { timeZone: "Asia/Dhaka", hour12: true, dateStyle: "short", timeStyle: "short" }) : "—";
    return `<tr>
      <td style="font-weight:600">${u.number}</td>
      <td>${u.name || "<span style='color:var(--muted)'>—</span>"}</td>
      <td class="${bal >= 0 ? "bal-positive" : "bal-negative"}">${bal} ৳</td>
      <td><span class="badge ${u.active !== false ? "badge-green" : "badge-red"}">${u.active !== false ? "Active" : "Off"}</span></td>
      <td><span class="badge badge-blue">${s.count}</span></td>
      <td style="color:var(--muted);font-size:12px">${lastUsed}</td>
      <td>
        <div class="action-row">
          <form method="POST" action="/admin/recharge" style="display:flex;gap:4px;align-items:center">
            <input type="hidden" name="number" value="${u.number}"/>
            <input name="amount" type="number" placeholder="৳" style="width:60px;padding:5px 8px"/>
            <button name="type" value="add"    class="btn btn-success" style="padding:5px 10px">+</button>
            <button name="type" value="remove" class="btn btn-danger"  style="padding:5px 10px">−</button>
          </form>
          <form method="POST" action="/admin/toggle" style="display:inline">
            <input type="hidden" name="number" value="${u.number}"/>
            <button class="btn btn-ghost" style="padding:5px 10px">${u.active !== false ? "Disable" : "Enable"}</button>
          </form>
          <form method="POST" action="/admin/delete" style="display:inline">
            <input type="hidden" name="number" value="${u.number}"/>
            <button class="btn btn-danger" style="padding:5px 10px" onclick="return confirm('Delete ${u.number}?')">🗑</button>
          </form>
        </div>
      </td>
    </tr>`;
  }).join("");

  res.send(`<html><head>${ADMIN_CSS}<title>NID Bot Admin</title></head><body>
  <div class="topbar">
    <h1>📊 NID Bot Admin</h1>
    <a href="/admin/logout">Logout</a>
  </div>
  <div class="wrap">

    <!-- Stats -->
    <div class="stats-grid">
      <div class="stat-card"><div class="label">Total Users</div><div class="value">${users.length}</div></div>
      <div class="stat-card"><div class="label">Active Users</div><div class="value" style="color:var(--success)">${activeUsers}</div></div>
      <div class="stat-card"><div class="label">Cards Made</div><div class="value" style="color:var(--warning)">${totalCards}</div></div>
      <div class="stat-card"><div class="label">Total Balance</div><div class="value" style="color:var(--primary)">${totalBalance} ৳</div></div>
      <div class="stat-card"><div class="label">Card Price</div><div class="value">${settings.cardPrice || 0} ৳</div></div>
    </div>

    <div class="grid2">
      <!-- Settings -->
      <div class="card">
        <h3>⚙️ Settings</h3>
        <form method="POST" action="/admin/settings" class="form-row">
          <label style="font-size:13px;font-weight:500">Card Price (৳)</label>
          <input name="cardPrice" value="${settings.cardPrice || 0}" type="number" style="width:90px"/>
          <button class="btn btn-primary">Save</button>
        </form>
      </div>

      <!-- Backup -->
      <div class="card">
        <h3>☁️ Backup</h3>
        <div class="form-row" style="align-items:center;gap:12px">
          <span class="${mongoOK ? "mongo-ok" : "mongo-err"}">${mongoOK ? "✅ MongoDB Connected" : "❌ MongoDB না (MONGO_URI নেই)"}</span>
          <form method="POST" action="/admin/backup">
            <button class="btn btn-teal">Backup Now</button>
          </form>
        </div>
      </div>
    </div>

    <!-- Add User -->
    <div class="card">
      <h3>➕ Add User</h3>
      <form method="POST" action="/admin/add" class="form-row">
        <input name="number"  placeholder="880XXXXXXXXXX" required/>
        <input name="name"    placeholder="Name (optional)"/>
        <input name="balance" placeholder="Balance (৳)" value="0" type="number" style="width:110px"/>
        <button class="btn btn-primary">Add User</button>
      </form>
    </div>

    <!-- Users Table -->
    <div class="section-title">👥 Users <span style="font-size:13px;color:var(--muted);font-weight:400">(${users.length})</span></div>
    <div class="card" style="padding:0;overflow:hidden">
      <table>
        <thead>
          <tr>
            <th>Number</th><th>Name</th><th>Balance</th><th>Status</th>
            <th>Cards</th><th>Last Used</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--muted)">কোনো user নেই</td></tr>`}</tbody>
      </table>
    </div>

  </div>
  </body></html>`);
});

app.post("/admin/add", adminAuth, (req, res) => {
  const users = getUsers();
  const { number, name, balance } = req.body;
  const n = normalizeNumber(number);
  if (!users.find(u => normalizeNumber(u.number) === n)) {
    users.push({ number: n, name: name || "", balance: parseFloat(balance) || 0, active: true });
    saveUsers(users); backupData();
  }
  res.redirect("/admin");
});

app.post("/admin/recharge", adminAuth, (req, res) => {
  const users = getUsers();
  const { number, amount, type } = req.body;
  const i   = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(number));
  const amt = parseFloat(amount) || 0;
  if (i !== -1 && amt > 0) {
    users[i].balance = (users[i].balance || 0) + (type === "remove" ? -amt : amt);
    saveUsers(users); backupData();
  }
  res.redirect("/admin");
});

app.post("/admin/toggle", adminAuth, (req, res) => {
  const users = getUsers();
  const i     = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(req.body.number));
  if (i !== -1) {
    users[i].active = users[i].active === false ? true : false;
    saveUsers(users); backupData();
  }
  res.redirect("/admin");
});

app.post("/admin/delete", adminAuth, (req, res) => {
  saveUsers(getUsers().filter(u => normalizeNumber(u.number) !== normalizeNumber(req.body.number)));
  backupData();
  res.redirect("/admin");
});

app.post("/admin/settings", adminAuth, (req, res) => {
  saveSettings({ cardPrice: parseFloat(req.body.cardPrice) || 0 });
  backupData();
  res.redirect("/admin");
});

app.post("/admin/backup", adminAuth, async (req, res) => {
  await backupData();
  res.redirect("/admin");
});

// ========== CLEANUP ==========
function cleanupOldFiles() {
  try {
    const tenMin = 10 * 60 * 1000;
    fs.readdirSync(CONFIG.STORAGE_DIR).forEach(f => {
      if (!f.endsWith(".html")) return;
      const fp = path.join(CONFIG.STORAGE_DIR, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > tenMin) { fs.unlinkSync(fp); }
    });
  } catch {}
}

// ========== START ==========
(async () => {
  await restoreData();
  cleanupOldFiles();

  app.listen(CONFIG.PORT, () => {
    console.log(`🚀 NID Bot running on port ${CONFIG.PORT}`);
    console.log(`📡 Webhook: ${CONFIG.BASE_URL}/webhook`);
    console.log(`🔐 Admin: ${CONFIG.BASE_URL}/admin`);
  });

  setInterval(() => { axios.get(CONFIG.BASE_URL).catch(() => {}); }, 14 * 60 * 1000);
})();
