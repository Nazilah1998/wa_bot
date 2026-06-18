const pool = require("./src/db/index.js");

function getCode(srvIndex, itemIndex) {
    if (itemIndex < 26) return `${srvIndex}${String.fromCharCode(65 + itemIndex)}`;
    // Jika lebih dari 26 item (Z), gunakan AA, AB, dst.
    return `${srvIndex}${String.fromCharCode(65 + Math.floor(itemIndex / 26) - 1)}${String.fromCharCode(65 + (itemIndex % 26))}`;
}

async function seed() {
  try {
    console.log("Mengambil data layanan dari database Kemenag Barito Utara...");
    
    // 1. Ambil data ptsp_services
    const servicesRes = await pool.query("SELECT id, name FROM ptsp_services ORDER BY id ASC");
    const services = servicesRes.rows;

    // 2. Ambil data ptsp_service_items
    const itemsRes = await pool.query("SELECT id, service_id, name, description FROM ptsp_service_items WHERE is_active = true ORDER BY service_id ASC, id ASC");
    const items = itemsRes.rows;

    // 3. Ambil persyaratan
    const reqRes = await pool.query("SELECT service_item_id, document_name, description FROM ptsp_service_requirements ORDER BY sort_order ASC, id ASC");
    const requirements = reqRes.rows;

    const data = [];
    
    // GENERATE MAIN MENU
    let mainMenuText = "🏢 *Selamat Datang di PTSP Kemenag Barito Utara*\n\nSilakan balas dengan mengetik *ANGKA* pilihan menu di bawah ini:\n\n";
    let serviceMap = {};
    
    let serviceIndex = 1;
    for (const srv of services) {
        // Cek apakah service ini punya item layanan aktif
        const myItems = items.filter(i => i.service_id === srv.id);
        if (myItems.length === 0) continue;
        
        serviceMap[srv.id] = { index: serviceIndex, name: srv.name, items: myItems };
        mainMenuText += `${serviceIndex}️⃣ ${srv.name}\n`;
        serviceIndex++;
    }
    mainMenuText += "0️⃣ Informasi Umum & Pengaduan\n\n_Ketik *MENU* kapan saja untuk kembali ke daftar ini._";

    // Mendaftarkan trigger global untuk menu
    const triggers = ['menu', 'halo', 'ping', 'bantuan', 'assalamualaikum', 'p'];
    for(const t of triggers) {
        const prefix = t === 'assalamualaikum' ? 'Waalaikumsalam wr. wb.\n\n' : (t === 'halo' ? 'Halo!\n\n' : '');
        data.push({ keyword: t, response: prefix + mainMenuText });
    }

    // GENERATE LEVEL 1 (Sub-menus for each service)
    for (const srvId in serviceMap) {
        const srv = serviceMap[srvId];
        let subMenuText = `📁 *${srv.name}*\n\nSilakan balas dengan *KODE* untuk melihat persyaratan:\n\n`;
        
        let itemIndex = 0;
        for (const item of srv.items) {
            const code = getCode(srv.index, itemIndex);
            subMenuText += `*${code}* - ${item.name}\n`;
            
            // GENERATE LEVEL 2 (Detail persyaratan untuk setiap item)
            const itemReqs = requirements.filter(r => r.service_item_id === item.id);
            let detailText = `📄 *Syarat ${item.name}:*\n`;
            
            if (item.description && item.description.trim() !== '' && item.description !== 'EMPTY') {
                detailText += `_${item.description}_\n\n`;
            }

            if (itemReqs.length > 0) {
                itemReqs.forEach((r, idx) => {
                    detailText += `${idx + 1}. ${r.document_name}\n`;
                    if (r.description && r.description.trim() !== '') {
                        detailText += `   ~ ${r.description}\n`;
                    }
                });
            } else {
                detailText += `(Belum ada data persyaratan spesifik. Silakan hubungi petugas loket).\n`;
            }
            detailText += `\nBawa dokumen persyaratan ke loket PTSP Kemenag Barito Utara.\n\n_Ketik *${srv.index}* untuk kembali ke ${srv.name}._\n_Ketik *MENU* untuk kembali ke Awal._`;
            
            // Simpan auto-reply untuk item ini (lowercase agar case-insensitive match lebih mudah)
            data.push({ keyword: code.toLowerCase(), response: detailText });
            
            itemIndex++;
        }
        subMenuText += `\n_Ketik *MENU* untuk kembali ke Menu Utama._`;
        
        data.push({ keyword: srv.index.toString(), response: subMenuText });
    }

    // Tambahan menu 0
    data.push({ 
        keyword: '0', 
        response: '🕒 *Informasi Umum PTSP Kemenag Barito Utara*\n\n*Jadwal Pelayanan:*\nSenin - Kamis : 07.30 - 16.00 WIB\nJumat : 07.30 - 16.30 WIB\nSabtu/Minggu : Libur\n\n*Pengaduan*\nUntuk menyampaikan pengaduan terkait pelayanan kami, ketik format:\n*Pengaduan#Nama#Isi Laporan*\n\n_Ketik *MENU* untuk kembali._' 
    });

    console.log("Menghapus data auto-reply lama...");
    await pool.query("TRUNCATE TABLE wa_auto_replies RESTART IDENTITY");

    console.log("Memasukkan menu interaktif tersinkronisasi...");
    for (const item of data) {
      await pool.query(
        "INSERT INTO wa_auto_replies (keyword, response, is_active) VALUES ($1, $2, true)",
        [item.keyword, item.response]
      );
      // console.log(`Disimpan: ${item.keyword}`); // di-comment agar log tidak terlalu panjang
    }
    console.log(`✅ Selesai! Sebanyak ${data.length} Auto-Reply Menu PTSP berhasil di-generate secara live dari Database.`);

  } catch (error) {
    console.error("Error saat sinkronisasi seeding:", error);
  } finally {
    process.exit(0);
  }
}

seed();
