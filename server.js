const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

// 1. Enforce Critical Secrets
if (!process.env.NCM_TOKEN || !process.env.DATABASE_URL || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("FATAL: Missing required environment variables. Halting boot.");
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Required for rate limiting behind reverse proxies

app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' })); 
app.use(helmet({ contentSecurityPolicy: false }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests. Please wait a few minutes.' }
});
app.use('/api/', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));

const NCM_TOKEN = process.env.NCM_TOKEN;
const NCM_FROM_BRANCH = process.env.NCM_FROM_BRANCH || 'KALANKI';
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Set to true if managing custom CA certs
});

function sanitizePhone(phone) {
  return phone ? String(phone).replace(/\D/g, '').trim() : '';
}

function sanitizeText(text) {
  if (text === null || text === undefined) return null;
  const str = String(text).trim();
  return str.length > 0 ? str : null;
}

// 2. Schema Hardening & Normalization
pool.query(`
  CREATE TABLE IF NOT EXISTS inventory (
    id SERIAL PRIMARY KEY,
    product_name TEXT UNIQUE NOT NULL,
    stock_quantity INT DEFAULT 0,
    sku TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    customer_name TEXT,
    phone_number TEXT,
    phone2 TEXT,
    shipping_address TEXT,
    package_name TEXT,
    items JSONB DEFAULT '[]'::jsonb,
    cod_amount NUMERIC DEFAULT 0,
    to_branch TEXT,
    instruction TEXT,
    delivery_type TEXT DEFAULT 'Door2Door',
    status TEXT DEFAULT 'received',
    tracking_id TEXT UNIQUE,
    vref_id TEXT,
    comments JSONB DEFAULT '[]'::jsonb,
    status_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processing_started_at TIMESTAMP DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  ALTER TABLE orders ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb;
  DO $$ BEGIN
    ALTER TABLE orders ALTER COLUMN cod_amount TYPE NUMERIC USING (NULLIF(cod_amount::text, '')::NUMERIC);
  EXCEPTION WHEN OTHERS THEN END $$;
`).catch(err => console.error('Database migration error:', err));

// 3. Authorization (JWT)
const verifyAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    return res.status(403).json({ error: 'Forbidden: Invalid or expired session token' });
  }

  req.user = user;
  next();
};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(__dirname, 'public', 'analytics.html')));

