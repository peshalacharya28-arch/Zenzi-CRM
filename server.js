const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());

// HTTP Security Headers
app.use(helmet({ contentSecurityPolicy: false }));

// Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests. Please wait a few minutes.' }
});
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, 'public')));

// Environment Variables & Fallbacks
const NCM_TOKEN = process.env.NCM_TOKEN || '6f33ba16bc5faf0902cc53ed920e78b75906b555';
const NCM_FROM_BRANCH = 'KALANKI';
const SUPABASE_URL = process.env.SUPABASE_URL || "https://pnecdxsqaevyvsnibdcu.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuZWNkeHNxYWV2eXZzbmliZGN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwNTM5ODYsImV4cCI6MjEwNDYyOTk4Nn0.Tv4JKePkfyAFUYsDnPSRNnRIt_mcs_lmNFh67VHaEBI";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Helper Function: Phone Sanitization
function sanitizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '').trim();
}

// Helper Function: String Sanitization
function sanitizeText(text) {
  if (text === null || text === undefined) return null;
  const str = String(text).trim();
  return str.length > 0 ? str : null;
}

// Database Migration & Schema Initialization
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
    vref_id TEXT,
    comments JSONB DEFAULT '[]'::jsonb,
    status_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processing_started_at TIMESTAMP DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  ALTER TABLE orders ADD COLUMN IF NOT EXISTS comments JSONB DEFAULT '[]'::jsonb;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP DEFAULT NULL;

  CREATE TABLE IF NOT EXISTS inventory (
    id SERIAL PRIMARY KEY,
    product_name TEXT UNIQUE NOT NULL,
    stock_quantity INT DEFAULT 0,
    sku TEXT
  );

  ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
  ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;

  DO $$ 
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Deny Public Orders') THEN
      CREATE POLICY "Deny Public Orders" ON orders FOR ALL USING (false);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Deny Public Inventory') THEN
      CREATE POLICY "Deny Public Inventory" ON inventory FOR ALL USING (false);
    END IF;
  END $$;
