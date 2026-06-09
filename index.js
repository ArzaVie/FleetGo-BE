const express = require('express');
const cors = require('cors');
const pool = require('./db'); // Manggil koneksi database
require('dotenv').config();

const app = express(); // Ini bagian penting yang tadi ilang bang
const PORT = process.env.PORT || 5000;

// Middleware wajib biar bisa baca data dari frontend/Postman
app.use(cors());
app.use(express.json());

// ==========================================
// TAHAP 1: USER MELAKUKAN PEMESANAN KENDARAAN
// ==========================================
app.post('/api/bookings', async (req, res) => {
  try {
    const { user_id, tujuan } = req.body;

    const newBooking = await pool.query(
      'INSERT INTO bookings (user_id, tujuan) VALUES ($1, $2) RETURNING *',
      [user_id, tujuan]
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

// ==========================================
// JALANKAN SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`🚀 Server jalan di port ${PORT}`);
});

// ==========================================
// TAHAP 2: APPROVER (SETUJU / TIDAK)
// ==========================================
app.put('/api/bookings/:id/approve', async (req, res) => {
  try {
    const { id } = req.params; // Nangkep ID pesanan dari URL
    const { status_approver } = req.body; // Nangkep status dari Postman/Frontend

    // Validasi biar inputnya gak ngasal
    if (!['disetujui', 'ditolak'].includes(status_approver)) {
      return res.status(400).json({ error: "Status harus 'disetujui' atau 'ditolak'" });
    }

    // Update status di database
    const updateBooking = await pool.query(
      'UPDATE bookings SET status_approver = $1 WHERE id = $2 RETURNING *',
      [status_approver, id]
    );

    // Kalau ID pesanannya gak ada di database
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
app.post('/api/surat-tugas', async (req, res) => {
  try {
    const { booking_id, admin_id, driver_id, car_id } = req.body;

    // 1. Insert data ke tabel surat_tugas
    const newSuratTugas = await pool.query(
      `INSERT INTO surat_tugas (booking_id, admin_id, driver_id, car_id) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
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

    // Balikin respon sukses
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
app.post('/api/keuangan/persekot', async (req, res) => {
  try {
    const { surat_tugas_id, nominal_persekot } = req.body;

    // Insert pengajuan uang muka ke tabel keuangan_operasional
    const pengajuan = await pool.query(
      `INSERT INTO keuangan_operasional (surat_tugas_id, nominal_persekot) 
       VALUES ($1, $2) RETURNING *`,
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
    const { id } = req.params; // Nangkep ID dari tabel keuangan_operasional
    const { nominal_pengeluaran, file_bukti_pengeluaran } = req.body;

    // Update nominal pengeluaran riil, masukin nama file struk, dan ubah status jadi lunas
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

// Endpoint biar browser gak bingung
app.get('/', (req, res) => {
  res.send('Backend Fleetgo Jalan Mulus Bang! 🚀 Silakan tes API lewat Postman.');
});

