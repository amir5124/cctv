const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const moment = require('moment-timezone');
const mysql = require('mysql2');

const app = express();
app.use(express.json());
app.use(cors());

const clientId = "5f5aa496-7e16-4ca1-9967-33c768dac6c7";
const clientSecret = "TM1rVhfaFm5YJxKruHo0nWMWC";
const username = "LI9019VKS";
const pin = "5m6uYAScSxQtCmU";
const serverKey = "QtwGEr997XDcmMb1Pq8S5X1N";

// --- PERBAIKAN DI SINI ---
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'uksc8scgkkcw0wk0ooc8008s',
    user: process.env.DB_USER || 'mysql',
    password: process.env.DB_PASSWORD || 'e2O1NDe4THqfYTA7j8ngeViAkn0aQwN7ahYURnTFWKghVyW6KbRgcxshB2sUy2cd',
    database: process.env.DB_DATABASE || 'cctv',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
}).promise();

// Test Koneksi
pool.getConnection()
    .then(connection => {
        console.log('✅ Database terhubung: Berhasil masuk ke MySQL.');
        connection.release();
    })
    .catch(err => {
        console.error('❌ Database gagal terhubung:', err.message);
    });

// --- HELPERS ---
function getExpiredTimestamp(minutesFromNow = 15) {
    return moment.tz('Asia/Jakarta').add(minutesFromNow, 'minutes').format('YYYYMMDDHHmmss');
}

function generateSignaturePOST({ amount, expired, bank_code, partner_reff, customer_id, customer_name, customer_email, clientId, serverKey }) {
    const path = '/transaction/create/va';
    const method = 'POST';
    const rawValue = amount + expired + bank_code + partner_reff + customer_id + customer_name + customer_email + clientId;
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
    return crypto.createHmac("sha256", serverKey).update(path + method + cleaned).digest("hex");
}

function generateSignatureQRIS({ amount, expired, partner_reff, customer_id, customer_name, customer_email, clientId, serverKey }) {
    const path = '/transaction/create/qris';
    const method = 'POST';
    const rawValue = amount + expired + partner_reff + customer_id + customer_name + customer_email + clientId;
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
    return crypto.createHmac("sha256", serverKey).update(path + method + cleaned).digest("hex");
}

function generatePartnerReff() {
    return `INV-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

// --- ENDPOINT PRODUK ---
app.get('/products', async (req, res) => {
    try {
        // PERBAIKAN: Menggunakan pool, bukan db
        const [rows] = await pool.query('SELECT * FROM produk ORDER BY created_at DESC');
        console.log(`✅ Berhasil mengambil ${rows.length} produk`);
        res.json(rows);
    } catch (err) {
        console.error("❌ Gagal mengambil data produk:", err.message);
        res.status(500).json({ error: "Internal Server Error", detail: err.message });
    }
});

// --- ENDPOINT CHECKOUT & PAY ---
app.post('/checkout-and-pay', async (req, res) => {
    let connection;
    try {
        // PERBAIKAN: Menggunakan pool
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const { nama, no_hp, email, alamat, sharelock, items, total_bayar, method, bank_code } = req.body;
        const partner_reff = generatePartnerReff();
        const expired = getExpiredTimestamp();
        const customer_id = no_hp;

        // 1. Simpan Header Pesanan
        const [orderResult] = await connection.query(
            `INSERT INTO orders (nama_pemesan, no_hp, email, alamat_catatan, sharelock_url, total_bayar, partner_reff, payment_method, status_order) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`,
            [nama, no_hp, email, alamat, sharelock, total_bayar, partner_reff, method]
        );
        const orderId = orderResult.insertId;

        // 2. Simpan Detail Barang
        for (const item of items) {
            await connection.query(
                `INSERT INTO order_items (order_id, produk_id, jumlah, harga_satuan) VALUES (?, ?, ?, ?)`,
                [orderId, item.produk_id, item.qty, item.harga]
            );
        }

        // 3. LinkQu API Request
        let linkQuResponse;
        const url_callback = "https://cctv.siappgo.id/callback";

        if (method === 'VA') {
            const b_code = bank_code || 'BNI';
            const signature = generateSignaturePOST({
                amount: total_bayar, expired, bank_code: b_code, partner_reff,
                customer_id, customer_name: nama, customer_email: email, clientId, serverKey
            });

            const response = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/va', {
                amount: total_bayar, bank_code: b_code, partner_reff, customer_id,
                customer_name: nama, customer_email: email, username, pin, expired, signature, url_callback
            }, { headers: { 'client-id': clientId, 'client-secret': clientSecret } });

            linkQuResponse = response.data;
            await connection.query(`UPDATE orders SET va_number = ? WHERE id = ?`, [linkQuResponse.virtual_account, orderId]);

        } else {
            const signature = generateSignatureQRIS({
                amount: total_bayar, expired, partner_reff,
                customer_id, customer_name: nama, customer_email: email, clientId, serverKey
            });

            const response = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/qris', {
                amount: total_bayar, partner_reff, customer_id,
                customer_name: nama, customer_email: email, username, pin, expired, signature, url_callback
            }, { headers: { 'client-id': clientId, 'client-secret': clientSecret } });

            linkQuResponse = response.data;
            await connection.query(`UPDATE orders SET qris_url = ? WHERE id = ?`, [linkQuResponse.imageqris, orderId]);
        }

        await connection.commit();
        res.json({ status: "Success", orderId, payment_info: linkQuResponse });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error("❌ Checkout Gagal:", err.message);
        res.status(500).json({ error: "Gagal memproses pesanan", detail: err.message });
    } finally {
        if (connection) connection.release();
    }
});

// CALLBACK
app.post('/callback', async (req, res) => {
    try {
        const { partner_reff, status } = req.body;
        // PERBAIKAN: Menggunakan pool
        await pool.query(`UPDATE orders SET status_order = 'Diproses' WHERE partner_reff = ?`, [partner_reff]);
        res.json({ message: "OK" });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.listen(3000, () => console.log('🚀 Server lari di port 3000'));