const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

app.use(express.static(path.join(__dirname, 'public')));

const NCM_TOKEN = process.env.NCM_TOKEN || '6543202e39d2b90776037483b546f2fb2d3d93c4';
const NCM_FROM_BRANCH = 'KALANKI';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.query(`
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    customer_name TEXT,
    phone_number TEXT,
    phone2 TEXT,
    shipping_address TEXT,
    package_name TEXT,
    cod_amount TEXT,
    to_branch TEXT,
    instruction TEXT,
    delivery_type TEXT DEFAULT 'Door2Door',
    status TEXT DEFAULT 'received',
    tracking_id TEXT,
    vref_id TEXT
  );
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS phone2 TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS instruction TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_type TEXT DEFAULT 'Door2Door';
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS package_name TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS cod_amount TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS to_branch TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS vref_id TEXT;
`).catch(err => console.error('Database migration error:', err));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/branches', async (req, res) => {
  try {
    const response = await axios.get('https://portal.nepalcanmove.com/api/v2/branches', {
      headers: { 'Authorization': `Token ${NCM_TOKEN}` },
      timeout: 10000
    });
    const branches = response.data.map(b => (typeof b === 'object' && b.name ? b.name : b));
    res.json(branches);
  } catch (err) {
    res.json(['KALANKI', 'POKHARA', 'BUTWAL', 'BIRATNAGAR', 'CHITWAN', 'DHARAN', 'JHAPA']);
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve orders' });
  }
});

app.post('/api/orders', async (req, res) => {
  const { 
    customer_name, phone_number, phone2, shipping_address, 
    package_name, cod_amount, to_branch, instruction, delivery_type 
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO orders 
       (customer_name, phone_number, phone2, shipping_address, package_name, cod_amount, to_branch, instruction, delivery_type, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        customer_name, phone_number, phone2 || null, shipping_address, 
        package_name || 'Zenzi Bag', cod_amount || '0', to_branch || 'KALANKI', 
        instruction || null, delivery_type || 'Door2Door', 'received'
      ]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Database order creation failed' });
  }
});

app.patch('/api/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const orderId = req.params.id;

  try {
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = orderResult.rows[0];

    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (status === 'packed' && !order.tracking_id) {
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
        delivery_type: order.delivery_type || 'Door2Door',
        weight: '1'
      };

      if (order.phone2) ncmPayload.phone2 = order.phone2;
      if (order.instruction) ncmPayload.instruction = order.instruction;

      const ncmResponse = await axios.post(
        'https://portal.nepalcanmove.com/api/v1/order/create',
        ncmPayload,
        { headers: { 'Authorization': `Token ${NCM_TOKEN}`, 'Content-Type': 'application/json' } }
      );

      if (ncmResponse.status === 200 || ncmResponse.status === 201) {
        const ncmOrderId = ncmResponse.data.orderid || ncmResponse.data.order_id || 'NCM-CREATED';

        await pool.query(
          "UPDATE orders SET tracking_id = $1, vref_id = $2, status = 'packed' WHERE id = $3",
          [String(ncmOrderId), vref, orderId]
        );
        return res.json({ success: true, tracking_id: ncmOrderId, vref_id: vref, new_status: 'packed' });
      } else {
        return res.status(400).json({ error: 'NCM API rejected order creation', details: ncmResponse.data });
      }
    }

    await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ error: 'Logistics processing failed', details: error.response ? error.response.data : error.message });
  }
});

app.post('/api/orders/sync', async (req, res) => {
  try {
    const activeOrders = await pool.query("SELECT * FROM orders WHERE tracking_id IS NOT NULL AND status IN ('packed', 'processing')");
    let updatedCount = 0;

    for (const order of activeOrders.rows) {
      try {
        const response = await axios.get(`https://portal.nepalcanmove.com/api/v1/order/status?id=${order.tracking_id}`, {
          headers: { 'Authorization': `Token ${NCM_TOKEN}` },
          timeout: 5000
        });

        const statusText = JSON.stringify(response.data).toLowerCase();
        let newStatus = order.status;

        if (statusText.includes('delivered')) {
          newStatus = 'delivered';
        } else if (statusText.includes('dispatched') || statusText.includes('transit')) {
          newStatus = 'processing';
        }

        if (newStatus !== order.status) {
          await pool.query("UPDATE orders SET status = $1 WHERE id = $2", [newStatus, order.id]);
          updatedCount++;
        }
      } catch (err) {}
    }
    res.json({ success: true, synced: updatedCount });
  } catch (err) {
    res.status(500).json({ error: 'Sync failed' });
  }
});

// NEW DELETE ENDPOINT
app.delete('/api/orders/:id', async (req, res) => {
  const orderId = req.params.id;
  try {
    await pool.query('DELETE FROM orders WHERE id = $1', [orderId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zenzi CRM live on port ${PORT}`));