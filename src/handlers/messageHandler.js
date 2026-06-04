const db = require('../db');

async function handleMessage(sock, msg) {
  // Hanya proses jika pesan valid
  if (!msg.message || msg.key.fromMe) return;

  const sender = msg.key.remoteJid;
  const messageType = Object.keys(msg.message)[0];
  const text = messageType === 'conversation' ? msg.message.conversation : 
               messageType === 'extendedTextMessage' ? msg.message.extendedTextMessage.text : '';

  if (!text) return;
  console.log(`Pesan masuk dari ${sender}: ${text}`);

  const command = text.toLowerCase().trim();

  // Contoh: Mengecek status tiket
  if (command.startsWith('!status')) {
    const args = command.split(' ');
    if (args.length < 2) {
      await sock.sendMessage(sender, { text: 'Format salah. Gunakan: !status [Nomor Tiket]' });
      return;
    }

    const ticketNumber = args[1].toUpperCase();
    
    try {
      const res = await db.query('SELECT status, service_name FROM ptsp_service_requests WHERE request_number = $1', [ticketNumber]);
      
      if (res.rows.length === 0) {
        await sock.sendMessage(sender, { text: `Maaf, tiket dengan nomor ${ticketNumber} tidak ditemukan.` });
      } else {
        const data = res.rows[0];
        await sock.sendMessage(sender, { text: `Status tiket *${ticketNumber}* (${data.service_name}):\n\nStatus: *${data.status}*` });
      }
    } catch (err) {
      console.error(err);
      await sock.sendMessage(sender, { text: 'Terjadi kesalahan saat mengecek database.' });
    }
    return;
  }

  // Contoh Menu Utama
  if (command === '!menu' || command === 'halo' || command === 'ping') {
    const reply = `Halo! Saya adalah Bot PTSP Kemenag Barito Utara. 🤖\n\nKetik perintah berikut:\n- *!status [Nomor Tiket]*: Cek status permohonan Anda.\n- *!info*: Informasi layanan.`;
    await sock.sendMessage(sender, { text: reply });
  }
}

module.exports = { handleMessage };
