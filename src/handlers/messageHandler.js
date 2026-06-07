const db = require("../db");
const axios = require("axios");

// Fungsi untuk menjeda eksekusi (delay)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fungsi untuk membuat bot seolah-olah sedang mengetik
async function simulateTyping(sock, jid) {
  try {
    await sock.sendPresenceUpdate("composing", jid);
    const randomDelay = Math.floor(Math.random() * (2000 - 1000 + 1)) + 1000; // 1-2 detik cukup
    await delay(randomDelay);
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
