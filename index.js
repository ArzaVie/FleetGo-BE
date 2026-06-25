const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const pool = require('./db'); // Manggil koneksi database
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000; // default ke 8000 agar sesuai frontend

// Middleware wajib biar bisa baca data dari frontend/Postman
app.use(cors());
app.use(express.json());

// Initialize database tables if not exist
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_name VARCHAR(100),
        action TEXT
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trip_checkpoints (
        id SERIAL PRIMARY KEY,
        surat_tugas_id INTEGER REFERENCES surat_tugas(id) ON DELETE CASCADE,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        location TEXT,
        odometer INTEGER
      )
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS foto TEXT;
    `);
    const checkLogs = await pool.query("SELECT COUNT(*) FROM audit_logs");
    if (parseInt(checkLogs.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO audit_logs (user_name, action) VALUES 
        ('System', 'Sistem diinisialisasi'),
        ('Admin Logistik', 'Login ke sistem logistik'),
        ('Manajer Approver', 'Menyetujui pemesanan REQ-1')
      `);
    }
    console.log("Database tables checked/created successfully.");
  } catch (err) {
    console.error("Error initializing DB:", err.message);
  }
}
initDb();


// ==========================================
// MIDDLEWARE JWT AUTHENTICATION
// ==========================================
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: 'Akses ditolak! Token tidak ditemukan.' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'fleetgo_super_secret_key_123_456', (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Token tidak valid!' });
    }
    req.user = user;
    next();
  });
};

// ==========================================
// AUTHENTICATION: LOGIN
// ==========================================
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Cari user berdasarkan email atau nama
    const userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR nama = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: 'Username atau Email tidak terdaftar!' });
    }

    const user = userResult.rows[0];

    // Cek password (plain-text sesuai database seed)
    if (user.password !== password) {
      return res.status(401).json({ message: 'Password salah!' });
    }

    // Buat JWT Token
    const token = jwt.sign(
      { id: user.id, nama: user.nama, email: user.email, role: user.role },
      process.env.JWT_SECRET || 'fleetgo_super_secret_key_123_456',
      { expiresIn: '1d' }
    );

    // Bentuk data user yang aman untuk dikirim (tanpa password)
    const responseUser = {
      id: user.id,
      nama: user.nama,
      email: user.email,
      role: user.role,
      foto: user.foto,
      token: token
    };

    res.status(200).json({
      message: 'Login berhasil!',
      user: responseUser,
      token: token
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Koneksi ke server gagal!' });
  }
});

