'use strict';

const express = require('express');
const { Pool, types } = require('pg');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

/* -------------------------------------------------------------------------- */
/*  Configuration (no hardcoded secrets: the server refuses to start without)  */
/* -------------------------------------------------------------------------- */
const REQUIRED_ENV = ['NCM_TOKEN', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
}

const NCM_TOKEN = process.env.NCM_TOKEN;
const NCM_FROM_BRANCH = process.env.NCM_FROM_BRANCH || 'KALANKI';
const NCM_BASE = 'https://portal.nepalcanmove.com/api';
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'Asia/Kathmandu';
const PORT = process.env.PORT || 3000;

// Optional but strongly recommended: comma separated list of staff emails allowed to use the API.
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
if (ALLOWED_EMAILS.length === 0) {
  console.warn('[security] ALLOWED_EMAILS is not set: any valid Supabase user can access the API. Disable public sign-ups or set ALLOWED_EMAILS.');
}

const ALLOWED_STATUSES = ['received', 'packed', 'processing', 'hold', 'problem', 'delivered'];
const ncmHeaders = { Authorization: `Token ${NCM_TOKEN}` };

// "timestamp without time zone" columns hold UTC values; parse them as UTC regardless of server TZ.
types.setTypeParser(1114, (s) => new Date(`${s.replace(' ', 'T')}Z`));

// SQL fragment: created_at converted to the business timezone (wall-clock time).
const LOCAL_CREATED = `(created_at AT TIME ZONE 'UTC' AT TIME ZONE '${BUSINESS_TZ}')`;

/* -------------------------------------------------------------------------- */
/*  App + middleware                                                          */
/* -------------------------------------------------------------------------- */
const app = express();
app.set('trust proxy', 1);