`).catch(err => console.error('Database security initialization error:', err));

// JWT Middleware
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

// --- CONCURRENT BACKGROUND NCM SYNC ENGINE ---
async function syncOrdersWithNCM() {
  try {
    const activeOrdersRes = await pool.query(
      "SELECT * FROM orders WHERE tracking_id IS NOT NULL AND status IN ('packed', 'processing')"
    );
    const activeOrders = activeOrdersRes.rows;
    if (activeOrders.length === 0) return;

    const now = new Date();

    // Batch process concurrently with Promise.allSettled
    await Promise.allSettled(activeOrders.map(async (order) => {
      try {
        // 1. Fetch NCM Live Status
        const statusRes = await axios.get(`https://portal.nepalcanmove.com/api/v1/order/status?id=${order.tracking_id}`, {
          headers: { 'Authorization': `Token ${NCM_TOKEN}` },
          timeout: 8000
        });

        let newStatus = order.status;
        let processingTimestamp = order.processing_started_at;

        let latestNcmStatusStr = '';
        if (Array.isArray(statusRes.data) && statusRes.data.length > 0) {
          latestNcmStatusStr = String(statusRes.data[0].status || '').toUpperCase();
        } else if (typeof statusRes.data === 'object' && statusRes.data && statusRes.data.status) {
          latestNcmStatusStr = String(statusRes.data.status).toUpperCase();
        }

        // Map status strictly based on the latest NCM timeline item
        if (latestNcmStatusStr.includes('DELIVERED')) {
          newStatus = 'delivered';
        } else if (
          latestNcmStatusStr.includes('DISPATCH') || 
          latestNcmStatusStr.includes('TRANSIT') || 
          latestNcmStatusStr.includes('SENT FOR DELIVERY') ||
          latestNcmStatusStr.includes('OUT FOR DELIVERY')
        ) {
          newStatus = 'processing';
          // Preserve initial processing timestamp without resetting it on transit updates
          if (!processingTimestamp) {
            processingTimestamp = new Date();
          }
        } else if (
          latestNcmStatusStr.includes('CANCEL') || 
          latestNcmStatusStr.includes('RETURN') || 
          latestNcmStatusStr.includes('REJECTED')
        ) {
          newStatus = 'problem';
        }

        // 2. Strict 72-Hour Escalation Check (Applies ONLY if in processing phase)
        if (newStatus === 'processing' && processingTimestamp) {
          const processStart = new Date(processingTimestamp);
          const hoursInProcessing = (now - processStart) / (1000 * 60 * 60);

          if (hoursInProcessing >= 72) {
            newStatus = 'problem';
            const autoComment = {
              id: Date.now(),
              text: "⚠️ System Auto-Escalation: Order exceeded 3 days (72h) in processing without delivery.",
              author: "System Bot",
              timestamp: now.toISOString()
            };
            await pool.query(
              `UPDATE orders SET comments = COALESCE(comments, '[]'::jsonb) || $1::jsonb WHERE id = $2`,
              [JSON.stringify([autoComment]), order.id]
            );
          }
        }

        // 3. Fetch NCM Remote Comments & Merge Cleanly
        let existingComments = Array.isArray(order.comments) ? order.comments : [];
        try {
          const commentRes = await axios.get(`https://portal.nepalcanmove.com/api/v1/order/comment?id=${order.tracking_id}`, {
            headers: { 'Authorization': `Token ${NCM_TOKEN}` },
            timeout: 8000
          });

          if (Array.isArray(commentRes.data)) {
            commentRes.data.forEach(item => {
              const textStr = String(item.comments || '').trim();
              if (textStr) {
                const exists = existingComments.some(ec => ec.text === textStr);
                if (!exists) {
                  existingComments.push({
                    id: item.added_time || Date.now(),
                    text: textStr,
                    author: item.addedBy || 'NCM Staff',
                    timestamp: item.added_time || new Date().toISOString()
                  });
                }
              }
            });
          }
        } catch (err) {}

        await pool.query(
          "UPDATE orders SET status = $1, status_updated_at = CURRENT_TIMESTAMP, processing_started_at = $2, comments = $3 WHERE id = $4",
          [newStatus, processingTimestamp, JSON.stringify(existingComments), order.id]
        );

      } catch (err) {}
    }));
  } catch (err) {
    console.error('NCM Sync Engine Error:', err);
  }
}

// Run Sync Job Every 10 Minutes
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

  if (!product_name) {
    return res.status(400).json({ error: 'Product name is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO inventory (product_name, stock_quantity, sku)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_name) 
       DO UPDATE SET stock_quantity = EXCLUDED.stock_quantity, sku = EXCLUDED.sku
       RETURNING *`,
      [product_name, stock_quantity, sku]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save inventory item' });
  }
});

app.patch('/api/inventory/:id/stock', verifyAuth, async (req, res) => {
  const adjustment = parseInt(req.body.adjustment) || 0;
  try {
    const result = await pool.query(
      'UPDATE inventory SET stock_quantity = GREATEST(0, stock_quantity + $1) WHERE id = $2 RETURNING *',
      [adjustment, req.params.id]
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

// --- ANALYTICS ENDPOINT ---
app.get('/api/analytics', verifyAuth, async (req, res) => {
  try {
    const totalOrdersRes = await pool.query('SELECT COUNT(*) FROM orders');
    const todayOrdersRes = await pool.query('SELECT COUNT(*) FROM orders WHERE created_at >= CURRENT_DATE');
    const totalRevenueRes = await pool.query('SELECT SUM(CAST(NULLIF(cod_amount, \'\') AS NUMERIC)) FROM orders WHERE status != \'problem\'');
    const deliveredCountRes = await pool.query('SELECT COUNT(*) FROM orders WHERE status = \'delivered\'');
    const branchBreakdownRes = await pool.query(
      'SELECT to_branch, COUNT(*) as count FROM orders GROUP BY to_branch ORDER BY count DESC LIMIT 5'
    );

    const totalOrders = parseInt(totalOrdersRes.rows[0].count) || 0;
    const todayOrders = parseInt(todayOrdersRes.rows[0].count) || 0;
    const totalRevenue = parseFloat(totalRevenueRes.rows[0].sum) || 0;
    const deliveredCount = parseInt(deliveredCountRes.rows[0].count) || 0;
    const conversionRate = totalOrders > 0 ? ((deliveredCount / totalOrders) * 100).toFixed(1) : 0;

    res.json({
      totalOrders,
      todayOrders,
      totalRevenue,
      deliveredCount,
      conversionRate: `${conversionRate}%`,
      topBranches: branchBreakdownRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate analytics metrics' });
  }
});

// --- ORDERS ENDPOINTS ---
app.get('/api/branches', verifyAuth, async (req, res) => {
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

app.get('/api/orders', verifyAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY id DESC');
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

    // Fetch live NCM comments directly on modal open
    if (order.tracking_id) {
      try {
        const commentRes = await axios.get(`https://portal.nepalcanmove.com/api/v1/order/comment?id=${order.tracking_id}`, {
          headers: { 'Authorization': `Token ${NCM_TOKEN}` },
          timeout: 6000
        });

        if (Array.isArray(commentRes.data)) {
          let existingComments = Array.isArray(order.comments) ? order.comments : [];
          commentRes.data.forEach(item => {
            const textStr = String(item.comments || '').trim();
            if (textStr) {
              const exists = existingComments.some(ec => ec.text === textStr);
              if (!exists) {
                existingComments.push({
                  id: item.added_time || Date.now(),
                  text: textStr,
                  author: item.addedBy || 'NCM Staff',
                  timestamp: item.added_time || new Date().toISOString()
                });
              }
            }
          });

          await pool.query('UPDATE orders SET comments = $1 WHERE id = $2', [JSON.stringify(existingComments), order.id]);
          order.comments = existingComments;
        }
      } catch (err) {}
    }

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order details' });
  }
});

