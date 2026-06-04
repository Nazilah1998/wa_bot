const db = require("../db");

// Fungsi untuk menjeda eksekusi (delay)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fungsi untuk membuat bot seolah-olah sedang mengetik
async function simulateTyping(sock, jid) {
  // Mengirim status "sedang mengetik..."
  await sock.sendPresenceUpdate("composing", jid);

  // Jeda acak antara 3000ms (3 detik) hingga 5000ms (5 detik)
  const randomDelay = Math.floor(Math.random() * (5000 - 3000 + 1)) + 3000;
  await delay(randomDelay);

  // Menghentikan status "sedang mengetik..." (opsional, biasanya otomatis hilang saat pesan terkirim)
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
  console.log(`Pesan masuk dari ${sender}: ${text}`);

  const command = text.toLowerCase().trim();

  // Contoh: Mengecek status tiket
  if (command.startsWith("!status")) {
    const args = command.split(" ");
    if (args.length < 2) {
      await simulateTyping(sock, sender);
      await sock.sendMessage(sender, {
        text: "Format salah. Gunakan: !status [Nomor Tiket]",
      });
      return;
    }

    const ticketNumber = args[1].toUpperCase();

    try {
      const res = await db.query(
        "SELECT status, service_name FROM ptsp_service_requests WHERE request_number = $1",
        [ticketNumber],
      );

      await simulateTyping(sock, sender); // Mengetik sebelum merespons hasil DB

      if (res.rows.length === 0) {
        await sock.sendMessage(sender, {
          text: `Maaf, tiket dengan nomor ${ticketNumber} tidak ditemukan.`,
        });
      } else {
        const data = res.rows[0];
        await sock.sendMessage(sender, {
          text: `Status tiket *${ticketNumber}* (${data.service_name}):\n\nStatus: *${data.status}*`,
        });
      }
    } catch (err) {
      console.error(err);
      await simulateTyping(sock, sender);
      await sock.sendMessage(sender, {
        text: "Terjadi kesalahan saat mengecek database.",
      });
    }
    return;
  }

  // Contoh Menu Utama
  if (command === "!menu" || command === "halo" || command === "ping") {
    await simulateTyping(sock, sender); // Mengetik sebelum mengirim menu
    const reply = `Halo! Saya adalah Bot PTSP Kemenag Barito Utara. 🤖\n\nKetik perintah berikut:\n- *!status [Nomor Tiket]*: Cek status permohonan Anda.\n- *!info*: Informasi layanan.`;
    await sock.sendMessage(sender, { text: reply });
  }
}

module.exports = { handleMessage };
