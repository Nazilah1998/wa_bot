const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcodeLib = require('qrcode');
const path = require('path');
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

const PORT = process.env.PORT || 3000;

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
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  console.warn('⚠️  SESSION_SECRET tidak diatur di .env! Menggunakan secret sementara. SEGERA atur SESSION_SECRET!');
  return 'ptsp-bot-secret-sementara-ganti-segera-' + Math.random().toString(36);
})();

// Lazy session middleware — membaca sessionStore saat request masuk
app.use((req, res, next) => {
  session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'ptsp.sid',
    cookie: {
      httpOnly: true,
      secure: isProduction,   // true otomatis di produksi (HTTPS), false di lokal
      sameSite: isProduction ? 'strict' : 'lax',
      maxAge: 8 * 60 * 60 * 1000, // Sesi berlaku 8 jam
    },
  })(req, res, next);
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
    // Bandingkan username (case-insensitive untuk UX yang lebih baik)
    const usernameMatch = username.toLowerCase() === adminUsername.toLowerCase();
    // Bandingkan password dengan hash menggunakan bcrypt
    const passwordMatch = await bcrypt.compare(password, adminPasswordHash);

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
    .catch(err => console.error('Gagal reset antrean:', err.message));
} catch (e) {}

// Fungsi aman untuk menghapus data sesi WA (bukan session login)
function clearAuthFolder() {
  const fs = require('fs');
  const path = require('path');
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
  const hasApiKey = process.env.API_KEY && apiKey === process.env.API_KEY;
  const hasSession = req.session && req.session.authenticated;

  if (!hasApiKey && !hasSession) {
    return res.status(401).json({ success: false, message: 'Tidak terautentikasi. Gunakan API Key atau login terlebih dahulu.' });
  }

  const { to, text } = req.body;
  if (!to || !text) {
    return res.status(400).json({ success: false, message: 'Parameter "to" dan "text" wajib diisi' });
  }

  if (!globalSock || connectionStatus !== 'open') {
    return res.status(503).json({ success: false, message: 'WhatsApp belum terhubung' });
  }

  try {
    let cleanNumber = to.replace(/\D/g, '');
    if (cleanNumber.startsWith('0')) cleanNumber = '62' + cleanNumber.substring(1);
    const formattedTo = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;

    console.log(`[API] Menerima request kirim pesan ke: ${formattedTo}`);
    await simulateTyping(globalSock, formattedTo);
    await globalSock.sendMessage(formattedTo, { text: text });

    try {
      const db = require('./db');
      await db.query(
        "INSERT INTO wa_contacts (remote_jid, name) VALUES ($1, $2) ON CONFLICT (remote_jid) DO NOTHING",
        [formattedTo, 'Pemohon / Klien']
      );
      await db.query(
        "INSERT INTO wa_message_logs (remote_jid, is_from_me, message_type, content, timestamp) VALUES ($1, $2, $3, $4, $5)",
        [formattedTo, true, 'conversation', text, Math.floor(Date.now() / 1000)]
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
app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    const db = require('./db');
    const logs = await db.query("SELECT * FROM wa_message_logs ORDER BY timestamp DESC LIMIT 100");
    res.json({ success: true, data: logs.rows });
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
  // Gunakan session middleware yang sama untuk Socket.IO
  const sessionMiddleware = session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'ptsp.sid',
    cookie: { httpOnly: true, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 },
  });

  sessionMiddleware(socket.request, {}, () => {
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
}

// ─────────────────────────────────────────────────────────────────────────────
// POLLING WHATSAPP OUTBOX
// ─────────────────────────────────────────────────────────────────────────────
let isPolling = false;
setInterval(async () => {
  if (!globalSock || connectionStatus !== 'open') return;
  if (isPolling) return;
  isPolling = true;

  try {
    const db = require('./db');
    const res = await db.query("SELECT * FROM ptsp_whatsapp_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5");
    if (res.rows.length === 0) return;

    for (const row of res.rows) {
      await db.query("UPDATE ptsp_whatsapp_outbox SET status = 'processing' WHERE id = $1", [row.id]);

      let cleanNumber = row.phone.replace(/\D/g, '');
      if (cleanNumber.startsWith('0')) cleanNumber = '62' + cleanNumber.substring(1);
      const formattedTo = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;

      console.log(`[Queue] Mengirim pesan antrean ke: ${formattedTo}`);

      try {
        await simulateTyping(globalSock, formattedTo);
        await globalSock.sendMessage(formattedTo, { text: row.message });
        await db.query("UPDATE ptsp_whatsapp_outbox SET status = 'sent', sent_at = NOW() WHERE id = $1", [row.id]);

        try {
          await db.query(
            "INSERT INTO wa_contacts (remote_jid, name) VALUES ($1, $2) ON CONFLICT (remote_jid) DO NOTHING",
            [formattedTo, 'Pemohon (Notifikasi)']
          );
          await db.query(
            "INSERT INTO wa_message_logs (remote_jid, is_from_me, message_type, content, timestamp) VALUES ($1, $2, $3, $4, $5)",
            [formattedTo, true, 'conversation', row.message, Math.floor(Date.now() / 1000)]
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

