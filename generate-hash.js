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

const COST_FACTOR = 12;

console.log('\n🔐 Generating bcrypt hash...\n');

bcrypt.hash(password, COST_FACTOR).then(hash => {
  const base64Hash = Buffer.from(hash).toString('base64');

  console.log('✅ Hash berhasil dibuat!\n');
  console.log('━'.repeat(65));
  console.log('📋 GUNAKAN VERSI BASE64 INI untuk Coolify/Docker (AMAN, tanpa $):');
  console.log('━'.repeat(65));
  console.log(`ADMIN_PASSWORD_HASH=${base64Hash}`);
  console.log('━'.repeat(65));
  console.log('\n📋 Versi raw bcrypt (untuk .env lokal):');
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
  console.log('\n⚠️  JANGAN bagikan hash ini ke siapapun!');
  console.log('⚠️  Simpan password asli Anda di tempat yang aman.\n');
});
