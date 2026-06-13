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

async function handleMessage(sock, msg) {
  // Hanya proses jika pesan valid
  if (!msg.message || msg.key.fromMe) return;

  const sender = msg.key.remoteJid;
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

  // 2. Kirim Webhook ke n8n (Dinonaktifkan sesuai permintaan)
  // Bot sekarang 100% 1-arah (Sistem Notifikasi). Tidak ada lagi auto-reply.
}

module.exports = { handleMessage, simulateTyping };