// CREATE ORDER WITH ATOMIC STOCK TRANSACTIONS
app.post('/api/orders', verifyAuth, async (req, res) => {
  const customer_name = sanitizeText(req.body.customer_name);
  const phone_number = sanitizePhone(req.body.phone_number);
  const phone2 = sanitizePhone(req.body.phone2) || null;
  const shipping_address = sanitizeText(req.body.shipping_address);
  const cod_amount = sanitizeText(req.body.cod_amount) || '0';
  const to_branch = sanitizeText(req.body.to_branch) || 'KALANKI';
  const instruction = sanitizeText(req.body.instruction) || null;
  const delivery_type = sanitizeText(req.body.delivery_type) || 'Door2Door';
  const items = req.body.items;

  if (!customer_name || !phone_number || !shipping_address) {
    return res.status(400).json({ error: 'Missing required order fields' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let packageSummaryParts = [];
    if (Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        const product_name = sanitizeText(item.product_name);
        const requestedQty = parseInt(item.qty) || 1;

        if (product_name) {
          const stockCheck = await client.query('SELECT stock_quantity FROM inventory WHERE product_name = $1', [product_name]);

          if (stockCheck.rows.length > 0) {
            const currentStock = stockCheck.rows[0].stock_quantity;
            if (currentStock < requestedQty) {
              throw new Error(`Insufficient stock for "${product_name}". Available: ${currentStock}, Requested: ${requestedQty}`);
            }

            // Atomic Stock Deduction
            await client.query(
              'UPDATE inventory SET stock_quantity = GREATEST(0, stock_quantity - $1) WHERE product_name = $2',
              [requestedQty, product_name]
            );
          }
          packageSummaryParts.push(`${requestedQty}x ${product_name}`);
        }
      }
    }

    const finalPackageName = packageSummaryParts.length > 0 ? packageSummaryParts.join(', ') : 'Zenzi Item';

    const result = await client.query(
      `INSERT INTO orders 
       (customer_name, phone_number, phone2, shipping_address, package_name, cod_amount, to_branch, instruction, delivery_type, status, comments, status_updated_at, processing_started_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]'::jsonb, CURRENT_TIMESTAMP, NULL) RETURNING id`,
      [
        customer_name, phone_number, phone2, shipping_address, 
        finalPackageName, cod_amount, to_branch, 
        instruction, delivery_type, 'received'
      ]
    );

    await client.query('COMMIT');
    res.json({ id: result.rows[0].id, package_name: finalPackageName });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message || 'Database order creation failed' });
  } finally {
    client.release();
  }
});

