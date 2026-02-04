const express = require('express');
const db = require('./database');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const moment = require('moment-timezone');

const app = express();
app.use(express.json());
app.use(cors());

const clientId = "5f5aa496-7e16-4ca1-9967-33c768dac6c7";
const clientSecret = "TM1rVhfaFm5YJxKruHo0nWMWC";
const username = "LI9019VKS";
const pin = "5m6uYAScSxQtCmU";
const serverKey = "QtwGEr997XDcmMb1Pq8S5X1N";


// 🔄 Fungsi expired format YYYYMMDDHHmmss
function getExpiredTimestamp(minutesFromNow = 15) {
    return moment.tz('Asia/Jakarta').add(minutesFromNow, 'minutes').format('YYYYMMDDHHmmss');
}

const getFormatNow = () => {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

// 🔐 Fungsi membuat signature untuk request POST VA
function generateSignaturePOST({
    amount,
    expired,
    bank_code,
    partner_reff,
    customer_id,
    customer_name,
    customer_email,
    clientId,
    serverKey
}) {
    const path = '/transaction/create/va';
    const method = 'POST';

    const rawValue = amount + expired + bank_code + partner_reff +
        customer_id + customer_name + customer_email + clientId;
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();

    const signToString = path + method + cleaned;

    return crypto.createHmac("sha256", serverKey).update(signToString).digest("hex");
}

function generateSignatureQRIS({
    amount,
    expired,
    partner_reff,
    customer_id,
    customer_name,
    customer_email,
    clientId,
    serverKey
}) {
    const path = '/transaction/create/qris';
    const method = 'POST';

    const rawValue = amount + expired + partner_reff +
        customer_id + customer_name + customer_email + clientId;
    const cleaned = rawValue.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();

    const signToString = path + method + cleaned;

    return crypto.createHmac("sha256", serverKey).update(signToString).digest("hex");
}

function generatePartnerReff() {
    const prefix = 'INV-782372373627';
    const timestamp = Date.now();
    const randomStr = crypto.randomBytes(4).toString('hex');
    return `${prefix}-${timestamp}-${randomStr}`;
}

app.post('/checkout', async (req, res) => {
    const { nama, no_hp, email, alamat, sharelock, items, total_bayar } = req.body;

    // Mulai Koneksi Khusus untuk Transaksi
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Simpan ke tabel orders
        const [orderResult] = await connection.query(
            `INSERT INTO orders (nama_pemesan, no_hp, email, alamat_catatan, sharelock_url, total_bayar) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [nama, no_hp, email, alamat, sharelock, total_bayar]
        );

        const orderId = orderResult.insertId;

        // 2. Simpan banyak item ke order_items (Looping)
        // Format items: [{ produk_id: 1, qty: 2, harga: 459.000 }, ...]
        const itemQueries = items.map(item => {
            return connection.query(
                `INSERT INTO order_items (order_id, produk_id, jumlah, harga_satuan) 
                 VALUES (?, ?, ?, ?)`,
                [orderId, item.produk_id, item.qty, item.harga]
            );
        });

        await Promise.all(itemQueries);

        // Jika semua berhasil, simpan permanen
        await connection.commit();
        res.status(200).json({ message: "Pesanan berhasil dibuat!", orderId });

    } catch (error) {
        // Jika ada satu saja yang gagal, batalkan semuanya
        await connection.rollback();
        res.status(500).json({ message: "Gagal memproses pesanan", error: error.message });
    } finally {
        connection.release();
    }
});

app.post('/checkout-and-pay', async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const { nama, no_hp, email, alamat, sharelock, items, total_bayar, method, bank_code } = req.body;

        // 1. Generate Info Pembayaran
        const partner_reff = generatePartnerReff();
        const expired = getExpiredTimestamp();
        const customer_id = no_hp; // Gunakan No HP sebagai ID unik customer

        // 2. Simpan Header Pesanan ke tabel 'orders'
        const [orderResult] = await connection.query(
            `INSERT INTO orders (nama_pemesan, no_hp, email, alamat_catatan, sharelock_url, total_bayar, partner_reff, payment_method, status_order) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`,
            [nama, no_hp, email, alamat, sharelock, total_bayar, partner_reff, method]
        );
        const orderId = orderResult.insertId;

        // 3. Simpan Detail Barang ke tabel 'order_items'
        const itemQueries = items.map(item => {
            return connection.query(
                `INSERT INTO order_items (order_id, produk_id, jumlah, harga_satuan) VALUES (?, ?, ?, ?)`,
                [orderId, item.produk_id, item.qty, item.harga]
            );
        });
        await Promise.all(itemQueries);

        // 4. Integrasi API LinkQu
        let linkQuResponse;
        const url_callback = "https://cctv.siappgo.id/callback"; // Ganti dengan domain kamu

        if (method === 'VA') {
            const signature = generateSignaturePOST({
                amount: total_bayar, expired, bank_code, partner_reff,
                customer_id, customer_name: nama, customer_email: email, clientId, serverKey
            });

            const payload = {
                amount: total_bayar, bank_code, partner_reff, customer_id,
                customer_name: nama, customer_email: email, username, pin, expired, signature, url_callback
            };

            const response = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/va', payload, {
                headers: { 'client-id': clientId, 'client-secret': clientSecret }
            });
            linkQuResponse = response.data;

            // Update nomor VA ke database
            await connection.query(`UPDATE orders SET va_number = ? WHERE id = ?`, [linkQuResponse.virtual_account, orderId]);

        } else if (method === 'QRIS') {
            const signature = generateSignatureQRIS({
                amount: total_bayar, expired, partner_reff,
                customer_id, customer_name: nama, customer_email: email, clientId, serverKey
            });

            const payload = {
                amount: total_bayar, partner_reff, customer_id,
                customer_name: nama, customer_email: email, username, pin, expired, signature, url_callback
            };

            const response = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/qris', payload, {
                headers: { 'client-id': clientId, 'client-secret': clientSecret }
            });
            linkQuResponse = response.data;

            // Update URL QRIS ke database
            await connection.query(`UPDATE orders SET qris_url = ? WHERE id = ?`, [linkQuResponse.imageqris, orderId]);
        }

        await connection.commit();

        // Kirim hasil akhir ke Frontend
        res.json({
            status: "Success",
            orderId: orderId,
            payment_info: linkQuResponse
        });

    } catch (err) {
        await connection.rollback();
        console.error("❌ Checkout Gagal:", err.message);
        res.status(500).json({ error: "Gagal memproses pesanan dan pembayaran", detail: err.message });
    } finally {
        connection.release();
    }
});

// ✅ CALLBACK UNTUK UPDATE STATUS JADI 'SUKSES'
app.post('/callback', async (req, res) => {
    try {
        const { partner_reff, status } = req.body; // Sesuaikan dengan payload asli LinkQu

        if (status === 'SUCCESS' || req.body.va_code) { // Logika deteksi sukses
            await db.query(
                `UPDATE orders SET status_order = 'Diproses' WHERE partner_reff = ?`,
                [partner_reff]
            );
            console.log(`✅ Pesanan ${partner_reff} lunas!`);
        }
        res.json({ message: "Callback Received" });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.listen(3000, () => console.log('Server lari di port 3000'));