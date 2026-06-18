const pool = require('./src/db/index.js');

async function inspect() {
    try {
        const services = await pool.query('SELECT * FROM ptsp_services');
        console.log('Services:', services.rows);
        
        const items = await pool.query('SELECT * FROM ptsp_service_items LIMIT 5');
        console.log('Items:', items.rows);
    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        process.exit(0);
    }
}

inspect();
