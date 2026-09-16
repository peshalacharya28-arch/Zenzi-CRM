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

app.use(helmet({ contentSecurityPolicy: false }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many requests. Please wait.' }
});
app.use('/api/', apiLimiter);

app.use(express.static(path.join(__dirname, 'public')));

const NCM_TOKEN = process.env.NCM_TOKEN || '6f33ba16bc5faf0902cc53ed920e78b75906b555';
const NCM_FROM_BRANCH = 'KALANKI';
const SUPABASE_URL = process.env.SUPABASE_URL || "https://pnecdxsqaevyvsnibdcu.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuZWNkeHNxYWV2eXZzbmliZGN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwNTM5ODYsImV4cCI6MjEwNDYyOTk4Nn0.Tv4JKePkfyAFUYsDnPSRNnRIt_mcs_lmNFh67VHaEBI";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
`).catch(err => console.error('Database setup error:', err));

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

// --- CORE NCM BACKGROUND SYNC ENGINE (10-MIN INTERVAL) ---
async function syncOrdersWithNCM() {
  try {
    const activeOrders = await pool.query("SELECT * FROM orders WHERE tracking_id IS NOT NULL AND status IN ('packed', 'processing')");
    const now = new Date();

    for (const order of activeOrders.rows) {
      try {
        // 1. Fetch NCM Live Status
        const statusRes = await axios.get(`https://portal.nepalcanmove.com/api/v1/order/status?id=${order.tracking_id}`, {
          headers: { 'Authorization': `Token ${NCM_TOKEN}` },
          timeout: 8000
        });

        let newStatus = order.status;
        let processingTimestamp = order.processing_started_at;
        const statusText = JSON.stringify(statusRes.data).toUpperCase();

        if (statusText.includes('DELIVERED')) {
          newStatus = 'delivered';
        } else if (statusText.includes('DISPATCH') || statusText.includes('TRANSIT') || statusText.includes('SENT FOR DELIVERY')) {
          newStatus = 'processing';
          // Record the exact time when it enters processing for the first time
          if (!processingTimestamp) {
            processingTimestamp = new Date();
          }
        } else if (statusText.includes('CANCEL') || statusText.includes('RETURN') || statusText.includes('REJECTED')) {
          newStatus = 'problem';
        }

        // 2. STRICT 3-DAY TIMEOUT CHECK (ONLY EXECUTES IF ALREADY IN PROCESSING PHASE)
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

        // 3. Fetch NCM Comments
        const commentRes = await axios.get(`https://portal.nepalcanmove.com/api/v1/order/comment?id=${order.tracking_id}`, {
          headers: { 'Authorization': `Token ${NCM_TOKEN}` },
          timeout: 8000
        });

        let updatedCommentsList = [];
        if (Array.isArray(commentRes.data)) {
          commentRes.data.forEach(item => {
            updatedCommentsList.push({
              id: item.added_time || Date.now(),
              text: item.comments,
              author: item.addedBy || 'NCM Staff',
              timestamp: item.added_time || new Date().toISOString()
            });
          });
        }

        await pool.query(
          "UPDATE orders SET status = $1, status_updated_at = CURRENT_TIMESTAMP, processing_started_at = $2, comments = $3 WHERE id = $4",
          [newStatus, processingTimestamp, JSON.stringify(updatedCommentsList), order.id]
        );

      } catch (err) {}
    }
  } catch (err) {
    console.error('NCM Sync Error:', err);
  }
}

// Automatic 10-Minute Cron Run
setInterval(syncOrdersWithNCM, 10 * 60 * 1000);

// --- INVENTORY API ---
app.get('/api/inventory', verifyAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inventory ORDER BY product_name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

app.post('/api/inventory', verifyAuth, async (req, res) => {
  const { product_name, stock_quantity, sku } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO inventory (product_name, stock_quantity, sku)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_name) 
       DO UPDATE SET stock_quantity = EXCLUDED.stock_quantity, sku = EXCLUDED.sku
       RETURNING *`,
      [product_name, parseInt(stock_quantity) || 0, sku || '']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save inventory item' });
  }
});

app.patch('/api/inventory/:id/stock', verifyAuth, async (req, res) => {
  const { adjustment } = req.body;
  try {
    const result = await pool.query(
      'UPDATE inventory SET stock_quantity = GREATEST(0, stock_quantity + $1) WHERE id = $2 RETURNING *',
      [parseInt(adjustment), req.params.id]
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

// --- ANALYTICS ---
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
    res.status(500).json({ error: 'Failed to calculate metrics' });
  }
});

// --- ORDERS & LIVE DETAILS ---
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

    if (order.tracking_id) {
      try {
        const commentRes = await axios.get(`https://portal.nepalcanmove.com/api/v1/order/comment?id=${order.tracking_id}`, {
          headers: { 'Authorization': `Token ${NCM_TOKEN}` },
          timeout: 6000
        });

        if (Array.isArray(commentRes.data)) {
          let ncmCommentsParsed = [];
          commentRes.data.forEach(item => {
            ncmCommentsParsed.push({
              id: item.added_time || Date.now(),
              text: item.comments,
              author: item.addedBy || 'NCM Staff',
              timestamp: item.added_time || new Date().toISOString()
            });
          });

          await pool.query('UPDATE orders SET comments = $1 WHERE id = $2', [JSON.stringify(ncmCommentsParsed), order.id]);
          order.comments = ncmCommentsParsed;
        }
      } catch (err) {}
    }

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order details' });
  }
});