// 4. Sequential & Logged NCM Sync Engine
async function syncOrdersWithNCM() {
  try {
    const activeOrdersRes = await pool.query(
      "SELECT id, tracking_id, status, processing_started_at FROM orders WHERE tracking_id IS NOT NULL AND status IN ('packed', 'processing')"
    );
    const activeOrders = activeOrdersRes.rows;
    if (activeOrders.length === 0) return;

    const now = new Date();

    for (const order of activeOrders) {
      try {
        const statusRes = await axios.get(`https://portal.nepalcanmove.com/api/v1/order/status?id=${order.tracking_id}`, {
          headers: { 'Authorization': `Token ${NCM_TOKEN}` },
          timeout: 8000
        });

        const data = statusRes.data;
        let latestNcmStatusStr = '';
        
        if (Array.isArray(data) && data.length > 0 && data[0].status) {
          latestNcmStatusStr = String(data[0].status).toUpperCase();
        } else if (data && typeof data === 'object' && data.status) {
          latestNcmStatusStr = String(data.status).toUpperCase();
        } else {
          console.warn(`[Sync Warn] Unrecognized status payload for tracking ${order.tracking_id}:`, JSON.stringify(data));
          continue;
        }

        let newStatus = order.status;
        let processingTimestamp = order.processing_started_at;

        if (latestNcmStatusStr.includes('DELIVERED')) {
          newStatus = 'delivered';
        } else if (latestNcmStatusStr.includes('DISPATCH') || latestNcmStatusStr.includes('TRANSIT') || latestNcmStatusStr.includes('DELIVERY')) {
          newStatus = 'processing';
          if (!processingTimestamp) processingTimestamp = new Date();
        } else if (latestNcmStatusStr.includes('CANCEL') || latestNcmStatusStr.includes('RETURN') || latestNcmStatusStr.includes('REJECTED')) {
          newStatus = 'problem';
        }

        if (newStatus === 'processing' && processingTimestamp) {
          const hoursInProcessing = (now - new Date(processingTimestamp)) / (1000 * 60 * 60);
          if (hoursInProcessing >= 72) {
            newStatus = 'problem';
            const autoComment = { id: Date.now(), text: "⚠️ System Escalate: >72h in transit.", author: "System", timestamp: now.toISOString() };
            await pool.query(`UPDATE orders SET comments = COALESCE(comments, '[]'::jsonb) || $1::jsonb WHERE id = $2`, [JSON.stringify([autoComment]), order.id]);
          }
        }

        if (newStatus !== order.status) {
          await pool.query(
            "UPDATE orders SET status = $1, status_updated_at = CURRENT_TIMESTAMP, processing_started_at = $2 WHERE id = $3",
            [newStatus, processingTimestamp, order.id]
          );
        }
      } catch (err) {
        console.error(`[Sync Error] Tracking ID ${order.tracking_id} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('NCM Sync Engine Fatal Error:', err.message);
  }
}

setInterval(syncOrdersWithNCM, 10 * 60 * 1000);

// --- INVENTORY ENDPOINTS ---
app.get('/api/inventory', verifyAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inventory ORDER BY product_name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

app.post('/api/inventory', verifyAuth, async (req, res) => {
  const product_name = sanitizeText(req.body.product_name);
  const sku = sanitizeText(req.body.sku) || '';
  const stock_quantity = parseInt(req.body.stock_quantity) || 0;

  if (!product_name) return res.status(400).json({ error: 'Product name is required' });

  try {
    const result = await pool.query(
      `INSERT INTO inventory (product_name, stock_quantity, sku) VALUES ($1, $2, $3)
       ON CONFLICT (product_name) DO UPDATE SET stock_quantity = EXCLUDED.stock_quantity, sku = EXCLUDED.sku RETURNING *`,
      [product_name, stock_quantity, sku]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save inventory item' });
  }
});

app.patch('/api/inventory/:id/stock', verifyAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE inventory SET stock_quantity = GREATEST(0, stock_quantity + $1) WHERE id = $2 RETURNING *',
      [parseInt(req.body.adjustment) || 0, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to adjust stock' });
  }
});

app.delete('/api/inventory/:id', verifyAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM inventory WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete inventory item' });
  }
});

// --- ORDERS ENDPOINTS ---
app.get('/api/branches', verifyAuth, async (req, res) => {
  try {
    const response = await axios.get('https://portal.nepalcanmove.com/api/v2/branches', {
      headers: { 'Authorization': `Token ${NCM_TOKEN}` }, timeout: 10000
    });
    const branches = response.data.map(b => (typeof b === 'object' && b.name ? b.name : b));
    res.json(branches);
  } catch (err) {
    res.json(['KALANKI', 'POKHARA', 'BUTWAL', 'BIRATNAGAR', 'CHITWAN', 'DHARAN', 'JHAPA']);
  }
});

app.get('/api/orders', verifyAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 500'); // Pagination constraint
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve orders' });
  }
});

// 5. Remove GET Side-Effects (Deduplicate in Memory)
app.get('/api/orders/:id', verifyAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    
    const order = result.rows[0];
    let liveComments = [];

    if (order.tracking_id) {
      try {
        const commentRes = await axios.get(`https://portal.nepalcanmove.com/api/v1/order/comment?id=${order.tracking_id}`, {
          headers: { 'Authorization': `Token ${NCM_TOKEN}` }, timeout: 6000
        });
        if (Array.isArray(commentRes.data)) {
          liveComments = commentRes.data
            .filter(c => String(c.comments || '').trim())
            .map(c => ({
              id: c.id || c.added_time || Date.now(),
              text: String(c.comments).trim(),
              author: c.addedBy || 'NCM Staff',
              timestamp: c.added_time || new Date().toISOString()
            }));
        }
      } catch (err) {
        console.warn(`[API Warn] Failed fetching live comments for ${order.tracking_id}`);
      }
    }

    // Merge without writing back to DB
    const merged = [...(order.comments || []), ...liveComments];
    order.comments = Array.from(new Map(merged.map(c => [c.text, c])).values())
                          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order details' });
  }
});

