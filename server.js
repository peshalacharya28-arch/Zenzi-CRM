const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

app.use(express.static(path.join(__dirname, 'public')));

// NCM API Credentials
const NCM_TOKEN = process.env.NCM_TOKEN || '6543202e39d2b90776037483b546f2fb2d3d93c4';
const NCM_FROM_BRANCH = 'KALANKI';

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto-migrate schema with all NCM-required fields
pool.query(`
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    customer_name TEXT,
    phone_number TEXT,
    shipping_address TEXT,
    package_name TEXT,
    cod_amount TEXT,
    to_branch TEXT,
    image_url TEXT,
    status TEXT DEFAULT 'received',
    tracking_id TEXT,
    vref_id TEXT
  );
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_name TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS cod_amount TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS to_branch TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS vref_id TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS image_url TEXT;
`).catch(err => console.error('Database migration error:', err));

// Serve Dashboard UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 1. Fetch live NCM Branch list for frontend search/autocomplete
app.get('/api/branches', async (req, res) => {
  try {
    const response = await axios.get('https://portal.nepalcanmove.com/api/v2/branches', {
      headers: { 'Authorization': `Token ${NCM_TOKEN}` },
      timeout: 10000
    });
    
    // Normalize string vs object formats returned by NCM
    const branches = response.data.map(b => (typeof b === 'object' && b.name ? b.name : b));
    res.json(branches);
  } catch (err) {
    console.error('NCM Branch Fetch Error:', err.message);
    res.json(['KALANKI', 'POKHARA', 'BUTWAL', 'BIRATNAGAR', 'CHITWAN']); // Fallback branches
  }
});

// 2. Fetch all orders
app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve orders' });
  }
});

// 3. Save new order
app.post('/api/orders', async (req, res) => {
  const { customer_name, phone_number, shipping_address, package_name, cod_amount, to_branch, image_url } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO orders 
       (customer_name, phone_number, shipping_address, package_name, cod_amount, to_branch, image_url, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        customer_name, 
        phone_number, 
        shipping_address, 
        package_name || 'Zenzi Bag', 
        cod_amount || '0', 
        to_branch || 'KALANKI', 
        image_url || null, 
        'received'
      ]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Database order creation failed' });
  }
});

// 4. Status Update & LIVE NCM Logistics API Trigger
app.patch('/api/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const orderId = req.params.id;

  try {
    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);

    // TRIGGER LOGISTICS API WHEN DRAGGED TO 'PACKED'
    if (status === 'packed') {
      const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      const order = orderResult.rows[0];

      if (order) {
        // Generate unique VREF ID required by NCM (e.g. Z123456)
        const shortTimestamp = Date.now().toString().slice(-6);
        const vref = `Z${shortTimestamp}`;

        const ncmPayload = {
          name: order.customer_name,
          phone: order.phone_number,
          cod_charge: String(order.cod_amount || '0'),
          address: order.shipping_address,
          fbranch: NCM_FROM_BRANCH,
          branch: order.to_branch || 'KALANKI',
          package: order.package_name || 'Zenzi Product',
          vref_id: vref,
          delivery_type: 'Door2Door',
          weight: '1'
        };

        const ncmResponse = await axios.post(
          'https://portal.nepalcanmove.com/api/v1/order/create',
          ncmPayload,
          {
            headers: {
              'Authorization': `Token ${NCM_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (ncmResponse.status === 200 || ncmResponse.status === 201) {
          const ncmOrderId = ncmResponse.data.orderid || ncmResponse.data.order_id || 'NCM-CREATED';

          // Update tracking ID and shift status to dispatched
          await pool.query(
            "UPDATE orders SET tracking_id = $1, vref_id = $2, status = 'dispatched' WHERE id = $3",
            [String(ncmOrderId), vref, orderId]
          );

          return res.json({ 
            success: true, 
            tracking_id: ncmOrderId, 
            vref_id: vref,
            new_status: 'dispatched' 
          });
        } else {
          return res.status(400).json({ error: 'NCM API rejected order creation', details: ncmResponse.data });
        }
      }
    }

    res.json({ success: true, status });
  } catch (error) {
    console.error('NCM API Trigger Error:', error.response ? error.response.data : error.message);
    res.status(500).json({ 
      error: 'Logistics processing failed', 
      details: error.response ? error.response.data : error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zenzi CRM live on port ${PORT}`));