app.post('/api/orders/:id/comments', verifyAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comment text is required' });

  try {
    const orderRes = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    let ncmPushed = false;
    if (order.tracking_id) {
      try {
        const ncmRes = await axios.post('https://portal.nepalcanmove.com/api/v1/comment', {
          orderid: String(order.tracking_id),
          comments: text.trim()
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
      text: text.trim(),
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

app.put('/api/orders/:id', verifyAuth, async (req, res) => {
  const { 
    customer_name, phone_number, phone2, shipping_address, 
    items, cod_amount, to_branch, instruction, delivery_type 
  } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const currentOrderRes = await client.query('SELECT status, package_name FROM orders WHERE id = $1', [req.params.id]);
    if (currentOrderRes.rows.length === 0) throw new Error('Order not found');

    const currentOrder = currentOrderRes.rows[0];
    if (currentOrder.status !== 'received') {
      throw new Error('Order cannot be edited once it has passed "Received" status');
    }

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

    let packageSummaryParts = [];
    if (Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        const { product_name, qty } = item;
        const requestedQty = parseInt(qty) || 1;

        const stockCheck = await client.query('SELECT stock_quantity FROM inventory WHERE product_name = $1', [product_name]);

        if (stockCheck.rows.length > 0) {
          const currentStock = stockCheck.rows[0].stock_quantity;
          if (currentStock < requestedQty) {
            throw new Error(`Insufficient stock for "${product_name}". Available: ${currentStock}, Requested: ${requestedQty}`);
          }

          await client.query(
            'UPDATE inventory SET stock_quantity = stock_quantity - $1 WHERE product_name = $2',
            [requestedQty, product_name]
          );
        }
        packageSummaryParts.push(`${requestedQty}x ${product_name}`);
      }
    }

    const finalPackageName = packageSummaryParts.length > 0 ? packageSummaryParts.join(', ') : 'Zenzi Item';

    await client.query(
      `UPDATE orders 
       SET customer_name = $1, phone_number = $2, phone2 = $3, shipping_address = $4, 
           package_name = $5, cod_amount = $6, to_branch = $7, instruction = $8, delivery_type = $9
       WHERE id = $10`,
      [
        customer_name, phone_number, phone2 || null, shipping_address, 
        finalPackageName, cod_amount || '0', to_branch || 'KALANKI', 
        instruction || null, delivery_type || 'Door2Door', req.params.id
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

app.post('/api/orders', verifyAuth, async (req, res) => {
  const { 
    customer_name, phone_number, phone2, shipping_address, 
    items, cod_amount, to_branch, instruction, delivery_type 
  } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let packageSummaryParts = [];
    if (Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        const { product_name, qty } = item;
        const requestedQty = parseInt(qty) || 1;

        const stockCheck = await client.query('SELECT stock_quantity FROM inventory WHERE product_name = $1', [product_name]);

        if (stockCheck.rows.length > 0) {
          const currentStock = stockCheck.rows[0].stock_quantity;
          if (currentStock < requestedQty) {
            throw new Error(`Insufficient stock for "${product_name}". Available: ${currentStock}, Requested: ${requestedQty}`);
          }

          await client.query(
            'UPDATE inventory SET stock_quantity = stock_quantity - $1 WHERE product_name = $2',
            [requestedQty, product_name]
          );
        }
        packageSummaryParts.push(`${requestedQty}x ${product_name}`);
      }
    }

    const finalPackageName = packageSummaryParts.length > 0 ? packageSummaryParts.join(', ') : 'Zenzi Item';

    const result = await client.query(
      `INSERT INTO orders 
       (customer_name, phone_number, phone2, shipping_address, package_name, cod_amount, to_branch, instruction, delivery_type, status, comments, status_updated_at, processing_started_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]'::jsonb, CURRENT_TIMESTAMP, NULL) RETURNING id`,
      [
        customer_name, phone_number, phone2 || null, shipping_address, 
        finalPackageName, cod_amount || '0', to_branch || 'KALANKI', 
        instruction || null, delivery_type || 'Door2Door', 'received'
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

app.patch('/api/orders/:id/status', verifyAuth, async (req, res) => {
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
          "UPDATE orders SET tracking_id = $1, vref_id = $2, status = 'packed', status_updated_at = CURRENT_TIMESTAMP WHERE id = $3",
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