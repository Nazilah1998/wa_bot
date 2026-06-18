const db = require("../db");
const axios = require("axios");

// Fungsi untuk menjeda eksekusi (delay)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fungsi untuk membuat bot seolah-olah sedang mengetik secara manusiawi
async function simulateTyping(sock, jid, text = "") {
  try {
    // Beri jeda sejenak sebelum mulai mengetik (reaksi baca pesan)
    await delay(Math.floor(Math.random() * 1000) + 500);
    
    // Status: sedang mengetik
    await sock.sendPresenceUpdate("composing", jid);
    
    // Kalkulasi waktu mengetik berdasarkan panjang karakter (Rata-rata manusia: 200 karakter/menit ~ 3 karakter/detik)
    // Tapi karena bot, kita batasi antara 1.5 detik sampai maksimal 4 detik agar tidak terlalu lama
    let typingDuration = 1500;
    if (text) {
      const calculatedDelay = Math.floor(text.length * 20); // 20ms per karakter
      typingDuration = Math.min(Math.max(calculatedDelay, 1500), 4000); 
    }
    
    // Tambah variasi acak (jitter) agar tidak konstan
    typingDuration += Math.floor(Math.random() * 500);
    
    await delay(typingDuration);
    await sock.sendPresenceUpdate("paused", jid);
  } catch (err) {
    console.error("Gagal simulate typing (abaikan jika koneksi belum stabil):", err.message);
  }
}

const processedMessages = new Set();

async function handleMessage(sock, msg) {
  // Hanya proses jika pesan valid
  if (!msg.message || msg.key.fromMe) return;

  // Hindari duplikasi pesan (karena WA sering kirim event ganda)
  if (processedMessages.has(msg.key.id)) return;
  processedMessages.add(msg.key.id);
  if (processedMessages.size > 500) {
    const iterator = processedMessages.values();
    for (let i = 0; i < 100; i++) processedMessages.delete(iterator.next().value);
  }

  // Untuk group chat, gunakan participant (pengirim asli)
  // Untuk personal chat, remoteJid = pengirim
  const isGroup = msg.key.remoteJid.endsWith('@g.us');
  let sender = isGroup ? msg.key.participant : msg.key.remoteJid;

  // Coba dapatkan nomor HP asli jika Baileys melampirkannya
  let realJid = sender;
  if (sender && sender.endsWith('@lid')) {
    // Muat mapping LID jika belum ada di memori
    if (!global.lidMappings) {
      const fs = require('fs');
      if (fs.existsSync('./lid_mappings.json')) {
        try {
          global.lidMappings = JSON.parse(fs.readFileSync('./lid_mappings.json', 'utf8'));
        } catch(e) {}
      }
    }

    // 1. Cek apakah ada lidPnMappings di memori (jika kita simpan saat history sync)
    if (global.lidMappings && global.lidMappings[sender]) {
      realJid = global.lidMappings[sender];
    }
    // 2. Fallback: Cek apakah pesan berasal dari "Message to Yourself" (bot itu sendiri)
    const botLid = sock.authState?.creds?.me?.lid;
    if (botLid && sender === botLid) {
        realJid = (sock.authState.creds.me.id.split(':')[0]) + '@s.whatsapp.net';
    }
    
    // Log pesan utuh agar kita bisa analisis jika nomor HP tidak ditemukan
    if (realJid === sender) {
       console.log("[DEBUG LID] Pesan dari LID:", sender, "Msg ID:", msg.key.id);
    }
  }

  sender = realJid;

  const messageType = Object.keys(msg.message)[0];
  const text =
    messageType === "conversation"
      ? msg.message.conversation
      : messageType === "extendedTextMessage"
        ? msg.message.extendedTextMessage.text
        : "";

  if (!text) return;
  console.log(`[Pesan Masuk] ${sender}: ${text}`);

  // 1. Simpan pesan ke log database (wa_message_logs)
  try {
    // Pastikan kontak terdaftar (Upsert sederhana)
    await db.query(
      "INSERT INTO wa_contacts (remote_jid, name) VALUES ($1, $2) ON CONFLICT (remote_jid) DO NOTHING",
      [sender, msg.pushName || sender.split("@")[0]]
    );

    // Simpan Log
    await db.query(
      "INSERT INTO wa_message_logs (remote_jid, is_from_me, message_type, content, timestamp) VALUES ($1, $2, $3, $4, $5)",
      [sender, false, messageType, text, msg.messageTimestamp]
    );
  } catch (err) {
    console.error("Gagal menyimpan log pesan ke DB:", err);
  }

  // Abaikan pesan grup (tidak diproses lebih lanjut)
  if (isGroup) return;

  // 2. Cek auto-reply dari database
  try {
    const result = await db.query(
      "SELECT response FROM wa_auto_replies WHERE is_active = true AND $1 ILIKE CONCAT('%', keyword, '%') ORDER BY LENGTH(keyword) DESC LIMIT 1",
      [text]
    );
    if (result.rows.length > 0) {
      const reply = result.rows[0].response;
      await simulateTyping(sock, sender, reply);
      await sock.sendMessage(sender, { text: reply });
      await db.query(
        "INSERT INTO wa_message_logs (remote_jid, is_from_me, message_type, content, timestamp) VALUES ($1, $2, $3, $4, $5)",
        [sender, true, "conversation", reply, Math.floor(Date.now() / 1000)]
      );
      return;
    }
  } catch (err) {
    console.error("Gagal cek auto-reply:", err.message);
  }

  // 3. Kirim Webhook ke n8n + log
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) return; // Abaikan jika webhook url tidak diatur

  const startTime = Date.now();
  try {
    const response = await axios.post(
      webhookUrl,
      {
        sender,
        message: text,
        messageType,
        timestamp: msg.messageTimestamp,
      },
      { timeout: 10000 }
    );

    await db.query(
      `INSERT INTO wa_webhook_logs (remote_jid, message, message_type, status_code, response, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        sender,
        text,
        messageType,
        response.status,
        JSON.stringify(response.data),
        Date.now() - startTime,
      ]
    );
    console.log(`[Webhook] Dikirim ke n8n dari ${sender} (${response.status})`);
  } catch (err) {
    await db.query(
      `INSERT INTO wa_webhook_logs (remote_jid, message, message_type, status_code, error, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        sender,
        text,
        messageType,
        err.response?.status || 0,
        err.message,
        Date.now() - startTime,
      ]
    );
    console.error("[Webhook] Gagal:", err.message);
  }
}

module.exports = { handleMessage, simulateTyping };
