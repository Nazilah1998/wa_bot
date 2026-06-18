const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcodeLib = require('qrcode');
const path = require('path');
const fs = require('fs');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const { handleMessage, simulateTyping } = require('./handlers/messageHandler');
const bcrypt = require('bcrypt');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = parseInt(process.env.PORT, 10) || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// SESSION STORE — Coba PostgreSQL, fallback ke MemoryStore jika DB tidak tersedia
// ─────────────────────────────────────────────────────────────────────────────
let sessionStore = undefined; // undefined = MemoryStore (default express-session)

async function initSessionStore() {
  try {
    const { Pool } = require('pg');
    const testPool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
    
    // Test koneksi dulu sebelum pakai PgStore
    await testPool.query('SELECT 1');
    
    const ConnectPgSimple = require('connect-pg-simple')(session);

    // Buat tabel session jika belum ada
    await testPool.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        PRIMARY KEY ("sid")
      );
      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
    `);

    sessionStore = new ConnectPgSimple({
      pool: testPool,
      tableName: 'session',
      createTableIfMissing: true,
    });
    console.log('✅ Session store: PostgreSQL (persisten)');
  } catch (err) {
    sessionStore = undefined; // Pakai MemoryStore bawaan express-session
    console.warn('⚠️  DB tidak tersedia, session pakai MemoryStore (sesi hilang saat restart):', err.message);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE DASAR
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Percayakan header dari reverse proxy Coolify/Traefik (diperlukan agar IP & HTTPS terdeteksi benar)
app.set('trust proxy', 1);

const isProduction = process.env.NODE_ENV === 'production';

// Konfigurasi Session
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('❌ SESSION_SECRET tidak diatur di .env! Semua sesi akan tidak valid setelah restart.');
  console.error('   Tetapkan SESSION_SECRET dengan string acak yang panjang di file .env');
  process.exit(1);
}

// Buat session middleware sekali di awal
let sessionMiddleware;

// Lazy session middleware — membaca sessionStore saat request masuk
app.use((req, res, next) => {
  if (!sessionMiddleware) {
    sessionMiddleware = session({
      store: sessionStore,
      secret: SESSION_SECRET,
      resave: true,
      saveUninitialized: false,
      name: 'ptsp.sid',
      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'strict' : 'lax',
        maxAge: 8 * 60 * 60 * 1000,
      },
    });
  }
  sessionMiddleware(req, res, next);
});

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITER — Anti Brute Force untuk endpoint Login
// ─────────────────────────────────────────────────────────────────────────────
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit window
  max: 5,                    // Maksimal 5 percobaan per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Hanya hitung percobaan GAGAL
  handler: (req, res) => {
    console.warn(`[Security] Rate limit terlampaui dari IP: ${req.ip}`);
    return res.status(429).json({
      success: false,
      message: 'Terlalu banyak percobaan login. Akses dikunci selama 15 menit.',
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE AUTH — Proteksi semua route yang memerlukan login
// ─────────────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated === true) {
    return next();
  }
  // Jika request API (JSON), kembalikan 401
  if (req.xhr || req.headers.accept?.includes('application/json') || req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, message: 'Sesi tidak valid. Silakan login kembali.', redirectTo: '/login' });
  }
  // Untuk request halaman, redirect ke login
  return res.redirect('/login');
}

// ─────────────────────────────────────────────────────────────────────────────
// STATIC FILES — HANYA login.html yang bisa diakses tanpa login
// ─────────────────────────────────────────────────────────────────────────────

// Serve halaman login (publik)
app.get('/login', (req, res) => {
  // Jika sudah login, langsung redirect ke dashboard
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Route root — proteksi dengan requireAuth, lalu serve dashboard
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Static assets lain (CSS, JS, gambar) bisa diakses (tidak ada data sensitif)
// Tapi halaman HTML lain selain login harus diproteksi di atas
app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // Matikan auto-serve index.html agar dikontrol route di atas
  setHeaders: (res, filePath) => {
    // Jangan cache HTML
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/auth/login — Verifikasi kredensial & buat sesi
app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username dan password wajib diisi.' });
  }

  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;

  if (!adminUsername || !adminPasswordHash) {
    console.error('[Auth] ADMIN_USERNAME atau ADMIN_PASSWORD_HASH belum diatur di .env!');
    return res.status(500).json({ success: false, message: 'Sistem autentikasi belum dikonfigurasi. Hubungi administrator.' });
  }

  try {
    // Auto-detect: jika hash dari env var adalah Base64 (tidak dimulai $2b$), decode dulu
    // Ini diperlukan karena Coolify/Docker kadang corrupt karakter $ pada nilai env var
    let resolvedHash = adminPasswordHash;
    if (!adminPasswordHash.startsWith('$2')) {
      try {
        resolvedHash = Buffer.from(adminPasswordHash, 'base64').toString('utf-8');
      } catch (e) {
        resolvedHash = adminPasswordHash; // fallback ke raw jika decode gagal
      }
    }

    // Bandingkan username (case-insensitive untuk UX yang lebih baik)
    const usernameMatch = username.toLowerCase() === adminUsername.toLowerCase();
    // Bandingkan password dengan hash menggunakan bcrypt
    const passwordMatch = await bcrypt.compare(password, resolvedHash);

    if (usernameMatch && passwordMatch) {
      // Regenerate session ID untuk mencegah Session Fixation attack
      req.session.regenerate((err) => {
        if (err) {
          console.error('[Auth] Gagal regenerate session:', err);
          return res.status(500).json({ success: false, message: 'Terjadi kesalahan server. Coba lagi.' });
        }

        req.session.authenticated = true;
        req.session.username = adminUsername;
        req.session.loginTime = new Date().toISOString();

        console.log(`[Auth] ✅ Login berhasil untuk user: ${adminUsername} dari IP: ${req.ip}`);

        return res.json({ success: true, message: 'Login berhasil!', redirectTo: '/' });
      });
    } else {
      // Jangan beritahu mana yang salah (username atau password) — ini best practice keamanan
      console.warn(`[Auth] ❌ Percobaan login gagal untuk username: "${username}" dari IP: ${req.ip}`);
      return res.status(401).json({ success: false, message: 'Username atau password yang Anda masukkan salah.' });
    }
  } catch (err) {
    console.error('[Auth] Error saat verifikasi login:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server. Coba lagi.' });
  }
});

// POST /api/auth/logout — Hapus sesi & redirect ke login
app.post('/api/auth/logout', (req, res) => {
  const username = req.session?.username || 'unknown';
  req.session.destroy((err) => {
    if (err) {
      console.error('[Auth] Gagal menghapus sesi:', err);
      return res.status(500).json({ success: false, message: 'Gagal logout.' });
    }
    res.clearCookie('ptsp.sid');
    console.log(`[Auth] ✅ Logout berhasil untuk user: ${username}`);
    res.json({ success: true, message: 'Berhasil logout.', redirectTo: '/login' });
  });
});

// GET /api/auth/status — Cek status login (untuk frontend)
app.get('/api/auth/status', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.json({
      success: true,
      authenticated: true,
      username: req.session.username,
      loginTime: req.session.loginTime,
    });
  }
  return res.status(401).json({ success: false, authenticated: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP STATE
// ─────────────────────────────────────────────────────────────────────────────
let qrCodeData = null;
let connectionStatus = 'connecting';
let globalSock = null;

// --- RECOVERY ANTREAN STUCK (SAAT RESTART) ---
try {
  const db = require('./db/index');
  db.query("UPDATE ptsp_whatsapp_outbox SET status = 'pending' WHERE status = 'processing'")
    .then(() => console.log('✅ Pembersihan antrean (stuck queue) selesai.'))
    .catch(err => console.error('⚠️  Gagal reset antrean (tabel mungkin belum ada):', err.message));
} catch (e) {
  console.error('⚠️  Gagal inisialisasi recovery antrean:', e.message);
}

// Fungsi aman untuk menghapus data sesi WA (bukan session login)
function clearAuthFolder() {
  const dir = 'auth_info_baileys';
  if (fs.existsSync(dir)) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        fs.rmSync(path.join(dir, file), { recursive: true, force: true });
      }
      console.log('✅ Data kredensial lokal berhasil dibersihkan.');
    } catch (err) {
      console.error('Gagal membersihkan isi folder auth:', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API ENDPOINTS (semua diproteksi dengan requireAuth)
// ─────────────────────────────────────────────────────────────────────────────

// 1. API Endpoint untuk mengirim pesan (Ditembak oleh n8n atau Dashboard)
//    Untuk n8n: gunakan x-api-key header, bukan session
app.post('/api/send', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  // Boleh akses jika: punya API key ATAU sudah login
  // NOTE: API_KEY saat ini diverifikasi sebagai static string (bukan JWT).
  // Key berbentuk JWT untuk kompatibilitas dengan n8n, tapi tidak diverifikasi.
  // Untuk produksi lebih aman, implementasikan verifikasi JWT penuh.
  const hasApiKey = process.env.API_KEY && apiKey === process.env.API_KEY;
  const hasSession = req.session && req.session.authenticated;

  if (!hasApiKey && !hasSession) {
    return res.status(401).json({ success: false, message: 'Tidak terautentikasi. Gunakan API Key atau login terlebih dahulu.' });
  }

  const { to, text, mediaUrl, mediaType, fileName } = req.body;
  if (!to || (!text && !mediaUrl)) {
    return res.status(400).json({ success: false, message: 'Parameter "to" dan salah satu antara "text" atau "mediaUrl" wajib diisi' });
  }

  if (!globalSock || connectionStatus !== 'open') {
    return res.status(503).json({ success: false, message: 'WhatsApp belum terhubung' });
  }

  try {
    let cleanNumber = to.replace(/\D/g, '');
    if (cleanNumber.startsWith('0')) cleanNumber = '62' + cleanNumber.substring(1);
    
    if (cleanNumber.length < 9) {
      console.warn(`[API] Nomor terlalu pendek/tidak valid: ${cleanNumber}`);
      return res.status(400).json({ success: false, message: 'Nomor WhatsApp tidak valid' });
    }

    const formattedTo = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;

    // Cek apakah nomor aktif dan terdaftar di WhatsApp
    const [result] = await globalSock.onWhatsApp(formattedTo);
    if (!result || !result.exists) {
      console.warn(`[API] Nomor tidak terdaftar di WA: ${formattedTo}`);
      return res.status(400).json({ success: false, message: 'Nomor belum terdaftar di WhatsApp' });
    }

    const finalJid = result.jid || formattedTo;

    console.log(`[API] Menerima request kirim pesan ke: ${finalJid}`);
    
    const actualText = text || '';
    if (mediaUrl) {
      let msgOptions = {};
      const finalFileName = fileName || 'Document';
      
      if (mediaType === 'image') {
        msgOptions = { image: { url: mediaUrl }, caption: actualText };
      } else if (mediaType === 'video') {
        msgOptions = { video: { url: mediaUrl }, caption: actualText };
      } else if (mediaType === 'audio') {
        msgOptions = { audio: { url: mediaUrl }, mimetype: 'audio/mp4', ptt: false };
      } else {
        msgOptions = { document: { url: mediaUrl }, mimetype: 'application/pdf', fileName: finalFileName, caption: actualText };
      }
      
      if (actualText) await simulateTyping(globalSock, finalJid, actualText);
      await globalSock.sendMessage(finalJid, msgOptions);
    } else {
      await simulateTyping(globalSock, finalJid, actualText);
      await globalSock.sendMessage(finalJid, { text: actualText });
    }

    try {
      const db = require('./db');
      await db.query(
        "INSERT INTO wa_contacts (remote_jid, name) VALUES ($1, $2) ON CONFLICT (remote_jid) DO NOTHING",
        [finalJid, 'Klien (via API)']
      );
      
      const logContent = mediaUrl ? `[Media: ${mediaType || 'document'}] ${actualText}` : actualText;
      const logMessageType = mediaUrl ? (mediaType === 'image' ? 'imageMessage' : 'documentMessage') : 'conversation';
      
      await db.query(
        "INSERT INTO wa_message_logs (remote_jid, is_from_me, message_type, content, timestamp) VALUES ($1, $2, $3, $4, $5)",
        [finalJid, true, logMessageType, logContent, Math.floor(Date.now() / 1000)]
      );
    } catch (dbErr) {
      console.error('Pesan WA terkirim, tapi gagal mencatat log ke DB:', dbErr.message);
    }

    res.json({ success: true, message: 'Pesan berhasil dikirim' });
  } catch (err) {
    console.error('Gagal mengirim pesan via API:', err);
    res.status(500).json({ success: false, message: 'Gagal mengirim pesan', error: err.message });
  }
});

// 2. API Endpoint untuk mengambil riwayat pesan (Untuk Dashboard) — WAJIB LOGIN
app.get("/api/messages", requireAuth, async (req, res) => {
  try {
    const db = require("./db");
    const { direction, startDate, endDate, limit, offset } = req.query;
    let query = `
      SELECT
        m.*,
        COALESCE(c.name, split_part(m.remote_jid, '@', 1)) as contact_name
      FROM wa_message_logs m
      LEFT JOIN wa_contacts c ON c.remote_jid = m.remote_jid
      WHERE 1=1
    `;
    const params = [];

    if (direction === "in") {
      query += " AND m.is_from_me = false";
    } else if (direction === "out") {
      query += " AND m.is_from_me = true";
    }

    if (startDate) {
      query += ` AND m.timestamp >= $${params.length + 1}`;
      params.push(Math.floor(new Date(startDate).getTime() / 1000));
    }
    if (endDate) {
      query += ` AND m.timestamp <= $${params.length + 1}`;
      params.push(Math.floor(new Date(endDate).getTime() / 1000));
    }

    query += " ORDER BY m.timestamp DESC";
    query += ` LIMIT $${params.length + 1}`;
    params.push(parseInt(limit, 10) || 100);

    if (offset) {
      query += ` OFFSET $${params.length + 1}`;
      params.push(parseInt(offset, 10) || 0);
    }

    const logs = await db.query(query, params);

    // Get total count (for dashboard stats)
    let totalCount = 0;
    try {
        const totalResult = await db.query("SELECT COUNT(*) FROM wa_message_logs");
        totalCount = parseInt(totalResult.rows[0].count, 10);
    } catch(e) {}

    res.json({ 
        success: true, 
        data: logs.rows,
        pagination: { total: totalCount }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/messages/chart — Chart data 7 hari terakhir
app.get("/api/messages/chart", requireAuth, async (req, res) => {
  try {
    const db = require("./db");
    const result = await db.query(`
      WITH dates AS (
        SELECT generate_series(
          current_date - interval '6 days',
          current_date,
          '1 day'::interval
        )::date as date
      )
      SELECT 
        d.date,
        to_char(d.date, 'DD Mon') as date_label,
        COUNT(m.id) FILTER (WHERE m.is_from_me = false) as inbound,
        COUNT(m.id) FILTER (WHERE m.is_from_me = true) as outbound
      FROM dates d
      LEFT JOIN wa_message_logs m ON date(to_timestamp(m.timestamp)) = d.date
      GROUP BY d.date, date_label
      ORDER BY d.date ASC
    `);
    
    const chartData = result.rows.map(r => ({
      date: r.date_label,
      inbound: parseInt(r.inbound) || 0,
      outbound: parseInt(r.outbound) || 0
    }));
    
    res.json({ success: true, data: chartData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/messages/search?q=keyword — Cari pesan
app.get("/api/messages/search", requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res
        .status(400)
        .json({ success: false, message: "Minimal 2 karakter" });
    }
    const db = require("./db");
    const result = await db.query(
      `
      SELECT
        m.*,
        COALESCE(c.name, split_part(m.remote_jid, '@', 1)) as contact_name
      FROM wa_message_logs m
      LEFT JOIN wa_contacts c ON c.remote_jid = m.remote_jid
      WHERE m.content ILIKE $1
      ORDER BY m.timestamp DESC
      LIMIT 50
    `,
      [`%${q}%`]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/messages/export — Export CSV
app.get("/api/messages/export", requireAuth, async (req, res) => {
  try {
    const db = require("./db");
    const logs = await db.query(`
      SELECT
        COALESCE(c.name, split_part(m.remote_jid, '@', 1)) as contact,
        m.remote_jid,
        CASE WHEN m.is_from_me THEN 'Keluar' ELSE 'Masuk' END as arah,
        m.message_type as tipe,
        m.content as isi_pesan,
        to_timestamp(m.timestamp) as waktu
      FROM wa_message_logs m
      LEFT JOIN wa_contacts c ON c.remote_jid = m.remote_jid
      ORDER BY m.timestamp DESC
    `);

    const header = "Kontak,Nomor WA,Arah,Tipe,Isi Pesan,Waktu\n";
    const csv = logs.rows
      .map((r) => {
        const waktu = r.waktu ? new Date(r.waktu).toISOString() : "";
        const isi = (r.isi_pesan || "").replace(/"/g, '""');
        const jid = r.remote_jid.replace("@s.whatsapp.net", "");
        return `"${r.contact}","${jid}","${r.arah}","${r.tipe}","${isi}","${waktu}"`;
      })
      .join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="wa-log-' +
        new Date().toISOString().split("T")[0] +
        '.csv"'
    );
    res.send("\uFEFF" + header + csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. API Endpoint untuk mengambil kontak (Untuk Dashboard) — WAJIB LOGIN
app.get('/api/contacts', requireAuth, async (req, res) => {
  try {
    const db = require('./db/index');
    const contacts = await db.query("SELECT * FROM wa_contacts ORDER BY created_at DESC LIMIT 500");
    res.json({ success: true, data: contacts.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/contacts/top — Top contacts by message count
app.get("/api/contacts/top", requireAuth, async (req, res) => {
  try {
    const db = require("./db");
    const result = await db.query(`
      SELECT
        c.remote_jid,
        COALESCE(c.name, split_part(c.remote_jid, '@', 1)) as name,
        COUNT(m.id) as message_count,
        MAX(m.timestamp) as last_message
      FROM wa_contacts c
      LEFT JOIN wa_message_logs m ON m.remote_jid = c.remote_jid
      GROUP BY c.remote_jid, c.name
      ORDER BY message_count DESC
      LIMIT 10
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/chats — Ambil daftar kontak dengan pesan terakhir
app.get("/api/chats", requireAuth, async (req, res) => {
  try {
    const db = require("./db");
    const result = await db.query(`
      SELECT 
        c.remote_jid, 
        COALESCE(c.name, split_part(c.remote_jid, '@', 1)) as name,
        m.content as last_message,
        m.timestamp as last_time,
        m.is_from_me as last_is_from_me
      FROM wa_contacts c
      LEFT JOIN LATERAL (
        SELECT content, timestamp, is_from_me
        FROM wa_message_logs
        WHERE remote_jid = c.remote_jid
        ORDER BY timestamp DESC
        LIMIT 1
      ) m ON true
      ORDER BY m.timestamp DESC NULLS LAST
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/chats/:jid/messages — Ambil histori pesan dari kontak tertentu
app.get("/api/chats/:jid/messages", requireAuth, async (req, res) => {
  try {
    const db = require("./db");
    const result = await db.query(`
      SELECT * FROM wa_message_logs
      WHERE remote_jid = $1
      ORDER BY timestamp ASC
    `, [req.params.jid]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/chats/:jid — Hapus obrolan (satuan)
app.delete("/api/chats/:jid", requireAuth, async (req, res) => {
  try {
    const jid = req.params.jid;
    const db = require("./db");

    await db.query("DELETE FROM wa_message_logs WHERE remote_jid = $1", [jid]);
    await db.query("DELETE FROM wa_contacts WHERE remote_jid = $1", [jid]);

    if (globalSock) {
        try {
            await globalSock.chatModify({ delete: true, lastMessages: [{ key: { remoteJid: jid, fromMe: true, id: '' }, messageTimestamp: Math.floor(Date.now() / 1000) }] }, jid);
        } catch (e) {
            console.log('Gagal sinkronisasi hapus ke WA:', e.message);
        }
    }

    res.json({ success: true, message: 'Obrolan berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/chats — Hapus semua obrolan (massal)
app.delete("/api/chats", requireAuth, async (req, res) => {
  try {
    const db = require("./db");

    const contacts = await db.query("SELECT remote_jid FROM wa_contacts");

    await db.query("TRUNCATE TABLE wa_message_logs RESTART IDENTITY CASCADE");
    await db.query("TRUNCATE TABLE wa_contacts RESTART IDENTITY CASCADE");

    if (globalSock) {
        for (const row of contacts.rows) {
            try {
                await globalSock.chatModify({ delete: true, lastMessages: [{ key: { remoteJid: row.remote_jid, fromMe: true, id: '' }, messageTimestamp: Math.floor(Date.now() / 1000) }] }, row.remote_jid);
            } catch (e) {}
        }
    }

    res.json({ success: true, message: 'Semua obrolan berhasil dikosongkan' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-REPLY CRUD
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/auto-replies — Ambil semua keyword
app.get("/api/auto-replies", requireAuth, async (req, res) => {
  try {
    const db = require("./db");
    const result = await db.query(
      "SELECT * FROM wa_auto_replies ORDER BY keyword ASC"
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auto-replies — Tambah/edit keyword
app.post("/api/auto-replies", requireAuth, async (req, res) => {
  const { keyword, response, is_active } = req.body;
  if (!keyword || !response) {
    return res
      .status(400)
      .json({ success: false, message: "Keyword dan response wajib diisi" });
  }
  try {
    const db = require("./db");
    await db.query(
      "INSERT INTO wa_auto_replies (keyword, response, is_active) VALUES ($1, $2, $3) ON CONFLICT (keyword) DO UPDATE SET response = $2, is_active = $3",
      [keyword.toLowerCase(), response, is_active !== false]
    );
    res.json({ success: true, message: "Auto-reply berhasil disimpan" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/auto-replies/:id — Hapus keyword
app.delete("/api/auto-replies/:id", requireAuth, async (req, res) => {
  try {
    const db = require("./db");
    await db.query("DELETE FROM wa_auto_replies WHERE id = $1", [
      req.params.id,
    ]);
    res.json({ success: true, message: "Auto-reply berhasil dihapus" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auto-replies/sync — Sync dari Database PTSP
// ─────────────────────────────────────────────────────────────────────────────
function getCode(srvIndex, itemIndex) {
    if (itemIndex < 26) return `${srvIndex}${String.fromCharCode(65 + itemIndex)}`;
    return `${srvIndex}${String.fromCharCode(65 + Math.floor(itemIndex / 26) - 1)}${String.fromCharCode(65 + (itemIndex % 26))}`;
}

app.post("/api/auto-replies/sync", requireAuth, async (req, res) => {
  try {
    const db = require("./db");
    const servicesRes = await db.query("SELECT id, name FROM ptsp_services ORDER BY id ASC");
    const services = servicesRes.rows;

    const itemsRes = await db.query("SELECT id, service_id, name, description FROM ptsp_service_items WHERE is_active = true ORDER BY service_id ASC, id ASC");
    const items = itemsRes.rows;

    const reqRes = await db.query("SELECT service_item_id, document_name, description FROM ptsp_service_requirements ORDER BY sort_order ASC, id ASC");
    const requirements = reqRes.rows;

    const data = [];
    let mainMenuText = "🏢 *Selamat Datang di PTSP Kemenag Barito Utara*\n\nSilakan balas dengan mengetik *ANGKA* pilihan menu di bawah ini:\n\n";
    let serviceMap = {};
    let serviceIndex = 1;
    
    for (const srv of services) {
        const myItems = items.filter(i => i.service_id === srv.id);
        if (myItems.length === 0) continue;
        serviceMap[srv.id] = { index: serviceIndex, name: srv.name, items: myItems };
        mainMenuText += `${serviceIndex}️⃣ ${srv.name}\n`;
        serviceIndex++;
    }
    mainMenuText += "0️⃣ Informasi Umum & Pengaduan\n\n_Ketik *MENU* kapan saja untuk kembali ke daftar ini._";

    const triggers = ['menu', 'halo', 'ping', 'bantuan', 'assalamualaikum', 'p'];
    for(const t of triggers) {
        const prefix = t === 'assalamualaikum' ? 'Waalaikumsalam wr. wb.\n\n' : (t === 'halo' ? 'Halo!\n\n' : '');
        data.push({ keyword: t, response: prefix + mainMenuText });
    }

    for (const srvId in serviceMap) {
        const srv = serviceMap[srvId];
        let subMenuText = `📁 *${srv.name}*\n\nSilakan balas dengan *KODE* untuk melihat persyaratan:\n\n`;
        let itemIndex = 0;
        
        for (const item of srv.items) {
            const code = getCode(srv.index, itemIndex);
            subMenuText += `*${code}* - ${item.name}\n`;
            
            const itemReqs = requirements.filter(r => r.service_item_id === item.id);
            let detailText = `📄 *Syarat ${item.name}:*\n`;
            if (item.description && item.description.trim() !== '' && item.description !== 'EMPTY') {
                detailText += `_${item.description}_\n\n`;
            }

            if (itemReqs.length > 0) {
                itemReqs.forEach((r, idx) => {
                    detailText += `${idx + 1}. ${r.document_name}\n`;
                    if (r.description && r.description.trim() !== '') {
                        detailText += `   ~ ${r.description}\n`;
                    }
                });
            } else {
                detailText += `(Belum ada data persyaratan spesifik. Silakan hubungi petugas loket).\n`;
            }
            detailText += `\nBawa dokumen persyaratan ke loket PTSP Kemenag Barito Utara, atau ajukan secara online melalui tautan berikut:\n🌐 https://ptsp.kemenag-baritoutara.com/login/pemohon\n\n_Ketik *${srv.index}* untuk kembali ke ${srv.name}._\n_Ketik *MENU* untuk kembali ke Awal._`;
            
            data.push({ keyword: code.toLowerCase(), response: detailText });
            itemIndex++;
        }
        subMenuText += `\n_Ketik *MENU* untuk kembali ke Menu Utama._`;
        data.push({ keyword: srv.index.toString(), response: subMenuText });
    }

    data.push({ 
        keyword: '0', 
        response: '🕒 *Informasi Umum PTSP Kemenag Barito Utara*\n\n*Jadwal Pelayanan:*\nSenin - Kamis : 07.30 - 16.00 WIB\nJumat : 07.30 - 16.30 WIB\nSabtu/Minggu : Libur\n\n*Pengaduan*\nUntuk menyampaikan pengaduan terkait pelayanan kami, ketik format:\n*Pengaduan#Nama#Isi Laporan*\n\n_Ketik *MENU* untuk kembali._' 
    });

    await db.query("TRUNCATE TABLE wa_auto_replies RESTART IDENTITY");

    for (const item of data) {
      await db.query(
        "INSERT INTO wa_auto_replies (keyword, response, is_active) VALUES ($1, $2, true)",
        [item.keyword, item.response]
      );
    }
    res.json({ success: true, message: `Berhasil sinkronisasi! ${data.length} layanan berhasil di-generate.`, count: data.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK TOOLS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/webhook/test — Test kirim ke n8n
app.post("/api/webhook/test", requireAuth, async (req, res) => {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(400).json({
      success: false,
      message: "N8N_WEBHOOK_URL belum diatur di .env",
    });
  }
  try {
    const axios = require("axios");
    const testPayload = {
      sender: "test@c.whatsapp.net",
      message: "Pesan test dari dashboard — " + new Date().toISOString(),
      messageType: "conversation",
      timestamp: Math.floor(Date.now() / 1000),
      _test: true,
    };
    const response = await axios.post(webhookUrl, testPayload, {
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
    });
    res.json({
      success: true,
      message: "Webhook berhasil dikirim",
      statusCode: response.status,
      responseData: response.data,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Gagal mengirim webhook",
      error: err.message,
      responseData: err.response?.data,
    });
  }
});

// GET /api/webhook/logs — Lihat log webhook
app.get("/api/webhook/logs", requireAuth, async (req, res) => {
  try {
    const db = require("./db");
    const result = await db.query(
      "SELECT * FROM wa_webhook_logs ORDER BY created_at DESC LIMIT 50"
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. API Endpoint untuk Logout WhatsApp (Ganti Akun WA) — WAJIB LOGIN
app.post('/api/logout', requireAuth, async (req, res) => {
  try {
    if (globalSock) {
      await globalSock.logout();
    }
    clearAuthFolder();
    qrCodeData = null;
    connectionStatus = 'connecting';
    globalSock = null;

    res.json({ success: true, message: 'Berhasil logout' });

    setTimeout(() => {
      process.exit(0);
    }, 1000);

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.IO — Hanya terima koneksi dari client yang sudah login
// ─────────────────────────────────────────────────────────────────────────────

// Middleware Socket.IO untuk verifikasi sesi
io.use((socket, next) => {
  // Parse cookie dari handshake request
  const sessionMiddleware = session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'ptsp.sid',
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    },
  });

  // Wajib pakai socket.request.res agar session store bisa set cookie jika perlu
  sessionMiddleware(socket.request, socket.request.res || {}, () => {
    if (socket.request.session && socket.request.session.authenticated) {
      return next();
    }
    console.warn(`[Socket.IO] Koneksi ditolak — sesi tidak valid dari ${socket.handshake.address}`);
    next(new Error('Unauthorized'));
  });
});

io.on('connection', (socket) => {
  socket.emit('status', { status: connectionStatus });
  if (qrCodeData && connectionStatus !== 'open') {
    socket.emit('qr', qrCodeData);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP CONNECTION
// ─────────────────────────────────────────────────────────────────────────────
async function connectToWhatsApp() {
  let state, saveCreds;
  try {
    const authState = await useMultiFileAuthState('auth_info_baileys');
    state = authState.state;
    saveCreds = authState.saveCreds;
  } catch (err) {
    console.error('Data kredensial WhatsApp rusak. Mereset sesi...', err.message);
    clearAuthFolder();
    return process.exit(1);
  }

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
  });

  globalSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan QR Code di atas menggunakan aplikasi WhatsApp Anda.');
      try {
        qrCodeData = await qrcodeLib.toDataURL(qr);
        io.emit('qr', qrCodeData);
      } catch (err) {
        console.error('Gagal membuat gambar QR code', err);
      }
    }

    if (connection) {
      connectionStatus = connection;
      io.emit('status', { status: connectionStatus });
    }

    if (connection === 'close') {
      qrCodeData = null;
      globalSock = null;
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('Sesi dihapus dari HP. Menghapus data sesi lokal...');
        clearAuthFolder();
        connectionStatus = 'connecting';
        io.emit('status', { status: 'disconnected' });
        setTimeout(() => process.exit(0), 1000);
      }
    } else if (connection === 'open') {
      console.log('✅ Bot WhatsApp berhasil terhubung!');
      qrCodeData = null;
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (m.type === 'notify') {
      await handleMessage(sock, msg);
      io.emit('new_message', msg);
    }
  });

  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest, lidPnMappings }) => {
    console.log(`[Sinkronisasi Riwayat] Menerima ${chats?.length} chat, ${contacts?.length} kontak, ${messages?.length} pesan.`);
    const db = require('./db');
    
    if (lidPnMappings) {
      if (!global.lidMappings) global.lidMappings = {};
      for (const mapping of lidPnMappings) {
        global.lidMappings[mapping.lidJid] = mapping.pnJid;
      }
      const fs = require('fs');
      fs.writeFileSync('./lid_mappings.json', JSON.stringify(global.lidMappings));
      console.log(`[Sinkronisasi Riwayat] Menyimpan ${lidPnMappings.length} mapping LID ke disk.`);
    }
    
    try {
      for (const contact of contacts) {
        if (contact.id && contact.id.endsWith('@s.whatsapp.net')) {
          await db.query(
            "INSERT INTO wa_contacts (remote_jid, name) VALUES ($1, $2) ON CONFLICT (remote_jid) DO UPDATE SET name = EXCLUDED.name",
            [contact.id, contact.name || contact.notify || contact.verifiedName || 'Klien']
          );
        }
      }

      for (const chat of chats) {
        if (chat.id && chat.id.endsWith('@s.whatsapp.net')) {
          await db.query(
            "INSERT INTO wa_contacts (remote_jid, name) VALUES ($1, $2) ON CONFLICT (remote_jid) DO NOTHING",
            [chat.id, chat.name || 'Klien']
          );
        }
      }

      for (const msg of messages) {
        if (!msg.message) continue;
        let remoteJid = msg.key.remoteJid;
        
        if (remoteJid && remoteJid.endsWith('@lid')) {
            const botLid = sock.authState?.creds?.me?.lid;
            if (botLid && remoteJid === botLid) {
                remoteJid = (sock.authState.creds.me.id.split(':')[0]) + '@s.whatsapp.net';
            }
        }
        
        if (!remoteJid || !remoteJid.endsWith('@s.whatsapp.net')) continue;
        if (remoteJid === 'status@broadcast') continue;

        const actualMessage = msg.message?.ephemeralMessage?.message || msg.message?.viewOnceMessage?.message || msg.message?.documentWithCaptionMessage?.message?.documentMessage || msg.message;

        const textMessage = actualMessage?.conversation || 
                            actualMessage?.extendedTextMessage?.text || 
                            actualMessage?.imageMessage?.caption || 
                            actualMessage?.documentMessage?.caption || '';
                            
        let type = 'conversation';
        if (actualMessage?.imageMessage) type = 'imageMessage';
        else if (actualMessage?.documentMessage) type = 'documentMessage';
        else if (!textMessage) continue;

        const timestamp = msg.messageTimestamp ? (typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : msg.messageTimestamp.low || Math.floor(Date.now() / 1000)) : Math.floor(Date.now() / 1000);
        const fromMe = msg.key.fromMe || false;

        await db.query(
          "INSERT INTO wa_contacts (remote_jid, name) VALUES ($1, $2) ON CONFLICT (remote_jid) DO NOTHING",
          [remoteJid, 'Klien (History)']
        );

        await db.query(
          "INSERT INTO wa_message_logs (remote_jid, is_from_me, message_type, content, timestamp) VALUES ($1, $2, $3, $4, $5)",
          [remoteJid, fromMe, type, textMessage, timestamp]
        );
      }
      console.log('✅ Sinkronisasi Riwayat Selesai. Data berhasil dimasukkan ke Database.');
    } catch (err) {
      console.error('❌ Gagal menyinkronkan riwayat ke database:', err.message);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POLLING WHATSAPP OUTBOX
// ─────────────────────────────────────────────────────────────────────────────
let isPolling = false;
let pollingInterval = null;

pollingInterval = setInterval(async () => {
  if (!globalSock || connectionStatus !== 'open') return;
  if (isPolling) return;
  isPolling = true;

  // Simpan referensi socket agar tidak berubah di tengah proses
  const currentSock = globalSock;

  try {
    const db = require('./db');
    const res = await db.query("SELECT * FROM ptsp_whatsapp_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5");
    if (res.rows.length === 0) return;

    for (const row of res.rows) {
      // Cek lagi apakah socket masih valid
      if (!currentSock || connectionStatus !== 'open') {
        console.warn('[Queue] Koneksi WA terputus saat memproses antrean.');
        break;
      }

      await db.query("UPDATE ptsp_whatsapp_outbox SET status = 'processing' WHERE id = $1", [row.id]);

      let cleanNumber = row.phone.replace(/\D/g, '');
      if (cleanNumber.startsWith('0')) cleanNumber = '62' + cleanNumber.substring(1);

      if (cleanNumber.length < 9) {
        console.warn(`[Queue] Nomor tidak valid: ${cleanNumber}. Mengabaikan pesan.`);
        await db.query("UPDATE ptsp_whatsapp_outbox SET status = 'failed' WHERE id = $1", [row.id]);
        continue;
      }

      const formattedTo = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;

      try {
        // Cek apakah nomor aktif dan terdaftar di WhatsApp
        const [result] = await currentSock.onWhatsApp(formattedTo);
        if (!result || !result.exists) {
          console.warn(`[Queue] Nomor tidak terdaftar di WA: ${formattedTo}. Mengabaikan pesan.`);
          await db.query("UPDATE ptsp_whatsapp_outbox SET status = 'failed' WHERE id = $1", [row.id]);
          continue;
        }

        const finalJid = result.jid || formattedTo;
        console.log(`[Queue] Mengirim pesan antrean ke: ${finalJid}`);

        const actualText = row.message || '';
        if (row.media_url) {
          let msgOptions = {};
          const finalFileName = row.file_name || 'Document';
          
          if (row.media_type === 'image') {
            msgOptions = { image: { url: row.media_url }, caption: actualText };
          } else if (row.media_type === 'video') {
            msgOptions = { video: { url: row.media_url }, caption: actualText };
          } else if (row.media_type === 'audio') {
            msgOptions = { audio: { url: row.media_url }, mimetype: 'audio/mp4', ptt: false };
          } else {
            msgOptions = { document: { url: row.media_url }, mimetype: 'application/pdf', fileName: finalFileName, caption: actualText };
          }
          
          if (actualText) await simulateTyping(currentSock, finalJid, actualText);
          await currentSock.sendMessage(finalJid, msgOptions);
        } else {
          await simulateTyping(currentSock, finalJid, actualText);
          await currentSock.sendMessage(finalJid, { text: actualText });
        }
        
        await db.query("UPDATE ptsp_whatsapp_outbox SET status = 'sent', sent_at = NOW() WHERE id = $1", [row.id]);

        try {
          await db.query(
            "INSERT INTO wa_contacts (remote_jid, name) VALUES ($1, $2) ON CONFLICT (remote_jid) DO NOTHING",
            [finalJid, 'Klien (via Outbox)']
          );
          
          const logContent = row.media_url ? `[Media: ${row.media_type || 'document'}] ${actualText}` : actualText;
          const logMessageType = row.media_url ? (row.media_type === 'image' ? 'imageMessage' : 'documentMessage') : 'conversation';
          
          await db.query(
            "INSERT INTO wa_message_logs (remote_jid, is_from_me, message_type, content, timestamp) VALUES ($1, $2, $3, $4, $5)",
            [finalJid, true, logMessageType, logContent, Math.floor(Date.now() / 1000)]
          );
        } catch (dbErr) {
          console.error(`[Queue] Pesan terkirim, tapi gagal log DB untuk ${formattedTo}:`, dbErr.message);
        }

      } catch (err) {
        console.error(`[Queue] Gagal kirim pesan ke ${formattedTo}:`, err.message);
        await db.query("UPDATE ptsp_whatsapp_outbox SET status = 'failed' WHERE id = $1", [row.id]);
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (err) {
    console.error("[Queue] Error polling database:", err.message);
  } finally {
    isPolling = false;
  }
}, 5000);

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  // Inisialisasi session store dulu (tunggu hasil koneksi DB)
  await initSessionStore();

  server.listen(PORT, () => {
    console.log(`Server web berjalan di http://localhost:${PORT}`);
    console.log(`🔐 Sistem login aktif — akses dashboard melalui: http://localhost:${PORT}/login`);
    connectToWhatsApp().catch(err => console.error('Gagal menjalankan bot:', err));
  });
})();

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[Server] Menerima sinyal ${signal}. Mematikan server...`);

  // Hentikan interval polling
  if (typeof pollingInterval !== 'undefined' && pollingInterval) {
    clearInterval(pollingInterval);
  }

  // Tutup koneksi WhatsApp
  if (globalSock) {
    try {
      await globalSock.logout();
      console.log('[Server] WhatsApp berhasil logout.');
    } catch (err) {
      console.warn('[Server] Gagal logout WA:', err.message);
    }
  }

  // Tutup HTTP server
  server.close(() => {
    console.log('[Server] HTTP server ditutup.');
    process.exit(0);
  });

  // Force exit jika graceful shutdown gagal dalam 10 detik
  setTimeout(() => {
    console.error('[Server] Force exit setelah timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
