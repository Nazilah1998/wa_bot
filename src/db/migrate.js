const db = require('./index');

async function migrate() {
  try {
    console.log('Menjalankan migrasi database...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS wa_contacts (
        id SERIAL PRIMARY KEY,
        remote_jid TEXT UNIQUE NOT NULL,
        name TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log('Tabel wa_contacts berhasil dipastikan.');

    await db.query(`
      CREATE TABLE IF NOT EXISTS wa_message_logs (
        id SERIAL PRIMARY KEY,
        remote_jid TEXT NOT NULL,
        is_from_me BOOLEAN NOT NULL DEFAULT FALSE,
        message_type TEXT NOT NULL,
        content TEXT,
        timestamp BIGINT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CONSTRAINT fk_remote_jid FOREIGN KEY(remote_jid) REFERENCES wa_contacts(remote_jid) ON DELETE CASCADE
      );
    `);
    console.log('Tabel wa_message_logs berhasil dipastikan.');

    await db.query(`
      CREATE TABLE IF NOT EXISTS wa_auto_replies (
        id SERIAL PRIMARY KEY,
        keyword TEXT UNIQUE NOT NULL,
        response TEXT NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log('Tabel wa_auto_replies berhasil dipastikan.');

    console.log('Migrasi selesai!');
    process.exit(0);
  } catch (err) {
    console.error('Gagal menjalankan migrasi:', err);
    process.exit(1);
  }
}

migrate();
