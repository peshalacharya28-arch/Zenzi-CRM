// server.js
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);

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

const NCM_TOKEN = process.env.NCM_TOKEN || '6f33ba16bc5faf0902cc53ed920e78b75906b555';
const NCM_FROM_BRANCH = process.env.NCM_FROM_BRANCH || 'KALANKI';
const SUPABASE_URL = process.env.SUPABASE_URL || "https://pnecdxsqaevyvsnibdcu.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuZWNkeHNxYWV2eXZzbmliZGN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwNTM5ODYsImV4cCI6MjEwNDYyOTk4Nn0.Tv4JKePkfyAFUYsDnPSRNnRIt_mcs_lmNFh67VHaEBI";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:ZenziShop2026@db.pnecdxsqaevyvsnibdcu.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false } 
});

function sanitizePhone(phone) {
  return phone ? String(phone).replace(/\D/g, '').trim() : '';
}

function sanitizeText(text) {
  if (text === null || text === undefined) return null;
  const str = String(text).trim();
  return str.length > 0 ? str : null;
}

// Database Migration Strategy (Non-destructive & Complete)
pool.query(`
  CREATE TABLE IF NOT EXISTS inventory (
    id SERIAL PRIMARY KEY,
    product_name TEXT UNIQUE NOT NULL,
    stock_quantity INT DEFAULT 0,
    sku TEXT,
    hs_code TEXT,
    default_price NUMERIC DEFAULT 0
  );

  ALTER TABLE inventory ADD COLUMN IF NOT EXISTS hs_code TEXT;
  ALTER TABLE inventory ADD COLUMN IF NOT EXISTS default_price NUMERIC DEFAULT 0;

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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    customer_pan TEXT,
    ncm_order_id TEXT,
    bill_no SERIAL
  );

  ALTER TABLE orders ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS comments JSONB DEFAULT '[]'::jsonb;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP DEFAULT NULL;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_pan TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS ncm_order_id TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_no SERIAL;

  DO $$ BEGIN
    ALTER TABLE orders ALTER COLUMN cod_amount TYPE NUMERIC USING (NULLIF(cod_amount::text, '')::NUMERIC);
  EXCEPTION WHEN OTHERS THEN END $$;
`).catch(err => console.error('Database migration error:', err));

const verifyAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    return res.status(403).json({ error: 'Forbidden: Invalid session' });
  }

  req.user = user;
  next();
};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(__dirname, 'public', 'analytics.html')));

async function syncOrdersWithNCM() {
  try {
    const activeOrdersRes = await pool.query(
      "SELECT id, tracking_id, status, processing_started_at, comments FROM orders WHERE tracking_id IS NOT NULL AND status IN ('packed', 'processing')"
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

        let existingComments = Array.isArray(order.comments) ? order.comments : [];
        try {
          const commentRes = await axios.get(`https://portal.nepalcanmove.com/api/v1/order/comment?id=${order.tracking_id}`, {
            headers: { 'Authorization': `Token ${NCM_TOKEN}` }, timeout: 6000
          });
          if (Array.isArray(commentRes.data)) {
            commentRes.data.forEach(item => {
              const textStr = String(item.comments || '').trim();
              if (textStr && !existingComments.some(ec => ec.text === textStr)) {
                existingComments.push({
                  id: item.added_time || Date.now(),
                  text: textStr,
                  author: item.addedBy || 'NCM Staff',
                  timestamp: item.added_time || new Date().toISOString()
                });
              }
            });
          }
        } catch (err) {}

        await pool.query(
          "UPDATE orders SET status = $1, status_updated_at = CURRENT_TIMESTAMP, processing_started_at = $2, comments = $3 WHERE id = $4",
          [newStatus, processingTimestamp, JSON.stringify(existingComments), order.id]
        );
      } catch (err) {}
    }
  } catch (err) {}
}

setTimeout(syncOrdersWithNCM, 3000);
setInterval(syncOrdersWithNCM, 10 * 60 * 1000);

