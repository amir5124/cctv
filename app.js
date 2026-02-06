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

// --- KONFIGURASI ---
const clientId = "5f5aa496-7e16-4ca1-9967-33c768dac6c7";
const clientSecret = "TM1rVhfaFm5YJxKruHo0nWMWC";
const username = "LI9019VKS";
const pin = "5m6uYAScSxQtCmU";
const serverKey = "QtwGEr997XDcmMb1Pq8S5X1N";

// Twilio Config
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = require('twilio')(accountSid, authToken);

const ADMIN_WA = "whatsapp:+6282323907426";
const TWILIO_WA = "whatsapp:+62882005447472";

// Database Pool
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
 * WhatsApp Template Builder
 * Mengirim pesan dengan format variabel {{1}}, {{2}}, dst.
 */
async function sendWhatsAppMessage(to, templateData, isForAdmin = false) {
    try {
        let bodyText = "";
        let targetNumber = to.includes('whatsapp:') ? to : `whatsapp:${to.replace(/^0/, '+62')}`;

        if (isForAdmin) {
            // Template Admin
            bodyText = `pesanan baru masuk! 🔔\n\n` +
                `pelanggan: ${templateData.nama} (${templateData.hp})\n` +
                `item: \n${templateData.detail}\n` +
                `total: Rp${formatIDR(templateData.total)}\n` +
                `alamat: ${templateData.alamat}\n` +
                `id ref: ${templateData.reff}`;
        } else {
            // Template Pembeli
            bodyText = `halo ${templateData.nama}, pesanan anda telah diterima!\n\n` +
                `detail order: \n${templateData.detail}\n` +
                `total: Rp${formatIDR(templateData.total)}\n` +
                `metode: ${templateData.metode}\n` +
                `status: menunggu pembayaran\n\n` +
                `silakan selesaikan pembayaran sebelum expired. terima kasih!`;
        }

        await client.messages.create({
            from: TWILIO_WA,
            to: targetNumber,
            body: bodyText
        });

        console.log(`✅ wa terkirim ke ${targetNumber}`);
    } catch (err) {
        console.error(`❌ gagal kirim wa:`, err.message);
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

        // 1. Simpan Orders
        const [orderResult] = await connection.query(
            `INSERT INTO orders (nama_pemesan, no_hp, email, alamat_catatan, sharelock_url, total_bayar, partner_reff, payment_method, status_order) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`,
            [nama, no_hp, email, alamat, sharelock, total_bayar, partner_reff, method]
        );
        const orderId = orderResult.insertId;

        // 2. Simpan Items & Rakit Pesan WA
        let itemDetailsText = "";
        for (const item of items) {
            await connection.query(
                `INSERT INTO order_items (order_id, produk_id, jumlah, harga_satuan) VALUES (?, ?, ?, ?)`,
                [orderId, item.produk_id, item.qty, item.harga]
            );
            itemDetailsText += `- ${item.nama_produk || 'Produk'} (x${item.qty}): Rp${formatIDR(item.harga * item.qty)}\n`;
        }

        // 3. LinkQu API Request
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

        // 4. KIRIM NOTIFIKASI VIA TEMPLATE BUILDER

        // Data untuk Pembeli
        await sendWhatsAppMessage(no_hp, {
            nama: nama,
            detail: itemDetailsText,
            total: total_bayar,
            metode: method
        }, false);

        // Data untuk Admin (Menggunakan variabel ADMIN_WA)
        await sendWhatsAppMessage(ADMIN_WA, {
            nama: nama,
            hp: no_hp,
            detail: itemDetailsText,
            total: total_bayar,
            alamat: alamat,
            reff: partner_reff
        }, true);

        res.json({ status: "Success", orderId, payment_info: linkQuResponse });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error("checkout gagal:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) connection.release();
    }
});

app.post('/callback', async (req, res) => {
    try {
        const { partner_reff, status } = req.body;
        if (status === "SUCCESS") {
            await pool.query(`UPDATE orders SET status_order = 'Diproses' WHERE partner_reff = ?`, [partner_reff]);
        }
        res.json({ message: "OK" });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.listen(3000, () => console.log('🚀 server lari di port 3000'));