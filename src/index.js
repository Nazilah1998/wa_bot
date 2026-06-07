const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcodeLib = require('qrcode');
const path = require('path');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const { handleMessage, simulateTyping } = require('./handlers/messageHandler');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json()); // Supaya bisa baca JSON body
app.use(express.static(path.join(__dirname, 'public')));

let qrCodeData = null;
let connectionStatus = 'connecting';
let globalSock = null; // Menyimpan instance socket whatsapp

// --- RECOVERY ANTREAN STUCK (SAAT RESTART) ---
// Jika bot mati mendadak saat status sedang 'processing', reset kembali ke 'pending'
try {
  const db = require('./db/index');
  db.query("UPDATE ptsp_whatsapp_outbox SET status = 'pending' WHERE status = 'processing'")
    .then(() => console.log('✅ Pembersihan antrean (stuck queue) selesai.'))
    .catch(err => console.error('Gagal reset antrean:', err.message));
} catch (e) {}

// Fungsi aman untuk menghapus data sesi (Menghindari error EBUSY jika folder adalah Docker Volume)
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

// --- API ENDPOINTS ---

// 1. API Endpoint untuk mengirim pesan (Ditembak oleh n8n atau Dashboard)
app.post('/api/send', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (process.env.API_KEY && apiKey !== process.env.API_KEY) {
    return res.status(401).json({ success: false, message: 'API Key tidak valid' });
  }

  const { to, text } = req.body;
  if (!to || !text) {
    return res.status(400).json({ success: false, message: 'Parameter "to" dan "text" wajib diisi' });
  }

  if (!globalSock || connectionStatus !== 'open') {
    return res.status(503).json({ success: false, message: 'WhatsApp belum terhubung' });
  }

  try {
    // Format nomor: hilangkan karakter selain angka
    let cleanNumber = to.replace(/\D/g, '');
    // Ubah 0 awalan menjadi 62
    if (cleanNumber.startsWith('0')) {
      cleanNumber = '62' + cleanNumber.substring(1);
    }
    
    const formattedTo = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
    
    console.log(`[API] Menerima request kirim pesan ke: ${formattedTo}`);
    
    // Beri jeda dan pura-pura mengetik agar tidak terlihat seperti bot
    await simulateTyping(globalSock, formattedTo);
    
    await globalSock.sendMessage(formattedTo, { text: text });

    try {
      // Simpan ke log DB (Pesan Keluar)
      const db = require('./db');
      
      // Catat kontak penerima secara otomatis
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

// 2. API Endpoint untuk mengambil riwayat pesan (Untuk Dashboard)
app.get('/api/messages', async (req, res) => {
  try {
    const db = require('./db');
    const logs = await db.query("SELECT * FROM wa_message_logs ORDER BY timestamp DESC LIMIT 100");
    res.json({ success: true, data: logs.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. API Endpoint untuk mengambil kontak (Untuk Dashboard)
app.get('/api/contacts', async (req, res) => {
  try {
    const db = require('./db/index'); // Pakai path eksplisit agar aman saat load pertama
    const contacts = await db.query("SELECT * FROM wa_contacts ORDER BY created_at DESC LIMIT 500");
    res.json({ success: true, data: contacts.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. API Endpoint untuk Logout (Ganti Akun WA)
app.post('/api/logout', async (req, res) => {
  try {
    if (globalSock) {
      await globalSock.logout();
    }
    
    // Hapus isi folder kredensial
    clearAuthFolder();

    qrCodeData = null;
    connectionStatus = 'connecting';
    globalSock = null;

    res.json({ success: true, message: 'Berhasil logout' });

    // Restart proses agar Baileys membuat ulang QR Code (Coolify akan restart otomatis)
    setTimeout(() => {
      process.exit(0);
    }, 1000);

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- SOCKET.IO ---

io.on('connection', (socket) => {
  // Send current status to newly connected clients
  socket.emit('status', { status: connectionStatus });
  if (qrCodeData && connectionStatus !== 'open') {
    socket.emit('qr', qrCodeData);
  }
});

async function connectToWhatsApp() {
  let state, saveCreds;
  try {
    const authState = await useMultiFileAuthState('auth_info_baileys');
    state = authState.state;
    saveCreds = authState.saveCreds;
  } catch (err) {
    console.error('Data kredensial WhatsApp rusak. Mereset sesi...', err.message);
    clearAuthFolder();
    return process.exit(1); // Restart process automatically
  }

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // Tetap tampilkan di terminal untuk cadangan
    logger: pino({ level: 'silent' }), 
  });
  
  globalSock = sock; // Simpan ke global

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
        setTimeout(connectToWhatsApp, 3000); // Jeda 3 detik cegah reconnect loop
      } else {
        console.log('Sesi dihapus dari HP. Menghapus data sesi lokal...');
        clearAuthFolder();
        connectionStatus = 'connecting';
        io.emit('status', { status: 'disconnected' });
        // Restart proses otomatis (biarkan Coolify yang membangkitkan ulang)
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
      // Emit ke frontend agar muncul di Live Chat tanpa direfresh
      io.emit('new_message', msg);
    }
  });
}

// --- Polling WhatsApp Outbox ---
let isPolling = false;
setInterval(async () => {
  if (!globalSock || connectionStatus !== 'open') return;
  if (isPolling) return; // MENCEGAH TUMPANG TINDIH JIKA PROSES LAMBAT
  isPolling = true;

  try {
    const db = require('./db');
    // Ambil pesan dari antrean
    const res = await db.query("SELECT * FROM ptsp_whatsapp_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT 5");
    if (res.rows.length === 0) return;

    for (const row of res.rows) {
      // Cegah duplikasi pengiriman dengan menandai sebagai 'processing'
      await db.query("UPDATE ptsp_whatsapp_outbox SET status = 'processing' WHERE id = $1", [row.id]);

      let cleanNumber = row.phone.replace(/\D/g, '');
      if (cleanNumber.startsWith('0')) cleanNumber = '62' + cleanNumber.substring(1);
      const formattedTo = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
      
      console.log(`[Queue] Mengirim pesan antrean ke: ${formattedTo}`);
      
      try {
        await simulateTyping(globalSock, formattedTo);
        await globalSock.sendMessage(formattedTo, { text: row.message });
        
        // Update status menjadi sent
        await db.query("UPDATE ptsp_whatsapp_outbox SET status = 'sent', sent_at = NOW() WHERE id = $1", [row.id]);
        
        try {
          // Catat kontak penerima secara otomatis
          await db.query(
            "INSERT INTO wa_contacts (remote_jid, name) VALUES ($1, $2) ON CONFLICT (remote_jid) DO NOTHING",
            [formattedTo, 'Pemohon (Notifikasi)']
          );

          // Simpan ke log DB
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
      
      // Jeda 2 detik antar pesan agar tidak dibanned WhatsApp
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (err) {
    console.error("[Queue] Error polling database:", err.message);
  } finally {
    isPolling = false; // Buka kembali kunci
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`Server web berjalan di http://localhost:${PORT}`);
  connectToWhatsApp().catch(err => console.error('Gagal menjalankan bot:', err));
});