app.use(express.json({ limit: '200kb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || false }));
app.use(helmet({ contentSecurityPolicy: false })); // pages use inline scripts/styles

app.use(
  '/api/',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a few minutes.' },
  })
);
app.use(express.static(path.join(__dirname, 'public')));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
pool.on('error', (err) => console.error('Unexpected PG pool error:', err.message));

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */
const sanitizePhone = (phone) => (phone ? String(phone).replace(/\D/g, '').trim() : '');

function sanitizeText(text) {
  if (text === null || text === undefined) return null;
  const str = String(text).trim();
  return str.length > 0 ? str : null;
}

// Parses an optional non-negative number; returns fallback when empty.
function parseNonNegative(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${label}`);
  return n;
}

const ncmErrorMessage = (err) => {
  const data = err.response && err.response.data;
  if (data) return typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300);
  return err.message;
};

// Validate numeric :id params once for every route.
app.param('id', (req, res, next, val) => {
  if (!/^\d+$/.test(val)) return res.status(400).json({ error: 'Invalid id' });
  next();
});

/* -------------------------------------------------------------------------- */
/*  Database migrations (safe and non-destructive)                            */
/* -------------------------------------------------------------------------- */
async function runMigrations() {
  await pool.query(`
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

    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

    DO $$ BEGIN
      ALTER TABLE orders ALTER COLUMN cod_amount TYPE NUMERIC USING (NULLIF(cod_amount::text, '')::NUMERIC);
    EXCEPTION WHEN OTHERS THEN NULL; END $$;
  `);
}

/* -------------------------------------------------------------------------- */
/*  Auth                                                                      */
/* -------------------------------------------------------------------------- */
const verifyAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) return res.status(403).json({ error: 'Forbidden: Invalid session' });

    if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(String(user.email || '').toLowerCase())) {
      return res.status(403).json({ error: 'Forbidden: Account not authorised' });
    }

    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Authentication service unavailable' });
  }
};

/* -------------------------------------------------------------------------- */
/*  Pages                                                                     */
/* -------------------------------------------------------------------------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(__dirname, 'public', 'analytics.html')));

/* -------------------------------------------------------------------------- */
/*  NCM sync                                                                  */
/* -------------------------------------------------------------------------- */
let isSyncing = false;

async function syncOrdersWithNCM() {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const { rows: activeOrders } = await pool.query(
      "SELECT id, tracking_id, status, processing_started_at, comments FROM orders WHERE tracking_id IS NOT NULL AND status IN ('packed', 'processing')"
    );
    if (activeOrders.length === 0) return;

    const now = new Date();

    for (const order of activeOrders) {
      try {
        const statusRes = await axios.get(`${NCM_BASE}/v1/order/status?id=${encodeURIComponent(order.tracking_id)}`, {
          headers: ncmHeaders,
          timeout: 8000,
        });

        const data = statusRes.data;
        let latest = '';
        if (Array.isArray(data) && data.length > 0 && data[0].status) latest = String(data[0].status).toUpperCase();
        else if (data && typeof data === 'object' && data.status) latest = String(data.status).toUpperCase();
        else continue;

        let newStatus = order.status;
        if (latest.includes('DELIVERED')) newStatus = 'delivered';
        else if (latest.includes('DISPATCH') || latest.includes('TRANSIT') || latest.includes('DELIVERY')) newStatus = 'processing';
        else if (latest.includes('CANCEL') || latest.includes('RETURN') || latest.includes('REJECTED')) newStatus = 'problem';

        const existingComments = Array.isArray(order.comments) ? [...order.comments] : [];

        // Pull NCM comments
        try {
          const commentRes = await axios.get(`${NCM_BASE}/v1/order/comment?id=${encodeURIComponent(order.tracking_id)}`, {
            headers: ncmHeaders,
            timeout: 6000,
          });
          if (Array.isArray(commentRes.data)) {
            for (const item of commentRes.data) {
              const textStr = String(item.comments || '').trim();
              if (textStr && !existingComments.some((ec) => ec.text === textStr)) {
                existingComments.push({
                  id: item.added_time || Date.now(),
                  text: textStr,
                  author: item.addedBy || 'NCM Staff',
                  timestamp: item.added_time || now.toISOString(),
                });
              }
            }
          }
        } catch (err) {
          /* comments are best-effort */
        }

        // 72h escalation (only when the order was already in transit)
        if (newStatus === 'processing' && order.processing_started_at) {
          const hours = (now - new Date(order.processing_started_at)) / 36e5;
          if (hours >= 72) {
            newStatus = 'problem';
            existingComments.push({
              id: Date.now(),
              text: '⚠️ System Escalate: >72h in transit.',
              author: 'System',
              timestamp: now.toISOString(),
            });
          }
        }

        await pool.query(
          `UPDATE orders SET
             status = $1::text,
             status_updated_at = CASE WHEN status <> $1::text THEN CURRENT_TIMESTAMP ELSE status_updated_at END,
             processing_started_at = CASE WHEN $1::text = 'processing'
                                          THEN COALESCE(processing_started_at, CURRENT_TIMESTAMP)
                                          ELSE processing_started_at END,
             comments = $2::jsonb
           WHERE id = $3`,
          [newStatus, JSON.stringify(existingComments), order.id]
        );
      } catch (err) {
        console.error(`NCM sync failed for order ${order.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('NCM sync error:', err.message);
  } finally {
    isSyncing = false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Inventory routes                                                          */
/* -------------------------------------------------------------------------- */
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
  const stock_quantity = parseInt(req.body.stock_quantity, 10);
  const default_price = Number(req.body.default_price);

  if (!product_name) return res.status(400).json({ error: 'Product name is required' });
  if (!Number.isInteger(stock_quantity) || stock_quantity < 0) return res.status(400).json({ error: 'Invalid stock quantity' });
  if (!Number.isFinite(default_price) || default_price < 0) return res.status(400).json({ error: 'Invalid price' });

  try {
    const result = await pool.query(
      `INSERT INTO inventory (product_name, stock_quantity, sku, hs_code, default_price)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (product_name) DO UPDATE SET
         stock_quantity = EXCLUDED.stock_quantity, sku = EXCLUDED.sku,
         hs_code = EXCLUDED.hs_code, default_price = EXCLUDED.default_price
       RETURNING *`,
      [product_name, stock_quantity, sku, hs_code, default_price]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save inventory item' });
  }
});

app.patch('/api/inventory/:id/stock', verifyAuth, async (req, res) => {
  const adjustment = parseInt(req.body.adjustment, 10);
  if (!Number.isInteger(adjustment)) return res.status(400).json({ error: 'Invalid adjustment' });

  try {
    const result = await pool.query(
      'UPDATE inventory SET stock_quantity = GREATEST(0, stock_quantity + $1) WHERE id = $2 RETURNING *',
      [adjustment, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
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

/* -------------------------------------------------------------------------- */
/*  Order helpers                                                             */
/* -------------------------------------------------------------------------- */

// Validates items, locks inventory rows, deducts stock and returns the snapshot to store.
async function reserveItems(client, items, previousItems = []) {
  const savedItems = [];
  const summaryParts = [];

  for (const item of items) {
    const pName = sanitizeText(item.product_name);
    if (!pName) throw new Error('Product name is required for every item');

    const reqQty = Number(item.qty);
    if (!Number.isInteger(reqQty) || reqQty < 1) throw new Error(`Invalid quantity for "${pName}"`);

    const stockCheck = await client.query(
      'SELECT id, stock_quantity, hs_code, default_price FROM inventory WHERE product_name = $1 FOR UPDATE',
      [pName]
    );
    if (stockCheck.rows.length === 0) throw new Error(`Product "${pName}" does not exist.`);

    const inv = stockCheck.rows[0];
    if (inv.stock_quantity < reqQty) throw new Error(`Insufficient stock for "${pName}". Available: ${inv.stock_quantity}`);

    await client.query('UPDATE inventory SET stock_quantity = stock_quantity - $1 WHERE id = $2', [reqQty, inv.id]);

    const snapshot = previousItems.find((oi) => oi.product_name === pName);
    const unit_price = parseNonNegative(
      item.unit_price,
      snapshot ? Number(snapshot.unit_price) || 0 : Number(inv.default_price) || 0,
      `price for "${pName}"`
    );
    const discount_percent = parseNonNegative(item.discount_percent, snapshot ? Number(snapshot.discount_percent) || 0 : 0, `discount for "${pName}"`);
    if (discount_percent > 100) throw new Error(`Discount for "${pName}" cannot exceed 100%`);

    savedItems.push({
      inventory_id: inv.id,
      product_name: pName,
      hs_code: sanitizeText(item.hs_code) || (snapshot ? snapshot.hs_code : inv.hs_code) || '',
      qty: reqQty,
      unit_price,
      discount_percent,
    });
    summaryParts.push(`${reqQty}x ${pName}`);
  }

  return { savedItems, packageName: summaryParts.join(', ') || 'Zenzi Item' };
}

function readOrderBody(body) {
  const customer_name = sanitizeText(body.customer_name);
  const phone_number = sanitizePhone(body.phone_number);
  const shipping_address = sanitizeText(body.shipping_address);
  const items = body.items;

  if (!customer_name || !phone_number || !shipping_address || !Array.isArray(items) || items.length === 0) {
    throw new Error('Missing required fields or items');
  }

  return {
    customer_name,
    phone_number,
    shipping_address,
    items,
    phone2: sanitizePhone(body.phone2),
    cod_amount: parseNonNegative(body.cod_amount, 0, 'COD amount'),
    to_branch: sanitizeText(body.to_branch) || 'KALANKI',
    instruction: sanitizeText(body.instruction),
    delivery_type: sanitizeText(body.delivery_type) || 'Door2Door',
    customer_pan: sanitizeText(body.customer_pan),
  };
}

/* -------------------------------------------------------------------------- */
/*  Order routes                                                              */
/* -------------------------------------------------------------------------- */
app.get('/api/branches', verifyAuth, async (req, res) => {
  try {
    const response = await axios.get(`${NCM_BASE}/v2/branches`, { headers: ncmHeaders, timeout: 10000 });
    res.json(response.data.map((b) => (typeof b === 'object' && b.name ? b.name : b)));
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
        const commentRes = await axios.get(`${NCM_BASE}/v1/order/comment?id=${encodeURIComponent(order.tracking_id)}`, {
          headers: ncmHeaders,
          timeout: 6000,
        });
        if (Array.isArray(commentRes.data)) {
          liveComments = commentRes.data
            .filter((c) => String(c.comments || '').trim())
            .map((c) => ({
              id: c.id || c.added_time || Date.now(),
              text: String(c.comments).trim(),
              author: c.addedBy || 'NCM Staff',
              timestamp: c.added_time || new Date().toISOString(),
            }));
        }
      } catch (err) {
        /* best-effort */
      }
    }

    const merged = [...(order.comments || []), ...liveComments];
    order.comments = Array.from(new Map(merged.map((c) => [c.text, c])).values()).sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order details' });
  }
});

app.post('/api/orders', verifyAuth, async (req, res) => {
  let body;
  try {
    body = readOrderBody(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { savedItems, packageName } = await reserveItems(client, body.items);

    const result = await client.query(
      `INSERT INTO orders (customer_name, phone_number, phone2, shipping_address, package_name, items,
                           cod_amount, to_branch, instruction, delivery_type, customer_pan)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11) RETURNING id`,
      [
        body.customer_name, body.phone_number, body.phone2, body.shipping_address, packageName,
        JSON.stringify(savedItems), body.cod_amount, body.to_branch, body.instruction,
        body.delivery_type, body.customer_pan,
      ]
    );

    await client.query('COMMIT');
    res.json({ id: result.rows[0].id, package_name: packageName });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: err.message || 'Order creation failed' });
  } finally {
    client.release();
  }
});

app.put('/api/orders/:id', verifyAuth, async (req, res) => {
  let body;
  try {
    body = readOrderBody(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query('SELECT status, items FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (current.rows.length === 0) throw new Error('Order not found');
    if (current.rows[0].status !== 'received') throw new Error('Order cannot be edited once it has passed "Received" status');

    // Give the old stock back, then reserve the new items
    const oldItems = Array.isArray(current.rows[0].items) ? current.rows[0].items : [];
    for (const oldItem of oldItems) {
      if (oldItem.inventory_id) {
        await client.query('UPDATE inventory SET stock_quantity = stock_quantity + $1 WHERE id = $2', [oldItem.qty, oldItem.inventory_id]);
      }
    }

    const { savedItems, packageName } = await reserveItems(client, body.items, oldItems);

    await client.query(
      `UPDATE orders
         SET customer_name = $1, phone_number = $2, phone2 = $3, shipping_address = $4,
             package_name = $5, items = $6::jsonb, cod_amount = $7, to_branch = $8,
             instruction = $9, delivery_type = $10, customer_pan = $11
       WHERE id = $12`,
      [
        body.customer_name, body.phone_number, body.phone2, body.shipping_address, packageName,
        JSON.stringify(savedItems), body.cod_amount, body.to_branch, body.instruction,
        body.delivery_type, body.customer_pan, req.params.id,
      ]
    );

    await client.query('COMMIT');
    res.json({ success: true, package_name: packageName });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(400).json({ error: err.message || 'Failed to edit order' });
  } finally {
    client.release();
  }
});

// Prevents double-clicks from creating two NCM shipments for the same order.
const dispatching = new Set();

app.patch('/api/orders/:id/status', verifyAuth, async (req, res) => {
  const status = sanitizeText(req.body.status);
  const orderId = req.params.id;

  if (!ALLOWED_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = orderResult.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if ((status === 'processing' || status === 'delivered') && !order.tracking_id) {
      return res.status(400).json({ error: 'Cannot transition to transit states without an NCM tracking ID.' });
    }
    if (status === 'received' && order.tracking_id) {
      return res.status(400).json({ error: 'A dispatched order cannot be moved back to Received.' });
    }

    if (status === 'packed' && !order.tracking_id) {
      if (dispatching.has(orderId)) return res.status(409).json({ error: 'Dispatch already in progress for this order.' });
      dispatching.add(orderId);

      try {
        const vref = `Z${Date.now().toString().slice(-6)}`;
        let ncmResponse;
        try {
          ncmResponse = await axios.post(
            `${NCM_BASE}/v1/order/create`,
            {
              name: sanitizeText(order.customer_name),
              phone: sanitizePhone(order.phone_number),
              phone2: sanitizePhone(order.phone2),
              cod_charge: String(order.cod_amount || 0),
              address: sanitizeText(order.shipping_address),
              fbranch: NCM_FROM_BRANCH,
              branch: sanitizeText(order.to_branch) || 'KALANKI',
              package: sanitizeText(order.package_name) || 'Zenzi Product',
              vref_id: vref,
              delivery_type: sanitizeText(order.delivery_type) || 'Door2Door',
              weight: '1',
            },
            { headers: ncmHeaders, timeout: 15000 }
          );
        } catch (err) {
          return res.status(502).json({ error: 'NCM rejected the order', details: ncmErrorMessage(err) });
        }

        const ncmOrderId = ncmResponse.data && (ncmResponse.data.orderid || ncmResponse.data.order_id);
        if (!ncmOrderId) {
          return res.status(502).json({ error: 'NCM did not return an order ID', details: JSON.stringify(ncmResponse.data).slice(0, 300) });
        }

        await pool.query(
          "UPDATE orders SET tracking_id = $1, ncm_order_id = $1, vref_id = $2, status = 'packed', status_updated_at = CURRENT_TIMESTAMP WHERE id = $3",
          [String(ncmOrderId), vref, orderId]
        );
        return res.json({ success: true, tracking_id: ncmOrderId, ncm_order_id: ncmOrderId, new_status: 'packed' });
      } finally {
        dispatching.delete(orderId);
      }
    }

    await pool.query(
      `UPDATE orders SET
         status = $1::text,
         status_updated_at = CASE WHEN status <> $1::text THEN CURRENT_TIMESTAMP ELSE status_updated_at END,
         processing_started_at = CASE WHEN $1::text = 'processing'
                                      THEN COALESCE(processing_started_at, CURRENT_TIMESTAMP)
                                      ELSE processing_started_at END
       WHERE id = $2`,
      [status, orderId]
    );
    res.json({ success: true, status });
  } catch (error) {
    console.error('Status update failed:', error.message);
    res.status(500).json({ error: 'Logistics processing failed', details: error.message });
  }
});

app.post('/api/orders/:id/comments', verifyAuth, async (req, res) => {
  const text = sanitizeText(req.body.text);
  if (!text) return res.status(400).json({ error: 'Comment text required' });
  if (text.length > 1000) return res.status(400).json({ error: 'Comment is too long (max 1000 characters)' });

  try {
    const orderRes = await pool.query('SELECT tracking_id FROM orders WHERE id = $1', [req.params.id]);
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

    let ncmPushed = false;
    const tracking_id = orderRes.rows[0].tracking_id;

    if (tracking_id) {
      try {
        const ncmRes = await axios.post(
          `${NCM_BASE}/v1/comment`,
          { orderid: String(tracking_id), comments: text },
          { headers: ncmHeaders, timeout: 8000 }
        );
        ncmPushed = ncmRes.status === 200 || ncmRes.status === 201;
      } catch (err) {
        /* keep local copy even if NCM is down */
      }
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
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Failed to delete order' });
  } finally {
    client.release();
  }
});

/* -------------------------------------------------------------------------- */
/*  Analytics                                                                 */
/* -------------------------------------------------------------------------- */
app.get('/api/analytics', verifyAuth, async (req, res) => {
  try {
    const [totalOrdersRes, todayOrdersRes, totalRevenueRes, deliveredCountRes, branchBreakdownRes] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM orders'),
      pool.query(`SELECT COUNT(*) FROM orders WHERE ${LOCAL_CREATED}::date = (NOW() AT TIME ZONE '${BUSINESS_TZ}')::date`),
      pool.query("SELECT SUM(cod_amount) FROM orders WHERE status = 'delivered'"),
      pool.query("SELECT COUNT(*) FROM orders WHERE status = 'delivered'"),
      pool.query('SELECT to_branch, COUNT(*) as count FROM orders GROUP BY to_branch ORDER BY count DESC LIMIT 5'),
    ]);

    const totalOrders = parseInt(totalOrdersRes.rows[0].count, 10) || 0;
    const todayOrders = parseInt(todayOrdersRes.rows[0].count, 10) || 0;
    const totalRevenue = parseFloat(totalRevenueRes.rows[0].sum) || 0;
    const deliveredCount = parseInt(deliveredCountRes.rows[0].count, 10) || 0;
    const conversionRate = totalOrders > 0 ? ((deliveredCount / totalOrders) * 100).toFixed(1) : '0.0';

    res.json({
      totalOrders,
      todayOrders,
      totalRevenue,
      deliveredCount,
      conversionRate: `${conversionRate}%`,
      topBranches: branchBreakdownRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate analytics metrics' });
  }
});

app.get('/api/analytics/overview', verifyAuth, async (req, res) => {
  const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ }).format(new Date()); // YYYY-MM-DD

  // Accepts "YYYY-MM-DD" (or an ISO string starting with it) and returns a wall-clock boundary.
  const parseDateParam = (val, isEnd) => {
    const m = typeof val === 'string' ? val.match(/^(\d{4}-\d{2}-\d{2})/) : null;
    const day = m ? m[1] : todayLocal;
    return `${day} ${isEnd ? '23:59:59' : '00:00:00'}`;
  };

  const startStr = parseDateParam(req.query.startDate, false);
  const endStr = parseDateParam(req.query.endDate, true);
  const range = [startStr, endStr];
  const where = `${LOCAL_CREATED} >= $1::timestamp AND ${LOCAL_CREATED} <= $2::timestamp`;

  try {
    const volumeRes = await pool.query(
      `SELECT
         COUNT(*) AS total_orders,
         COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered_orders,
         COALESCE(SUM(CASE WHEN status IN ('problem', 'hold') THEN 1 ELSE 0 END), 0) AS problem_stalled_orders,
         COALESCE(SUM(CASE WHEN status IN ('problem', 'returned', 'cancelled') THEN 1 ELSE 0 END), 0) AS rto_orders,
         COALESCE(SUM(CASE WHEN status = 'delivered' THEN COALESCE(cod_amount, 0) ELSE 0 END), 0) AS total_delivered_revenue
       FROM orders WHERE ${where}`,
      range
    );

    const stats = volumeRes.rows[0] || {};
    const totalOrders = parseInt(stats.total_orders, 10) || 0;
    const deliveredOrders = parseInt(stats.delivered_orders, 10) || 0;
    const problemStalledOrders = parseInt(stats.problem_stalled_orders, 10) || 0;
    const rtoOrders = parseInt(stats.rto_orders, 10) || 0;
    const totalDeliveredRevenue = parseFloat(stats.total_delivered_revenue) || 0;

    const pct = (n) => (totalOrders > 0 ? ((n / totalOrders) * 100).toFixed(1) : '0.0');

    let avgTransitHours = '0.0';
    try {
      const leadTimeRes = await pool.query(
        `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (status_updated_at - COALESCE(processing_started_at, created_at))) / 3600), 0) AS avg_transit_hours
         FROM orders WHERE status = 'delivered' AND ${where}`,
        range
      );
      avgTransitHours = parseFloat(leadTimeRes.rows[0]?.avg_transit_hours || 0).toFixed(1);
    } catch (e) {
      /* leave default */
    }

    let branchRows = [];
    try {
      const branchRes = await pool.query(
        `SELECT to_branch, COUNT(*) AS order_count FROM orders WHERE ${where}
         GROUP BY to_branch ORDER BY order_count DESC LIMIT 10`,
        range
      );
      branchRows = branchRes.rows;
    } catch (e) {
      /* leave empty */
    }

    // Units sold per product from structured items (no text parsing)
    const productSalesMap = {};
    let totalUnitsSoldInPeriod = 0;
    try {
      const salesRes = await pool.query(
        `SELECT i->>'product_name' AS name, SUM((i->>'qty')::int) AS qty
         FROM orders,
              jsonb_array_elements(CASE WHEN jsonb_typeof(items) = 'array' THEN items ELSE '[]'::jsonb END) i
         WHERE ${where}
         GROUP BY 1`,
        range
      );
      salesRes.rows.forEach((r) => {
        const q = parseInt(r.qty, 10) || 0;
        productSalesMap[r.name] = q;
        totalUnitsSoldInPeriod += q;
      });
    } catch (e) {
      console.error('Product sales query failed:', e.message);
    }

    let inventoryRows = [];
    try {
      inventoryRows = (await pool.query('SELECT product_name, stock_quantity, sku FROM inventory ORDER BY product_name ASC')).rows;
    } catch (e) {
      /* leave empty */
    }

    const velocityList = inventoryRows.map((inv) => {
      const unitsSold = productSalesMap[inv.product_name] || 0;
      const share = totalUnitsSoldInPeriod > 0 ? ((unitsSold / totalUnitsSoldInPeriod) * 100).toFixed(1) : '0.0';
      return {
        product_name: inv.product_name,
        sku: inv.sku || '-',
        stock_quantity: inv.stock_quantity || 0,
        units_sold: unitsSold,
        volume_share: `${share}%`,
      };
    });

    res.json({
      timeframe: { startDate: startStr, endDate: endStr },
      summary: {
        totalOrders,
        totalDeliveredRevenue,
        deliverySuccessRate: `${pct(deliveredOrders)}%`,
        rtoRate: `${pct(rtoOrders)}%`,
        bottleneckRate: `${pct(problemStalledOrders)}%`,
        avgTransitHours: `${avgTransitHours} hrs`,
      },
      topBranches: branchRows,
      topMovingProducts: [...velocityList].sort((a, b) => b.units_sold - a.units_sold).slice(0, 10),
      slowMovingProducts: [...velocityList].sort((a, b) => a.units_sold - b.units_sold).slice(0, 10),
    });
  } catch (err) {
    console.error('ANALYTICS ERROR:', err.message);
    res.status(500).json({ error: 'Failed to calculate dynamic analytics dataset' });
  }
});

/* -------------------------------------------------------------------------- */
/*  Startup                                                                   */
/* -------------------------------------------------------------------------- */
(async () => {
  try {
    await runMigrations();
  } catch (err) {
    console.error('Database migration error:', err);
    process.exit(1);
  }

  setTimeout(syncOrdersWithNCM, 3000);
  setInterval(syncOrdersWithNCM, 10 * 60 * 1000);

  app.listen(PORT, () => console.log(`Zenzi CRM live on port ${PORT}`));
})();