// EDIT ORDER (RESTRICTED TO 'received' STATUS ONLY)
app.put('/api/orders/:id', verifyAuth, async (req, res) => {
  const customer_name = sanitizeText(req.body.customer_name);
  const phone_number = sanitizePhone(req.body.phone_number);
  const phone2 = sanitizePhone(req.body.phone2) || null;
  const shipping_address = sanitizeText(req.body.shipping_address);
  const cod_amount = sanitizeText(req.body.cod_amount) || '0';
  const to_branch = sanitizeText(req.body.to_branch) || 'KALANKI';
  const instruction = sanitizeText(req.body.instruction) || null;
  const delivery_type = sanitizeText(req.body.delivery_type) || 'Door2Door';
  const items = req.body.items;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const currentOrderRes = await client.query('SELECT status, package_name FROM orders WHERE id = $1', [req.params.id]);
    if (currentOrderRes.rows.length === 0) throw new Error('Order not found');

    const currentOrder = currentOrderRes.rows[0];
    if (currentOrder.status !== 'received') {
      throw new Error('Order cannot be edited once it has passed "Received" status');
    }

    // 1. Restore previous stock items atomically
    if (currentOrder.package_name) {
      const prevItems = currentOrder.package_name.split(',').map(i => i.trim());
      for (const itemStr of prevItems) {
        const match = itemStr.match(/^(\d+)x\s+(.+)$/);
        if (match) {
          await client.query(
            'UPDATE inventory SET stock_quantity = stock_quantity + $1 WHERE product_name = $2',
            [parseInt(match[1]) || 1, match[2].trim()]
          );
        }
      }
    }

    // 2. Validate & deduct new items atomically
    let packageSummaryParts = [];
    if (Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        const product_name = sanitizeText(item.product_name);
        const requestedQty = parseInt(item.qty) || 1;

        if (product_name) {
          const stockCheck = await client.query('SELECT stock_quantity FROM inventory WHERE product_name = $1', [product_name]);

          if (stockCheck.rows.length > 0) {
            const currentStock = stockCheck.rows[0].stock_quantity;
            if (currentStock < requestedQty) {
              throw new Error(`Insufficient stock for "${product_name}". Available: ${currentStock}, Requested: ${requestedQty}`);
            }

            await client.query(
              'UPDATE inventory SET stock_quantity = GREATEST(0, stock_quantity - $1) WHERE product_name = $2',
              [requestedQty, product_name]
            );
          }
          packageSummaryParts.push(`${requestedQty}x ${product_name}`);
        }
      }
    }

    const finalPackageName = packageSummaryParts.length > 0 ? packageSummaryParts.join(', ') : 'Zenzi Item';

    await client.query(
      `UPDATE orders 
       SET customer_name = $1, phone_number = $2, phone2 = $3, shipping_address = $4, 
           package_name = $5, cod_amount = $6, to_branch = $7, instruction = $8, delivery_type = $9
       WHERE id = $10`,
      [
        customer_name, phone_number, phone2, shipping_address, 
        finalPackageName, cod_amount, to_branch, 
        instruction, delivery_type, req.params.id
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

// POST COMMENTS TO NCM API
app.post('/api/orders/:id/comments', verifyAuth, async (req, res) => {
  const text = sanitizeText(req.body.text);
  if (!text) return res.status(400).json({ error: 'Comment text is required' });

  try {
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    let ncmPushed = false;
    if (order.tracking_id) {
      try {
        const ncmRes = await axios.post('https://portal.nepalcanmove.com/api/v1/comment', {
          orderid: String(order.tracking_id),
          comments: text
        }, {
          headers: { 
            'Authorization': `Token ${NCM_TOKEN}`, 
            'Content-Type': 'application/json' 
          },
          timeout: 8000
        });

        if (ncmRes.status === 200 || ncmRes.status === 201) {
          ncmPushed = true;
        }
      } catch (err) {
        console.error('NCM Post Comment Error:', err.response ? err.response.data : err.message);
      }
    }

    const commentObj = {
      id: Date.now(),
      text: text,
      author: 'Vendor (Zenzi)',
      timestamp: new Date().toISOString()
    };

    const updatedRes = await pool.query(
      `UPDATE orders 
       SET comments = COALESCE(comments, '[]'::jsonb) || $1::jsonb 
       WHERE id = $2 RETURNING *`,
      [JSON.stringify([commentObj]), req.params.id]
    );

    res.json({ ...updatedRes.rows[0], ncm_pushed: ncmPushed });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// STATUS UPDATE & NCM DISPATCH TRIGGER WITH SANITIZED SANITY CHECKS
app.patch('/api/orders/:id/status', verifyAuth, async (req, res) => {
  const status = sanitizeText(req.body.status);
  const orderId = req.params.id;

  try {
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = orderResult.rows[0];

    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (status === 'packed' && !order.tracking_id) {
      const shortTimestamp = Date.now().toString().slice(-6);
      const vref = `Z${shortTimestamp}`;

      // Strictly sanitize phone payload right before building Axios JSON
      const cleanPhone = sanitizePhone(order.phone_number);
      const cleanPhone2 = sanitizePhone(order.phone2);

      const ncmPayload = {
        name: sanitizeText(order.customer_name),
        phone: cleanPhone,
        cod_charge: String(order.cod_amount || '0').trim(),
        address: sanitizeText(order.shipping_address),
        fbranch: NCM_FROM_BRANCH,
        branch: sanitizeText(order.to_branch) || 'KALANKI',
        package: sanitizeText(order.package_name) || 'Zenzi Product',
        vref_id: vref,
        delivery_type: sanitizeText(order.delivery_type) || 'Door2Door',
        weight: '1'
      };

      if (cleanPhone2) ncmPayload.phone2 = cleanPhone2;
      if (order.instruction) ncmPayload.instruction = sanitizeText(order.instruction);

      const ncmResponse = await axios.post(
        'https://portal.nepalcanmove.com/api/v1/order/create',
        ncmPayload,
        { headers: { 'Authorization': `Token ${NCM_TOKEN}`, 'Content-Type': 'application/json' } }
      );

      if (ncmResponse.status === 200 || ncmResponse.status === 201) {
        const ncmOrderId = ncmResponse.data.orderid || ncmResponse.data.order_id || 'NCM-CREATED';
        await pool.query(
          "UPDATE orders SET tracking_id = $1, vref_id = $2, status = 'packed', status_updated_at = CURRENT_TIMESTAMP, processing_started_at = NULL WHERE id = $3",
          [String(ncmOrderId), vref, orderId]
        );
        return res.json({ success: true, tracking_id: ncmOrderId, vref_id: vref, new_status: 'packed' });
      } else {
        return res.status(400).json({ error: 'NCM API rejected order creation', details: ncmResponse.data });
      }
    }

    const isProcessing = status === 'processing';
    const processingTimeQuery = isProcessing ? ', processing_started_at = COALESCE(processing_started_at, CURRENT_TIMESTAMP)' : '';

    await pool.query(
      `UPDATE orders SET status = $1, status_updated_at = CURRENT_TIMESTAMP ${processingTimeQuery} WHERE id = $2`, 
      [status, orderId]
    );

    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ error: 'Logistics processing failed', details: error.response ? error.response.data : error.message });
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

    const orderRes = await client.query('SELECT package_name FROM orders WHERE id = $1', [req.params.id]);
    if (orderRes.rows.length > 0) {
      const packageName = orderRes.rows[0].package_name || '';
      const items = packageName.split(',').map(item => item.trim());
      for (const itemStr of items) {
        const match = itemStr.match(/^(\d+)x\s+(.+)$/);
        if (match) {
          const qtyToRestore = parseInt(match[1]) || 1;
          const productName = match[2].trim();

          await client.query(
            'UPDATE inventory SET stock_quantity = stock_quantity + $1 WHERE product_name = $2',
            [qtyToRestore, productName]
          );
        }
      }
    }

    await client.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to delete order and restore stock' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Zenzi CRM live on port ${PORT}`));