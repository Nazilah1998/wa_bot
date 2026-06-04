const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcodeLib = require('qrcode');
const path = require('path');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const { handleMessage } = require('./handlers/messageHandler');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Setup static folder for public files
app.use(express.static(path.join(__dirname, 'public')));

let qrCodeData = null;
let connectionStatus = 'connecting';

io.on('connection', (socket) => {
  // Send current status to newly connected clients
  socket.emit('status', { status: connectionStatus });
  if (qrCodeData && connectionStatus !== 'open') {
    socket.emit('qr', qrCodeData);
  }
});

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // Tetap tampilkan di terminal untuk cadangan
    logger: pino({ level: 'silent' }), 
  });

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
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus.', lastDisconnect.error, 'Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      } else {
        console.log('Sesi telah dihapus. Silakan hapus folder "auth_info_baileys" dan scan ulang.');
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
    }
  });
}

server.listen(PORT, () => {
  console.log(`Server web berjalan di http://localhost:${PORT}`);
  connectToWhatsApp().catch(err => console.error('Gagal menjalankan bot:', err));
});
