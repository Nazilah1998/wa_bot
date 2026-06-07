const db = require("../db");
const axios = require("axios");

// Fungsi untuk menjeda eksekusi (delay)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fungsi untuk membuat bot seolah-olah sedang mengetik
async function simulateTyping(sock, jid) {
  await sock.sendPresenceUpdate("composing", jid);
  const randomDelay = Math.floor(Math.random() * (5000 - 3000 + 1)) + 3000;
  await delay(randomDelay);
  await sock.sendPresenceUpdate("paused", jid);
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

  // 2. Kirim Webhook ke n8n
  const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!n8nWebhookUrl || n8nWebhookUrl === "ISI_DENGAN_URL_WEBHOOK_N8N_ANDA") {
    console.log("N8N_WEBHOOK_URL belum diatur di .env. Menggunakan auto-reply lokal.");
    // Fallback lokal sementara (jika webhook belum ada)
    if (text.toLowerCase() === "halo") {
      await simulateTyping(sock, sender);
      await sock.sendMessage(sender, { text: "Halo! Saya adalah Bot PTSP. Integrasi n8n Anda belum selesai diatur (Webhook kosong)." });
    }
    return;
  }

  try {
    console.log(`Mengirim Webhook ke n8n...`);
    await axios.post(n8nWebhookUrl, {
      sender: sender,
      name: msg.pushName || sender.split("@")[0],
      text: text,
      timestamp: msg.messageTimestamp,
    });
    console.log(`Webhook berhasil dikirim ke n8n!`);
    
    // Opsional: Bikin bot pura-pura mengetik sambil nunggu n8n membalas
    await sock.sendPresenceUpdate("composing", sender);

  } catch (err) {
    console.error("Gagal mengirim Webhook ke n8n:", err.message);
  }
}

module.exports = { handleMessage, simulateTyping };
