const mysql = require('mysql2');

const pool = mysql.createPool({
    host: '31.97.48.240',
    user: 'mysql',
    password: 'e2O1NDe4THqfYTA7j8ngeViAkn0aQwN7ahYURnTFWKghVyW6KbRgcxshB2sUy2cd',
    database: 'cctv',
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