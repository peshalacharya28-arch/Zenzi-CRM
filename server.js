const express = require('express');
const sqlite3 = require(']@db.pnecdxsqaevyvsnibdcu.supabase.co:5432/').verbose();
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.static('public')); // Serves your frontend UI
app.use(cors());

// Initialize SQLite Database
const db = new sqlite3.Database('./crm.db');

db.run(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT,
    phone_number TEXT,
    shipping_address TEXT,
    status TEXT DEFAULT 'received',
    tracking_id TEXT
  )
`);

// 1. Fetch all orders
app.get('/api/orders', (req, res) => {
  db.all('SELECT * FROM orders', [], (err, rows) => {
    res.json(rows);
  });
});

// 2. Create a new lead/order
app.post('/api/orders', (req, res) => {
  const { customer_name, phone_number, shipping_address } = req.body;
  db.run(
    'INSERT INTO orders (customer_name, phone_number, shipping_address, status) VALUES (?, ?, ?, ?)',
    [customer_name, phone_number, shipping_address, 'received'],
    function (err) {
      res.json({ id: this.lastID });
    }
  );
});

// 3. Update status & Execute Logistics API Call
app.patch('/api/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const orderId = req.params.id;

  db.run('UPDATE orders SET status = ? WHERE id = ?', [status, orderId], async (err) => {
    
    // THE API TRIGGER: Only fires when dragging to "packed"
    if (status === 'packed') {
      db.get('SELECT * FROM orders WHERE id = ?', [orderId], async (err, order) => {
        try {
          // Map your DB fields to the Courier's required JSON schema
          const logisticsPayload = {
            store_id: 'YOUR_STORE_ID',
            recipient_name: order.customer_name,
            recipient_phone: order.phone_number,
            address: order.shipping_address,
            city_id: 1, // Standardized routing ID
            item_weight: 1.0,
            amount_to_collect: 0
          };

          /* 
          // UNCOMMENT THIS ONCE YOU HAVE YOUR COURIER API KEYS
          const response = await axios.post('https://api.yourcourier.com/v1/orders', logisticsPayload, {
            headers: { 'Authorization': 'Bearer YOUR_API_TOKEN' }
          });
          const tracking_id = response.data.tracking_number;
          */
          
          // Simulated API response for testing
          const tracking_id = 'NP-' + Math.floor(Math.random() * 1000000);

          // Save tracking ID and automatically shift status to dispatched
          db.run("UPDATE orders SET tracking_id = ?, status = 'dispatched' WHERE id = ?", [tracking_id, orderId]);
          
          return res.json({ success: true, tracking_id, new_status: 'dispatched' });
        } catch (error) {
          return res.status(500).json({ error: 'Courier API failed' });
        }
      });
    } else {
      res.json({ success: true, status });
    }
  });
});

app.listen(3000, () => console.log('CRM Server running on http://localhost:3000'));