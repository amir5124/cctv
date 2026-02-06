require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const moment = require('moment-timezone');
const mysql = require('mysql2');

const app = express();
app.use(express.json());
app.use(cors());

// --- KONFIGURASI API LINKQU ---
const clientId = "5f5aa496-7e16-4ca1-9967-33c768dac6c7";
const clientSecret = "TM1rVhfaFm5YJxKruHo0nWMWC";
const username = "LI9019VKS";
const pin = "5m6uYAScSxQtCmU";
const serverKey = "QtwGEr997XDcmMb1Pq8S5X1N";

// --- KONFIGURASI TWILIO ---
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = require('twilio')(accountSid, authToken);

const ADMIN_WA = "whatsapp:+6282323907426";
const TWILIO_WA = "whatsapp:+62882005447472";

/** * KONFIGURASI CONTENT SID 
 * Masukkan kode HX... dari Twilio Dashboard setelah di-approve
 */
const SID_SUKSES_PEMBELI = 'HX089365c0c4aed489db21e53b5b9a8660';
const SID_SUKSES_ADMIN = 'HXb0baf5fe7928c3055396de2dab232084';

// --- DATABASE POOL ---
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'uksc8scgkkcw0wk0ooc8008s',
    user: process.env.DB_USER || 'mysql',
    password: process.env.DB_PASSWORD || 'e2O1NDe4THqfYTA7j8ngeViAkn0aQwN7ahYURnTFWKghVyW6KbRgcxshB2sUy2cd',
    database: process.env.DB_DATABASE || 'cctv',
    waitForConnections: true,
    connectionLimit: 10
}).promise();

// --- HELPERS ---
const formatIDR = (val) => new Intl.NumberFormat('id-ID').format(val);

/**
 * Fungsi Pengirim WhatsApp menggunakan Template (Content SID)
 */
async function sendWhatsAppTemplate(to, contentSid, contentVariables) {
    try {
        let targetNumber = to.includes('whatsapp:') ? to : `whatsapp:${to.replace(/^0/, '+62')}`;
        await client.messages.create({
            from: TWILIO_WA,
            to: targetNumber,
            contentSid: contentSid,
            contentVariables: JSON.stringify(contentVariables)
        });
        console.log(`✅ Template terkirim ke ${targetNumber}`);
    } catch (err) {
        console.error(`❌ Gagal kirim template ke ${to}:`, err.message);
    }
}

function getExpiredTimestamp(minutesFromNow = 15) {
    return moment.tz('Asia/Jakarta').add(minutesFromNow, 'minutes').format('YYYYMMDDHHmmss');
}

// --- SIGNATURE GENERATORS ---
function generateSignaturePOST(data) {
    const path = '/transaction/create/va';
    const method = 'POST';
    const rawValue = data.amount + data.expired + data.bank_code + data.partner_reff + data.customer_id + data.customer_name + data.customer_email + clientId;
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
    return crypto.createHmac("sha256", serverKey).update(path + method + cleaned).digest("hex");
}

function generateSignatureQRIS(data) {
    const path = '/transaction/create/qris';
    const method = 'POST';
    const rawValue = data.amount + data.expired + data.partner_reff + data.customer_id + data.customer_name + data.customer_email + clientId;
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
    return crypto.createHmac("sha256", serverKey).update(path + method + cleaned).digest("hex");
}

// --- ENDPOINTS ---

app.get('/products', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM produk ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/checkout-and-pay', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const { nama, no_hp, email, alamat, sharelock, items, total_bayar, method, bank_code } = req.body;
        const partner_reff = `INV-${Date.now()}`;
        const expired = getExpiredTimestamp();
        const customer_id = no_hp;

        const [orderResult] = await connection.query(
            `INSERT INTO orders (nama_pemesan, no_hp, email, alamat_catatan, sharelock_url, total_bayar, partner_reff, payment_method, status_order) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`,
            [nama, no_hp, email, alamat, sharelock, total_bayar, partner_reff, method]
        );
        const orderId = orderResult.insertId;

        for (const item of items) {
            await connection.query(
                `INSERT INTO order_items (order_id, produk_id, jumlah, harga_satuan) VALUES (?, ?, ?, ?)`,
                [orderId, item.produk_id, item.qty, item.harga]
            );
        }

        let linkQuResponse;
        const url_callback = "https://cctv.siappgo.id/callback";

        if (method === 'VA') {
            const b_code = bank_code || 'BNI';
            const signature = generateSignaturePOST({ amount: total_bayar, expired, bank_code: b_code, partner_reff, customer_id, customer_name: nama, customer_email: email });
            const resp = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/va', {
                amount: total_bayar, bank_code: b_code, partner_reff, customer_id, customer_name: nama, customer_email: email, username, pin, expired, signature, url_callback
            }, { headers: { 'client-id': clientId, 'client-secret': clientSecret } });
            linkQuResponse = resp.data;
        } else {
            const signature = generateSignatureQRIS({ amount: total_bayar, expired, partner_reff, customer_id, customer_name: nama, customer_email: email });
            const resp = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/qris', {
                amount: total_bayar, partner_reff, customer_id, customer_name: nama, customer_email: email, username, pin, expired, signature, url_callback
            }, { headers: { 'client-id': clientId, 'client-secret': clientSecret } });
            linkQuResponse = resp.data;
        }

        await connection.commit();

        // Response checkout sukses (tanpa kirim WA dulu)
        res.json({ status: "Success", orderId, partner_reff, payment_info: linkQuResponse });

    } catch (err) {
        if (connection) await connection.rollback();
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) connection.release();
    }
});

// --- CALLBACK ENDPOINT (KIRIM NOTIFIKASI SAAT STATUS SUCCESS) ---
app.post('/callback', async (req, res) => {
    try {
        const { partner_reff, status } = req.body;

        if (status === "SUCCESS") {
            // 1. Update status order di database
            await pool.query(`UPDATE orders SET status_order = 'Diproses' WHERE partner_reff = ?`, [partner_reff]);

            // 2. Ambil data order & list detail produk dari database
            const [orderRows] = await pool.query(
                `SELECT o.*, 
                (SELECT GROUP_CONCAT(CONCAT('- ', p.nama_produk, ' (x', oi.jumlah, ')') SEPARATOR '\n') 
                 FROM order_items oi 
                 JOIN produk p ON oi.produk_id = p.id 
                 WHERE oi.order_id = o.id) as detail_produk
                 FROM orders o WHERE o.partner_reff = ?`, [partner_reff]
            );

            if (orderRows.length > 0) {
                const order = orderRows[0];
                const listProduk = order.detail_produk || '-';

                // 1. Kirim Template Sukses ke Pembeli (Sekarang ada Detail Pesanan)
                await sendWhatsAppTemplate(order.no_hp, SID_SUKSES_PEMBELI, {
                    "1": order.nama_pemesan,
                    "2": partner_reff,
                    "3": listProduk // Variabel baru untuk pembeli
                });

                // 2. Kirim Template Sukses ke Admin
                await sendWhatsAppTemplate(ADMIN_WA, SID_SUKSES_ADMIN, {
                    "1": order.nama_pemesan,
                    "2": order.no_hp,
                    "3": formatIDR(order.total_bayar),
                    "4": partner_reff,
                    "5": listProduk,
                    "6": order.alamat_catatan,
                    "7": order.sharelock_url || 'tidak disertakan'
                });
            }
        }
        res.json({ message: "OK" });
    } catch (err) {
        console.error("callback error:", err.message);
        res.status(500).send(err.message);
    }
});

app.listen(3000, () => console.log('🚀 server lari di port 3000'));