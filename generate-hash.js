/**
 * generate-hash.js
 * Script helper untuk membuat bcrypt hash dari password admin.
 * 
 * Cara pakai:
 *   node generate-hash.js "PasswordAndaYangKuat123!"
 * 
 * Salin output hash ke variabel ADMIN_PASSWORD_HASH di file .env
 */

const bcrypt = require('bcrypt');

const password = process.argv[2];

if (!password) {
  console.error('\n❌ Error: Harap masukkan password sebagai argumen!');
  console.error('   Contoh: node generate-hash.js "PasswordAnda123!"\n');
  process.exit(1);
}

if (password.length < 8) {
  console.error('\n⚠️  Peringatan: Password terlalu pendek! Minimal 8 karakter untuk keamanan.\n');
  process.exit(1);
}

const COST_FACTOR = 12; // Semakin tinggi = semakin aman tapi lebih lambat

console.log('\n🔐 Generating bcrypt hash...\n');

bcrypt.hash(password, COST_FACTOR).then(hash => {
  console.log('✅ Hash berhasil dibuat!\n');
  console.log('Salin baris ini ke file .env Anda:');
  console.log('─'.repeat(60));
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
  console.log('─'.repeat(60));
  console.log('\n⚠️  JANGAN bagikan hash ini ke siapapun!');
  console.log('⚠️  Simpan password asli Anda di tempat yang aman.\n');
});