// 6. Transactional Lock (FOR UPDATE)
app.post('/api/orders', verifyAuth, async (req, res) => {
  const customer_name = sanitizeText(req.body.customer_name);
  const phone_number = sanitizePhone(req.body.phone_number);
  const shipping_address = sanitizeText(req.body.shipping_address);
  const cod_amount = parseFloat(req.body.cod_amount) || 0;
  const items = req.body.items;

  if (!customer_name || !phone_number || !shipping_address || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Missing required fields or items array' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let savedItems = [];
    let packageSummaryParts = [];

    for (const item of items) {
      const pName = sanitizeText(item.product_name);
      const reqQty = parseInt(item.qty) || 1;
      
      const stockCheck = await client.query('SELECT id, stock_quantity FROM inventory WHERE product_name = $1 FOR UPDATE', [pName]);
      if (stockCheck.rows.length === 0) throw new Error(`Product "${pName}" does not exist.`);
      
      const currentStock = stockCheck.rows[0].stock_quantity;
      if (currentStock < reqQty) throw new Error(`Insufficient stock for "${pName}". Available: ${currentStock}`);

      await client.query('UPDATE inventory SET stock_quantity = stock_quantity - $1 WHERE id = $2', [reqQty, stockCheck.rows[0].id]);
      savedItems.push({ inventory_id: stockCheck.rows[0].id, product_name: pName, qty: reqQty });
      packageSummaryParts.push(`${reqQty}x ${pName}`);
    }

    const finalPackageName = packageSummaryParts.join(', ') || 'Zenzi Item';
    const result = await client.query(
      `INSERT INTO orders (customer_name, phone_number, phone2, shipping_address, package_name, items, cod_amount, to_branch, instruction, delivery_type) 
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10) RETURNING id`,
      [
        customer_name, phone_number, sanitizePhone(req.body.phone2), shipping_address, 
        finalPackageName, JSON.stringify(savedItems), cod_amount, sanitizeText(req.body.to_branch) || 'KALANKI', 
        sanitizeText(req.body.instruction), sanitizeText(req.body.delivery_type) || 'Door2Door'
      ]
    );

    await client.query('COMMIT');
    res.json({ id: result.rows[0].id, package_name: finalPackageName });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message || 'Order creation failed' });
  } finally {
    client.release();
  }
});