// Update profile endpoint
app.put('/api/users/profile', authenticateToken, async (req, res) => {
  try {
    const { nama, foto } = req.body;
    const user_id = req.user.id;
    
    await pool.query(
      "UPDATE users SET nama = $1, foto = $2 WHERE id = $3",
      [nama, foto, user_id]
    );

    const userRes = await pool.query(
      "SELECT id, nama, email, role, foto FROM users WHERE id = $1",
      [user_id]
    );

    res.status(200).json({
      message: 'Profil berhasil diperbarui!',
      user: userRes.rows[0]
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});


// ==========================================
// TAHAP 1: USER MELAKUKAN PEMESANAN KENDARAAN
// ==========================================
app.post('/api/bookings', authenticateToken, async (req, res) => {
  try {
    const { tujuan, durasi } = req.body;
    const user_id = req.user.id;
    const finalDurasi = durasi ? parseInt(durasi) : 1;

    const newBooking = await pool.query(
      'INSERT INTO bookings (user_id, tujuan, durasi, status_approver, status_admin) VALUES ($1, $2, $3, \'pending\', \'pending\') RETURNING *',
      [user_id, tujuan, finalDurasi]
    );

    res.status(201).json({
      message: 'Form pemesanan berhasil dikirim, menunggu persetujuan Approver',
      data: newBooking.rows[0]
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// GET MY BOOKINGS (Untuk Driver/User Pelanggan di Frontend)
app.get('/api/my-bookings', authenticateToken, async (req, res) => {
  try {
    const user_id = req.user.id;
    const bookings = await pool.query(
      'SELECT id, tujuan, durasi, status_approver AS status FROM bookings WHERE user_id = $1 ORDER BY id DESC',
      [user_id]
    );
    res.status(200).json(bookings.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// ==========================================
// TAHAP 2: APPROVER (SETUJU / TIDAK)
// ==========================================
app.get('/api/approver/pending', authenticateToken, async (req, res) => {
  try {
    const pending = await pool.query(
      `SELECT b.id, b.tujuan, b.durasi, u.nama AS pelanggan 
       FROM bookings b 
       JOIN users u ON b.user_id = u.id 
       WHERE b.status_approver = 'pending' 
       ORDER BY b.id DESC`
    );
    res.status(200).json(pending.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

app.get('/api/approver/all-bookings', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.tujuan, b.durasi, u.nama AS pelanggan, b.status_approver AS status
       FROM bookings b 
       JOIN users u ON b.user_id = u.id 
       ORDER BY b.id DESC`
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});


app.put('/api/bookings/:id/approve', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status_approver } = req.body;

    if (!['disetujui', 'ditolak'].includes(status_approver)) {
      return res.status(400).json({ error: "Status harus 'disetujui' atau 'ditolak'" });
    }

    const updateBooking = await pool.query(
      'UPDATE bookings SET status_approver = $1 WHERE id = $2 RETURNING *',
      [status_approver, id]
    );

    if (updateBooking.rows.length === 0) {
      return res.status(404).json({ error: 'Data pesanan tidak ditemukan' });
    }

    res.status(200).json({
      message: `Pemesanan berhasil diupdate menjadi: ${status_approver}`,
      data: updateBooking.rows[0]
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// ==========================================
// TAHAP 3: ADMIN BIKIN SURAT TUGAS & CEK MOBIL
// ==========================================
app.get('/api/admin/ready-to-assign', authenticateToken, async (req, res) => {
  try {
    const ready = await pool.query(
      `SELECT b.id, b.tujuan, b.durasi, u.nama AS pelanggan 
       FROM bookings b 
       JOIN users u ON b.user_id = u.id 
       WHERE b.status_approver = 'disetujui' AND b.status_admin = 'pending' 
       ORDER BY b.id DESC`
    );
    res.status(200).json(ready.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

app.get('/api/admin/drivers', authenticateToken, async (req, res) => {
  try {
    const driversRes = await pool.query("SELECT id, nama FROM users WHERE role = 'driver' ORDER BY id");
    const carsRes = await pool.query("SELECT id, merk, plat_nomor, status FROM cars ORDER BY id");

    const drivers = driversRes.rows.map((driver, index) => {
      const car = carsRes.rows[index] || carsRes.rows[0];
      return {
        id: driver.id,
        nama: driver.nama,
        kendaraan: car ? car.merk : 'Tidak ada kendaraan',
        plat: car ? car.plat_nomor : '-',
        car_id: car ? car.id : null,
        car_status: car ? car.status : 'tersedia'
      };
    });

    res.status(200).json(drivers);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

app.post('/api/surat-tugas', authenticateToken, async (req, res) => {
  try {
    const { booking_id, driver_id } = req.body;
    const admin_id = req.user.id;

    // Resolve car_id matched to driver_id
    const driversRes = await pool.query("SELECT id FROM users WHERE role = 'driver' ORDER BY id");
    const carsRes = await pool.query("SELECT id FROM cars ORDER BY id");
    const driverIndex = driversRes.rows.findIndex(d => d.id === parseInt(driver_id));
    const car = carsRes.rows[driverIndex] || carsRes.rows[0];
    const car_id = car ? car.id : 1;

    // 1. Insert data ke tabel surat_tugas
    const newSuratTugas = await pool.query(
      `INSERT INTO surat_tugas (booking_id, admin_id, driver_id, car_id, status_tugas) 
       VALUES ($1, $2, $3, $4, 'ditugaskan') RETURNING *`,
      [booking_id, admin_id, driver_id, car_id]
    );

    // 2. Update status_admin di tabel bookings jadi 'tersedia'
    await pool.query(
      `UPDATE bookings SET status_admin = 'tersedia' WHERE id = $1`,
      [booking_id]
    );

    // 3. Update status mobil di tabel cars jadi 'dipakai'
    await pool.query(
      `UPDATE cars SET status = 'dipakai' WHERE id = $1`,
      [car_id]
    );

    res.status(201).json({
      message: 'Surat tugas berhasil dibuat, mobil dan driver siap jalan!',
      data: newSuratTugas.rows[0]
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// ==========================================
// TAHAP 4: DRIVER MENGAJUKAN PERSEKOT (UANG MUKA)
// ==========================================
app.get('/api/driver/my-task', authenticateToken, async (req, res) => {
  try {
    const driver_id = req.user.id;
    const taskResult = await pool.query(
      `SELECT st.id as id_surat, b.tujuan, st.status_tugas as status,
              c.merk AS mobil, c.plat_nomor AS plat,
              ko.id AS keuangan_id, ko.nominal_persekot, ko.status_persekot,
              ko.nominal_pengeluaran, ko.file_bukti_pengeluaran, ko.status_pelunasan
       FROM surat_tugas st
       JOIN bookings b ON st.booking_id = b.id
       JOIN cars c ON st.car_id = c.id
       LEFT JOIN keuangan_operasional ko ON ko.surat_tugas_id = st.id
       WHERE st.driver_id = $1 AND st.status_tugas != 'selesai'
       LIMIT 1`,
      [driver_id]
    );

    if (taskResult.rows.length === 0) {
      return res.status(200).json(null);
    }

    res.status(200).json(taskResult.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

app.post('/api/driver/persekot', authenticateToken, async (req, res) => {
  try {
    const { nominal } = req.body;
    const driver_id = req.user.id;

    // Find active task
    const taskResult = await pool.query(
      "SELECT id FROM surat_tugas WHERE driver_id = $1 AND status_tugas != 'selesai' LIMIT 1",
      [driver_id]
    );

    if (taskResult.rows.length === 0) {
      return res.status(400).json({ error: 'Tidak ada tugas aktif untuk driver ini!' });
    }

    const surat_tugas_id = taskResult.rows[0].id;

    // Insert pengajuan uang muka ke tabel keuangan_operasional
    const pengajuan = await pool.query(
      `INSERT INTO keuangan_operasional (surat_tugas_id, nominal_persekot, status_persekot) 
       VALUES ($1, $2, 'diajukan') RETURNING *`,
      [surat_tugas_id, nominal]
    );

    res.status(201).json({
      message: 'Pengajuan persekot berhasil dikirim, menunggu pencairan Admin',
      data: pengajuan.rows[0]
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Endpoint persekot legacy (untuk postman)
app.post('/api/keuangan/persekot', async (req, res) => {
  try {
    const { surat_tugas_id, nominal_persekot } = req.body;

    const pengajuan = await pool.query(
      `INSERT INTO keuangan_operasional (surat_tugas_id, nominal_persekot, status_persekot) 
       VALUES ($1, $2, 'diajukan') RETURNING *`,
      [surat_tugas_id, nominal_persekot]
    );

    res.status(201).json({
      message: 'Pengajuan persekot berhasil dikirim, menunggu pencairan Admin',
      data: pengajuan.rows[0]
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// ==========================================
// TAHAP 5: DRIVER SUBMIT BUKTI PENGELUARAN (PELUNASAN)
// ==========================================
app.put('/api/keuangan/pelunasan/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nominal_pengeluaran, file_bukti_pengeluaran } = req.body;

    const pelunasan = await pool.query(
      `UPDATE keuangan_operasional 
       SET nominal_pengeluaran = $1, 
           file_bukti_pengeluaran = $2, 
           status_pelunasan = 'lunas' 
       WHERE id = $3 RETURNING *`,
      [nominal_pengeluaran, file_bukti_pengeluaran, id]
    );

    if (pelunasan.rows.length === 0) {
      return res.status(404).json({ error: 'Data pengajuan persekot tidak ditemukan' });
    }

    res.status(200).json({
      message: 'Bukti pengeluaran berhasil disubmit, urusan operasional selesai (LUNAS)!',
      data: pelunasan.rows[0]
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// ==========================================
// ADDITIONAL EXTENSION ENDPOINTS
// ==========================================

// Driver: update task status
app.put('/api/driver/task/status', authenticateToken, async (req, res) => {
  try {
    const { status_tugas } = req.body;
    const driver_id = req.user.id;
    
    // Find active task
    const task = await pool.query(
      "SELECT id FROM surat_tugas WHERE driver_id = $1 AND status_tugas != 'selesai' LIMIT 1",
      [driver_id]
    );
    if (task.rows.length === 0) return res.status(404).json({ error: 'No active task' });
    const surat_tugas_id = task.rows[0].id;
    
    await pool.query(
      "UPDATE surat_tugas SET status_tugas = $1 WHERE id = $2",
      [status_tugas, surat_tugas_id]
    );
    
    // Log action
    await pool.query(
      "INSERT INTO audit_logs (user_name, action) VALUES ($1, $2)",
      [req.user.nama, `Driver mengubah status tugas #${surat_tugas_id} menjadi "${status_tugas}"`]
    );
    
    res.json({ message: 'Status updated successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Driver: log checkpoint and odometer
app.post('/api/driver/task/checkpoint', authenticateToken, async (req, res) => {
  try {
    const { location, odometer } = req.body;
    const driver_id = req.user.id;
    
    const task = await pool.query(
      "SELECT id FROM surat_tugas WHERE driver_id = $1 AND status_tugas != 'selesai' LIMIT 1",
      [driver_id]
    );
    if (task.rows.length === 0) return res.status(404).json({ error: 'No active task' });
    const surat_tugas_id = task.rows[0].id;
    
    await pool.query(
      "INSERT INTO trip_checkpoints (surat_tugas_id, location, odometer) VALUES ($1, $2, $3)",
      [surat_tugas_id, location, odometer ? parseInt(odometer) : 0]
    );
    
    // Log action
    await pool.query(
      "INSERT INTO audit_logs (user_name, action) VALUES ($1, $2)",
      [req.user.nama, `Driver mencatat checkpoint di "${location}" (Odometer: ${odometer} km) untuk tugas #${surat_tugas_id}`]
    );
    
    res.json({ message: 'Checkpoint logged successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// GET: checkpoints for a task
app.get('/api/driver/task/checkpoints/:surat_tugas_id', authenticateToken, async (req, res) => {
  try {
    const { surat_tugas_id } = req.params;
    const result = await pool.query(
      "SELECT location, odometer, timestamp FROM trip_checkpoints WHERE surat_tugas_id = $1 ORDER BY timestamp DESC",
      [parseInt(surat_tugas_id)]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Dispatcher: GET active tasks
app.get('/api/admin/active-tasks', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT st.id, st.status_tugas, b.tujuan, b.durasi, 
              u_client.nama AS pelanggan, u_driver.nama AS driver, 
              c.merk AS mobil, c.plat_nomor AS plat, st.car_id, st.booking_id,
              ko.id AS keuangan_id, ko.nominal_persekot, ko.status_persekot,
              ko.nominal_pengeluaran, ko.file_bukti_pengeluaran, ko.status_pelunasan
       FROM surat_tugas st
       JOIN bookings b ON st.booking_id = b.id
       JOIN users u_client ON b.user_id = u_client.id
       JOIN users u_driver ON st.driver_id = u_driver.id
       JOIN cars c ON st.car_id = c.id
       LEFT JOIN keuangan_operasional ko ON ko.surat_tugas_id = st.id
       WHERE st.status_tugas != 'selesai'
       ORDER BY st.id DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Dispatcher: Close task ("ACC Tanda Tugas")
app.put('/api/admin/tasks/:id/close', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const st = await pool.query("SELECT car_id, booking_id FROM surat_tugas WHERE id = $1", [parseInt(id)]);
    if (st.rows.length === 0) return res.status(404).json({ error: 'Surat tugas not found' });
    const { car_id, booking_id } = st.rows[0];

    // Update surat_tugas status to selesai
    await pool.query("UPDATE surat_tugas SET status_tugas = 'selesai' WHERE id = $1", [parseInt(id)]);
    // Update car status to tersedia
    await pool.query("UPDATE cars SET status = 'tersedia' WHERE id = $1", [car_id]);
    // Update booking status_admin to 'selesai'
    await pool.query("UPDATE bookings SET status_admin = 'selesai' WHERE id = $1", [booking_id]);

    // Log action
    await pool.query(
      "INSERT INTO audit_logs (user_name, action) VALUES ($1, $2)",
      [req.user.nama, `Dispatcher menutup surat tugas #${id} ("ACC Tanda Tugas") dan merilis mobil ID ${car_id}`]
    );
    
    res.json({ message: 'Task closed and vehicle released' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Dispatcher: GET pending persekot (uang muka)
app.get('/api/admin/keuangan-pending', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ko.id, ko.nominal_persekot, ko.status_persekot, st.id AS surat_tugas_id,
              u.nama AS driver, b.tujuan
       FROM keuangan_operasional ko
       JOIN surat_tugas st ON ko.surat_tugas_id = st.id
       JOIN users u ON st.driver_id = u.id
       JOIN bookings b ON st.booking_id = b.id
       WHERE ko.status_persekot = 'diajukan'
       ORDER BY ko.id DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Dispatcher: Liquefy persekot (cairkan dana)
app.put('/api/admin/keuangan/:id/cair', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
      "UPDATE keuangan_operasional SET status_persekot = 'cair' WHERE id = $1",
      [parseInt(id)]
    );
    
    // Log action
    await pool.query(
      "INSERT INTO audit_logs (user_name, action) VALUES ($1, $2)",
      [req.user.nama, `Dispatcher mencairkan dana persekot pengajuan ID ${id}`]
    );
    
    res.json({ message: 'Persekot status updated to cair' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Super Admin: GET all users
app.get('/api/admin/users', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, nama, email, role FROM users ORDER BY id");
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Super Admin: Update user role
app.put('/api/admin/users/:id/role', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    await pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, parseInt(id)]);
    
    // Log action
    await pool.query(
      "INSERT INTO audit_logs (user_name, action) VALUES ($1, $2)",
      [req.user.nama, `Super Admin mengubah role user ID ${id} menjadi "${role}"`]
    );
    
    res.json({ message: 'User role updated' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Super Admin: GET audit logs
app.get('/api/admin/audit-logs', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, timestamp, user_name, action FROM audit_logs ORDER BY id DESC LIMIT 100");
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Super Admin: Purge legacy data
app.post('/api/admin/purge', authenticateToken, async (req, res) => {
  try {
    // Delete keuangan operasional, trip checkpoints, and then surat tugas for completed tasks
    await pool.query(`
      DELETE FROM keuangan_operasional 
      WHERE surat_tugas_id IN (SELECT id FROM surat_tugas WHERE status_tugas = 'selesai')
    `);
    await pool.query(`
      DELETE FROM trip_checkpoints 
      WHERE surat_tugas_id IN (SELECT id FROM surat_tugas WHERE status_tugas = 'selesai')
    `);
    const result = await pool.query(`
      DELETE FROM surat_tugas WHERE status_tugas = 'selesai' RETURNING id
    `);
    
    // Log action
    await pool.query(
      "INSERT INTO audit_logs (user_name, action) VALUES ($1, $2)",
      [req.user.nama, `Super Admin melakukan pembersihan data tugas selesai (${result.rows.length} item dihapus)`]
    );
    
    res.json({ message: `Purged ${result.rows.length} completed tasks` });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server Error' });
  }
});

// Endpoint default
app.get('/', (req, res) => {
  res.send('Backend Fleetgo Jalan Mulus Bang! 🚀 Silakan tes API lewat Postman.');
});

app.listen(PORT, () => {
  console.log(`🚀 Server jalan di port ${PORT}`);
});
