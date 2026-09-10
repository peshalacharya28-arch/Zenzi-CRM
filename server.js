const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto-create table and safely patch new image_url column if missing
pool.query(`
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    customer_name TEXT,
    phone_number TEXT,
    shipping_address TEXT,
    image_url TEXT,
    status TEXT DEFAULT 'received',
    tracking_id TEXT
  );
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS image_url TEXT;
`).catch(err => console.error('Database migration error:', err));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/orders', async (req, res) => {
  const { customer_name, phone_number, shipping_address, image_url } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO orders (customer_name, phone_number, shipping_address, image_url, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [customer_name, phone_number, shipping_address, image_url || null, 'received']
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.patch('/api/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const orderId = req.params.id;

  try {
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);

    if (status === 'packed') {
      const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      const order = orderResult.rows[0];

      if (order) {
        const tracking_id = 'NP-' + Math.floor(Math.random() * 1000000);

        await pool.query(
          "UPDATE orders SET tracking_id = $1, status = 'dispatched' WHERE id = $2",
          [tracking_id, orderId]
        );

        return res.json({ success: true, tracking_id, new_status: 'dispatched' });
      }
    }

    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ error: 'Status update failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CRM Server running on port ${PORT}`));