// 7. State Machine Constraints
app.patch('/api/orders/:id/status', verifyAuth, async (req, res) => {
  const status = sanitizeText(req.body.status);
  const orderId = req.params.id;

  try {
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = orderResult.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if ((status === 'processing' || status === 'delivered') && !order.tracking_id) {
      return res.status(400).json({ error: 'Cannot transition to transit states without an NCM tracking ID.' });
    }

    if (status === 'packed' && !order.tracking_id) {
      const vref = `Z${Date.now().toString().slice(-6)}`;
      const ncmResponse = await axios.post('https://portal.nepalcanmove.com/api/v1/order/create', {
        name: sanitizeText(order.customer_name), phone: sanitizePhone(order.phone_number), phone2: sanitizePhone(order.phone2),
        cod_charge: String(order.cod_amount || 0), address: sanitizeText(order.shipping_address), fbranch: NCM_FROM_BRANCH,
        branch: sanitizeText(order.to_branch) || 'KALANKI', package: sanitizeText(order.package_name) || 'Zenzi Product',
        vref_id: vref, delivery_type: sanitizeText(order.delivery_type) || 'Door2Door', weight: '1'
      }, { headers: { 'Authorization': `Token ${NCM_TOKEN}` }});

      if (ncmResponse.status === 200 || ncmResponse.status === 201) {
        const ncmOrderId = ncmResponse.data.orderid || ncmResponse.data.order_id;
        await pool.query(
          "UPDATE orders SET tracking_id = $1, vref_id = $2, status = 'packed', status_updated_at = CURRENT_TIMESTAMP WHERE id = $3",
          [String(ncmOrderId), vref, orderId]
        );
        return res.json({ success: true, tracking_id: ncmOrderId, new_status: 'packed' });
      } else {
        throw new Error('NCM API Rejected Creation');
      }
    }

    await pool.query(`UPDATE orders SET status = $1, status_updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [status, orderId]);
    res.json({ success: true, status });
  } catch (error) {
    console.error("Status Update Failed:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Logistics processing failed', details: error.message });
  }
});

app.post('/api/orders/:id/comments', verifyAuth, async (req, res) => {
  const text = sanitizeText(req.body.text);
  if (!text) return res.status(400).json({ error: 'Comment text required' });

  try {
    const orderRes = await pool.query('SELECT tracking_id FROM orders WHERE id = $1', [req.params.id]);
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    
    let ncmPushed = false;
    const tracking_id = orderRes.rows[0].tracking_id;

    if (tracking_id) {
      try {
        const ncmRes = await axios.post('https://portal.nepalcanmove.com/api/v1/comment', 
          { orderid: String(tracking_id), comments: text }, 
          { headers: { 'Authorization': `Token ${NCM_TOKEN}` }, timeout: 8000 }
        );
        if (ncmRes.status === 200 || ncmRes.status === 201) ncmPushed = true;
      } catch (err) { console.error('NCM Post Comment Error'); }
    }

    const commentObj = { id: Date.now(), text, author: req.user.email || 'Admin', timestamp: new Date().toISOString() };
    const updatedRes = await pool.query(
      `UPDATE orders SET comments = COALESCE(comments, '[]'::jsonb) || $1::jsonb WHERE id = $2 RETURNING *`,
      [JSON.stringify([commentObj]), req.params.id]
    );

    res.json({ ...updatedRes.rows[0], ncm_pushed: ncmPushed });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

app.post('/api/orders/sync', verifyAuth, async (req, res) => {
  await syncOrdersWithNCM();
  res.json({ success: true });
});

// 8. Safe Deletion (No Delivered Stock Inflation)
app.delete('/api/orders/:id', verifyAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query('SELECT status, items FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    
    if (orderRes.rows.length > 0) {
      const order = orderRes.rows[0];
      if (order.status !== 'delivered') { // Do not restore stock for successfully delivered items
        const items = Array.isArray(order.items) ? order.items : [];
        for (const item of items) {
          if (item.inventory_id) {
            await client.query('UPDATE inventory SET stock_quantity = stock_quantity + $1 WHERE id = $2', [item.qty, item.inventory_id]);
          }
        }
      }
    }
    await client.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to delete order' });
  } finally {
    client.release();
  }
});

// Basic Analytics Endpoint
app.get('/api/analytics', verifyAuth, async (req, res) => {
  try {
    const totalOrdersRes = await pool.query('SELECT COUNT(*) FROM orders');
    const deliveredCountRes = await pool.query("SELECT COUNT(*) FROM orders WHERE status = 'delivered'");
    const totalRevenueRes = await pool.query("SELECT SUM(cod_amount) FROM orders WHERE status = 'delivered'");
    
    res.json({
      totalOrders: parseInt(totalOrdersRes.rows[0].count),
      totalRevenue: parseFloat(totalRevenueRes.rows[0].sum) || 0,
      deliveredCount: parseInt(deliveredCountRes.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Analytics failure' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zenzi CRM live on port ${PORT}`));