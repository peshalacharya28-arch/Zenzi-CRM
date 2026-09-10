const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use(cors());

// Initialize PostgreSQL Connection using Environment Variables
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create table if it doesn't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    customer_name TEXT,
    phone_number TEXT,
    shipping_address TEXT,
    status TEXT DEFAULT 'received',
    tracking_id TEXT
  )
`).catch(err => console.error('Database initialization error:', err));

// 1. Fetch all orders
app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// 2. Create a new lead/order
app.post('/api/orders', async (req, res) => {
  const { customer_name, phone_number, shipping_address } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO orders (customer_name, phone_number, shipping_address, status) VALUES ($1, $2, $3, $4) RETURNING id',
      [customer_name, phone_number, shipping_address, 'received']
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// 3. Update status & Execute Logistics API Call
app.patch('/api/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const orderId = req.params.id;

  try {
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);

    // THE API TRIGGER: Only fires when dragging to "packed"
    if (status === 'packed') {
      const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      const order = orderResult.rows[0];

      if (order) {
        /*
        // UNCOMMENT THIS ONCE YOU HAVE YOUR COURIER API KEYS
        const logisticsPayload = {
          store_id: 'YOUR_STORE_ID',
          recipient_name: order.customer_name,
          recipient_phone: order.phone_number,
          address: order.shipping_address,
          city_id: 1,
          item_weight: 1.0,
          amount_to_collect: 0
        };

        const response = await axios.post('https://api.yourcourier.com/v1/orders', logisticsPayload, {
          headers: { 'Authorization': 'Bearer YOUR_API_TOKEN' }
        });
        const tracking_id = response.data.tracking_number;
        */

        // Simulated API response for testing
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
    res.status(500).json({ error: 'Process failed' });
  }
});

// Dynamic port assignment required by cloud platforms like Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CRM Server running on port ${PORT}`));