// --- INVENTORY ---
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
  const hs_code = sanitizeText(req.body.hs_code) || '';
  const stock_quantity = parseInt(req.body.stock_quantity) || 0;
  const default_price = parseFloat(req.body.default_price) || 0;

  if (!product_name) return res.status(400).json({ error: 'Product name is required' });

  try {
    const result = await pool.query(
      `INSERT INTO inventory (product_name, stock_quantity, sku, hs_code, default_price) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (product_name) DO UPDATE SET stock_quantity = EXCLUDED.stock_quantity, sku = EXCLUDED.sku, hs_code = EXCLUDED.hs_code, default_price = EXCLUDED.default_price RETURNING *`,
      [product_name, stock_quantity, sku, hs_code, default_price]
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

// --- ORDERS ---
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
    const result = await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 500');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve orders' });
  }
});

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
      } catch (err) {}
    }

    const merged = [...(order.comments || []), ...liveComments];
    order.comments = Array.from(new Map(merged.map(c => [c.text, c])).values())
                          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order details' });
  }
});

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
      
      const stockCheck = await client.query('SELECT id, stock_quantity, hs_code, default_price FROM inventory WHERE product_name = $1 FOR UPDATE', [pName]);
      if (stockCheck.rows.length === 0) throw new Error(`Product "${pName}" does not exist.`);
      
      const currentStock = stockCheck.rows[0].stock_quantity;
      if (currentStock < reqQty) throw new Error(`Insufficient stock for "${pName}". Available: ${currentStock}`);

      await client.query('UPDATE inventory SET stock_quantity = stock_quantity - $1 WHERE id = $2', [reqQty, stockCheck.rows[0].id]);
      
      const unit_price = item.unit_price !== undefined && item.unit_price !== '' ? parseFloat(item.unit_price) : (parseFloat(stockCheck.rows[0].default_price) || 0);
      const discount_percent = item.discount_percent !== undefined && item.discount_percent !== '' ? parseFloat(item.discount_percent) : 0;
      const hs_code = sanitizeText(item.hs_code) || stockCheck.rows[0].hs_code || '';

      savedItems.push({
        inventory_id: stockCheck.rows[0].id,
        product_name: pName,
        hs_code: hs_code,
        qty: reqQty,
        unit_price: unit_price,
        discount_percent: discount_percent
      });
      packageSummaryParts.push(`${reqQty}x ${pName}`);
    }

    const finalPackageName = packageSummaryParts.join(', ') || 'Zenzi Item';
    const result = await client.query(
      `INSERT INTO orders (customer_name, phone_number, phone2, shipping_address, package_name, items, cod_amount, to_branch, instruction, delivery_type, customer_pan) 
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11) RETURNING id`,
      [
        customer_name, phone_number, sanitizePhone(req.body.phone2), shipping_address, 
        finalPackageName, JSON.stringify(savedItems), cod_amount, sanitizeText(req.body.to_branch) || 'KALANKI', 
        sanitizeText(req.body.instruction), sanitizeText(req.body.delivery_type) || 'Door2Door',
        sanitizeText(req.body.customer_pan)
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

app.put('/api/orders/:id', verifyAuth, async (req, res) => {
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

    const currentOrderRes = await client.query('SELECT status, items FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (currentOrderRes.rows.length === 0) throw new Error('Order not found');

    const currentOrder = currentOrderRes.rows[0];
    if (currentOrder.status !== 'received') {
      throw new Error('Order cannot be edited once it has passed "Received" status');
    }

    const oldItems = Array.isArray(currentOrder.items) ? currentOrder.items : [];
    for (const oldItem of oldItems) {
      if (oldItem.inventory_id) {
        await client.query('UPDATE inventory SET stock_quantity = stock_quantity + $1 WHERE id = $2', [oldItem.qty, oldItem.inventory_id]);
      }
    }

    let savedItems = [];
    let packageSummaryParts = [];

    for (const item of items) {
      const pName = sanitizeText(item.product_name);
      const reqQty = parseInt(item.qty) || 1;
      
      const stockCheck = await client.query('SELECT id, stock_quantity, hs_code, default_price FROM inventory WHERE product_name = $1 FOR UPDATE', [pName]);
      if (stockCheck.rows.length === 0) throw new Error(`Product "${pName}" does not exist.`);
      
      const currentStock = stockCheck.rows[0].stock_quantity;
      if (currentStock < reqQty) throw new Error(`Insufficient stock for "${pName}". Available: ${currentStock}`);

      await client.query('UPDATE inventory SET stock_quantity = stock_quantity - $1 WHERE id = $2', [reqQty, stockCheck.rows[0].id]);
      
      // Preserve historical price/discount if provided explicitly; fallback to existing snapshot, then default_price
      const existingSnapshot = oldItems.find(oi => oi.product_name === pName);
      
      const unit_price = item.unit_price !== undefined && item.unit_price !== '' ? parseFloat(item.unit_price) : (existingSnapshot ? parseFloat(existingSnapshot.unit_price) : (parseFloat(stockCheck.rows[0].default_price) || 0));
      const discount_percent = item.discount_percent !== undefined && item.discount_percent !== '' ? parseFloat(item.discount_percent) : (existingSnapshot ? parseFloat(existingSnapshot.discount_percent) : 0);
      const hs_code = sanitizeText(item.hs_code) || (existingSnapshot ? existingSnapshot.hs_code : stockCheck.rows[0].hs_code) || '';

      savedItems.push({
        inventory_id: stockCheck.rows[0].id,
        product_name: pName,
        hs_code: hs_code,
        qty: reqQty,
        unit_price: unit_price,
        discount_percent: discount_percent
      });
      packageSummaryParts.push(`${reqQty}x ${pName}`);
    }

    const finalPackageName = packageSummaryParts.join(', ') || 'Zenzi Item';

    await client.query(
      `UPDATE orders 
       SET customer_name = $1, phone_number = $2, phone2 = $3, shipping_address = $4, 
           package_name = $5, items = $6::jsonb, cod_amount = $7, to_branch = $8, instruction = $9, delivery_type = $10, customer_pan = $11
       WHERE id = $12`,
      [
        customer_name, phone_number, sanitizePhone(req.body.phone2), shipping_address, 
        finalPackageName, JSON.stringify(savedItems), cod_amount, sanitizeText(req.body.to_branch) || 'KALANKI', 
        sanitizeText(req.body.instruction), sanitizeText(req.body.delivery_type) || 'Door2Door',
        sanitizeText(req.body.customer_pan), req.params.id
      ]
    );

    await client.query('COMMIT');
    res.json({ success: true, package_name: finalPackageName });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message || 'Failed to edit order' });
  } finally {
    client.release();
  }
});

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
          "UPDATE orders SET tracking_id = $1, ncm_order_id = $1, vref_id = $2, status = 'packed', status_updated_at = CURRENT_TIMESTAMP WHERE id = $3",
          [String(ncmOrderId), vref, orderId]
        );
        return res.json({ success: true, tracking_id: ncmOrderId, ncm_order_id: ncmOrderId, new_status: 'packed' });
      } else {
        throw new Error('NCM API Rejected Creation');
      }
    }

    await pool.query(`UPDATE orders SET status = $1, status_updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [status, orderId]);
    res.json({ success: true, status });
  } catch (error) {
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
      } catch (err) {}
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

app.delete('/api/orders/:id', verifyAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query('SELECT status, items FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    
    if (orderRes.rows.length > 0) {
      const order = orderRes.rows[0];
      if (order.status !== 'delivered') { 
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

// --- ANALYTICS ---
app.get('/api/analytics', verifyAuth, async (req, res) => {
  try {
    const totalOrdersRes = await pool.query('SELECT COUNT(*) FROM orders');
    const todayOrdersRes = await pool.query('SELECT COUNT(*) FROM orders WHERE created_at >= CURRENT_DATE');
    const totalRevenueRes = await pool.query("SELECT SUM(cod_amount) FROM orders WHERE status = 'delivered'");
    const deliveredCountRes = await pool.query("SELECT COUNT(*) FROM orders WHERE status = 'delivered'");
    const branchBreakdownRes = await pool.query('SELECT to_branch, COUNT(*) as count FROM orders GROUP BY to_branch ORDER BY count DESC LIMIT 5');

    const totalOrders = parseInt(totalOrdersRes.rows[0].count) || 0;
    const todayOrders = parseInt(todayOrdersRes.rows[0].count) || 0;
    const totalRevenue = parseFloat(totalRevenueRes.rows[0].sum) || 0;
    const deliveredCount = parseInt(deliveredCountRes.rows[0].count) || 0;
    const conversionRate = totalOrders > 0 ? ((deliveredCount / totalOrders) * 100).toFixed(1) : 0;

    res.json({
      totalOrders, todayOrders, totalRevenue, deliveredCount,
      conversionRate: `${conversionRate}%`, topBranches: branchBreakdownRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate analytics metrics' });
  }
});

app.get('/api/analytics/overview', verifyAuth, async (req, res) => {
  const { startDate, endDate } = req.query;

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const defaultStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 00:00:00`;
  const defaultEnd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 23:59:59`;

  const parseDateParam = (val, isEnd) => {
    if (!val) return isEnd ? defaultEnd : defaultStart;
    try {
      const decoded = decodeURIComponent(val);
      const d = new Date(decoded);
      if (!isNaN(d.getTime())) {
        const year = d.getFullYear();
        const month = pad(d.getMonth() + 1);
        const day = pad(d.getDate());
        const hh = isEnd ? '23' : '00';
        const mm = isEnd ? '59' : '00';
        const ss = isEnd ? '59' : '00';
        return `${year}-${month}-${day} ${hh}:${mm}:${ss}`;
      }
    } catch (e) {}
    return isEnd ? defaultEnd : defaultStart;
  };

  const startStr = parseDateParam(startDate, false);
  const endStr = parseDateParam(endDate, true);

  try {
    const volumeRes = await pool.query(
      `SELECT 
         COUNT(*) as total_orders,
         COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) as delivered_orders,
         COALESCE(SUM(CASE WHEN status IN ('problem', 'hold') THEN 1 ELSE 0 END), 0) as problem_stalled_orders,
         COALESCE(SUM(CASE WHEN status IN ('problem', 'returned', 'cancelled') THEN 1 ELSE 0 END), 0) as rto_orders,
         COALESCE(SUM(CASE WHEN status = 'delivered' THEN COALESCE(cod_amount, 0) ELSE 0 END), 0) as total_delivered_revenue
       FROM orders WHERE created_at >= $1::timestamp AND created_at <= $2::timestamp`,
      [startStr, endStr]
    );

    const stats = volumeRes.rows[0] || {};
    const totalOrders = parseInt(stats.total_orders) || 0;
    const deliveredOrders = parseInt(stats.delivered_orders) || 0;
    const problemStalledOrders = parseInt(stats.problem_stalled_orders) || 0;
    const rtoOrders = parseInt(stats.rto_orders) || 0;
    const totalDeliveredRevenue = parseFloat(stats.total_delivered_revenue) || 0;

    const deliverySuccessRate = totalOrders > 0 ? ((deliveredOrders / totalOrders) * 100).toFixed(1) : "0.0";
    const rtoRate = totalOrders > 0 ? ((rtoOrders / totalOrders) * 100).toFixed(1) : "0.0";
    const bottleneckRate = totalOrders > 0 ? ((problemStalledOrders / totalOrders) * 100).toFixed(1) : "0.0";

    let avgTransitHours = "0.0";
    try {
      const leadTimeRes = await pool.query(
        `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(status_updated_at, CURRENT_TIMESTAMP) - COALESCE(processing_started_at, created_at))) / 3600), 0) as avg_transit_hours
         FROM orders WHERE status = 'delivered' AND created_at >= $1::timestamp AND created_at <= $2::timestamp`,
        [startStr, endStr]
      );
      avgTransitHours = parseFloat(leadTimeRes.rows[0]?.avg_transit_hours || 0).toFixed(1);
    } catch (e) {
      avgTransitHours = "0.0";
    }

    let branchRows = [];
    try {
      const branchRes = await pool.query(
        `SELECT to_branch, COUNT(*) as order_count FROM orders 
         WHERE created_at >= $1::timestamp AND created_at <= $2::timestamp 
         GROUP BY to_branch ORDER BY order_count DESC LIMIT 10`,
        [startStr, endStr]
      );
      branchRows = branchRes.rows || [];
    } catch (e) {
      branchRows = [];
    }

    let periodOrdersRows = [];
    try {
      const periodOrdersRes = await pool.query(
        `SELECT package_name FROM orders WHERE created_at >= $1::timestamp AND created_at <= $2::timestamp AND package_name IS NOT NULL`,
        [startStr, endStr]
      );
      periodOrdersRows = periodOrdersRes.rows || [];
    } catch (e) {
      periodOrdersRows = [];
    }

    const productSalesMap = {};
    let totalUnitsSoldInPeriod = 0;

    periodOrdersRows.forEach(row => {
      const items = String(row.package_name).split(',');
      items.forEach(itemStr => {
        const match = itemStr.trim().match(/^(\d+)x\s+(.+)$/);
        if (match) {
          const qty = parseInt(match[1]) || 1;
          const pName = match[2].trim();
          productSalesMap[pName] = (productSalesMap[pName] || 0) + qty;
          totalUnitsSoldInPeriod += qty;
        }
      });
    });

    let inventoryRows = [];
    try {
      const inventoryRes = await pool.query(`SELECT product_name, stock_quantity, sku FROM inventory ORDER BY product_name ASC`);
      inventoryRows = inventoryRes.rows || [];
    } catch (e) {
      inventoryRows = [];
    }

    const velocityList = inventoryRows.map(inv => {
      const unitsSold = productSalesMap[inv.product_name] || 0;
      const share = totalUnitsSoldInPeriod > 0 ? ((unitsSold / totalUnitsSoldInPeriod) * 100).toFixed(1) : "0.0";
      return { product_name: inv.product_name, sku: inv.sku || '-', stock_quantity: inv.stock_quantity || 0, units_sold: unitsSold, volume_share: `${share}%` };
    });

    const topMovingProducts = [...velocityList].sort((a, b) => b.units_sold - a.units_sold).slice(0, 10);
    const slowMovingProducts = [...velocityList].sort((a, b) => a.units_sold - b.units_sold).slice(0, 10);

    res.json({
      timeframe: { startDate: startStr, endDate: endStr },
      summary: { totalOrders, totalDeliveredRevenue, deliverySuccessRate: `${deliverySuccessRate}%`, rtoRate: `${rtoRate}%`, bottleneckRate: `${bottleneckRate}%`, avgTransitHours: `${avgTransitHours} hrs` },
      topBranches: branchRows, topMovingProducts, slowMovingProducts
    });
  } catch (err) {
    console.error("ANALYTICS ERROR:", err.message);
    res.status(500).json({ error: 'Failed to calculate dynamic analytics dataset', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zenzi CRM live on port ${PORT}`));