const mysql = require('mysql2');

const pool = mysql.createPool({
    host: process.env.DB_HOST || '31.97.48.240',
    user: process.env.DB_USER || 'mysql',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE || 'cctv',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
}).promise();

// Cek koneksi saat server pertama kali dijalankan
pool.getConnection()
    .then(connection => {
        console.log('✅ Database terhubung: Berhasil masuk ke MySQL.');
        connection.release(); // Kembalikan koneksi ke pool
    })
    .catch(err => {
        console.error('❌ Database gagal terhubung:');
        console.error('Pesan Error:', err.message);

        // Memberikan saran perbaikan berdasarkan error umum
        if (err.code === 'ER_BAD_DB_ERROR') console.error('Tip: Cek apakah nama database sudah benar.');
        if (err.code === 'ECONNREFUSED') console.error('Tip: Cek apakah server MySQL (XAMPP/Docker) sudah nyala.');
    });

module.exports = pool;