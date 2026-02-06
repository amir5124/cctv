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
const ADMIN_WA = "whatsapp:+6282323907426"; // Nomor Admin
const TWILIO_WA = "whatsapp:+62882005447472"; // Nomor Sandbox Twilio Anda

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

async function sendWhatsApp(to, message) {
    try {
        await client.messages.create({
            from: TWILIO_WA,
            to: `whatsapp:${to.replace(/^0/, '+62')}`, // Convert 08... ke +628...
            body: message
        });
        console.log(`✅ WA Terkirim ke ${to}`);
    } catch (err) {
        console.error(`❌ Gagal kirim WA ke ${to}:`, err.message);
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

        // 3. LinkQu API
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

        // 4. KIRIM WHATSAPP NOTIFIKASI
        const msgBuyer = `Halo *${nama}*, pesanan Anda telah diterima!\n\n` +
            `*Detail Order:* \n${itemDetailsText}\n` +
            `*Total:* Rp${formatIDR(total_bayar)}\n` +
            `*Metode:* ${method}\n` +
            `*Status:* Menunggu Pembayaran\n\n` +
            `Silakan selesaikan pembayaran sebelum expired. Terima kasih!`;

        const msgAdmin = `🔔 *PESANAN BARU MASUK*\n\n` +
            `*Pelanggan:* ${nama} (${no_hp})\n` +
            `*Item:* \n${itemDetailsText}\n` +
            `*Total:* Rp${formatIDR(total_bayar)}\n` +
            `*Alamat:* ${alamat}\n` +
            `*Maps:* ${sharelock || '-'}\n` +
            `*ID Ref:* ${partner_reff}`;

        // KIRIM KE PEMBELI
        await sendWhatsApp(no_hp, msgBuyer);

        // KIRIM KE ADMIN (Sekarang menggunakan variabel ADMIN_WA agar tidak disable)
        await sendWhatsApp(ADMIN_WA, msgAdmin);

        res.json({ status: "Success", orderId, payment_info: linkQuResponse });



    } catch (err) {
        if (connection) await connection.rollback();
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
            // Opsional: Kirim WA "Pembayaran Berhasil" di sini
        }
        res.json({ message: "OK" });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.listen(3000, () => console.log('🚀 Server running on port 3000'));