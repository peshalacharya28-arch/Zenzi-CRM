'use strict';

const express = require('express');
const { Pool, types } = require('pg');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

/* -------------------------------------------------------------------------- */
/*  Configuration (no hardcoded secrets: the server refuses to start without)  */
/* -------------------------------------------------------------------------- */
const REQUIRED_ENV = ['NCM_TOKEN', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ALLOWED_EMAILS', 'ADMIN_EMAILS'];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  throw new Error(`Missing required environment variables: ${missingEnv.join(', ')}`);
}

const NCM_TOKEN = process.env.NCM_TOKEN;
const NCM_FROM_BRANCH = process.env.NCM_FROM_BRANCH || 'KALANKI';
const NCM_BASE = 'https://portal.nepalcanmove.com/api';
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'Asia/Kathmandu';
const PORT = process.env.PORT || 3000;

const parseList = (v) => (v || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

// Roles. ADMIN_EMAILS: full access (delete, product/price edits, activity log).
// ALLOWED_EMAILS: staff who may use the CRM. Admins are always allowed.
const ADMIN_EMAILS = parseList(process.env.ADMIN_EMAILS);
const ALLOWED_EMAILS = [...new Set([...parseList(process.env.ALLOWED_EMAILS), ...ADMIN_EMAILS])];
const isAdminUser = (user) => ADMIN_EMAILS.includes(String((user && user.email) || '').toLowerCase());
const IS_PROD = process.env.NODE_ENV === 'production';

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
const SUPABASE_ORIGIN = new URL(process.env.SUPABASE_URL).origin;
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'"], // pages use inline scripts; no third-party script hosts
  scriptSrcAttr: ["'unsafe-inline'"], // inline onclick handlers
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'", SUPABASE_ORIGIN],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};
if (!IS_PROD) cspDirectives.upgradeInsecureRequests = null; // allow plain http://localhost in development
app.use(helmet({ contentSecurityPolicy: { directives: cspDirectives } }));

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
const makeLimiter = (max, message) =>
  rateLimit({ windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { error: message } });
const statusLimiter = makeLimiter(120, 'Too many status changes. Please wait a few minutes.');
const syncLimiter = makeLimiter(10, 'Sync was requested too often. Please wait a few minutes.');

// Serve the Supabase browser bundle from our own origin (no third-party CDN, version locked by package-lock.json).
function findSupabaseBundle() {
  let dir = path.dirname(require.resolve('@supabase/supabase-js'));
  while (dir !== path.dirname(dir)) {
    const pkgFile = path.join(dir, 'package.json');
    if (fs.existsSync(pkgFile)) {
      const meta = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (meta.name === '@supabase/supabase-js') return path.join(dir, meta.unpkg || meta.jsdelivr || 'dist/umd/supabase.js');
    }
    dir = path.dirname(dir);
  }
  return null;
}
const SUPABASE_BUNDLE = findSupabaseBundle();
if (!SUPABASE_BUNDLE || !fs.existsSync(SUPABASE_BUNDLE)) {
  throw new Error('Cannot find the @supabase/supabase-js browser bundle. Run "npm ci" first.');
}
app.get('/vendor/supabase.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'public, max-age=86400').sendFile(SUPABASE_BUNDLE);
});

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

/* ---- Audit log helpers ---- */
const who = (req) => (req.user && (req.user.email || req.user.id)) || 'unknown';

// Throws on failure: use inside a transaction so the change and its log entry commit together.
async function audit(db, actor, action, entity, entityId, label, details = {}) {
  await db.query(
    `INSERT INTO audit_log (user_email, action, entity, entity_id, entity_label, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [actor, action, entity, entityId === null || entityId === undefined ? null : String(entityId), label || null, JSON.stringify(details)]
  );
}
// Never throws: for actions that are not inside a transaction.
const auditSafe = (...args) => audit(...args).catch((e) => console.error('Audit log failed:', e.message));

// Net stock change per product between two item lists (negative = stock taken out).
function stockDelta(oldItems = [], newItems = []) {
  const map = {};
  for (const i of oldItems) map[i.product_name] = (map[i.product_name] || 0) + Number(i.qty || 0);
  for (const i of newItems) map[i.product_name] = (map[i.product_name] || 0) - Number(i.qty || 0);
  return Object.entries(map).filter(([, d]) => d !== 0).map(([product, delta]) => ({ product, delta }));
}
const withStock = (details, arr) => { if (arr && arr.length) details.stock = arr; return details; };

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const requireAdmin = (req, res, next) => {
  if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Admin access required' });
  next();
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
      bill_no INT
    );

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS comments JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP DEFAULT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_pan TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS ncm_order_id TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_no INT;
    ALTER TABLE orders ALTER COLUMN bill_no DROP DEFAULT;

    -- Gapless bill numbering: one counter row, incremented inside the order transaction.
    CREATE TABLE IF NOT EXISTS bill_counter (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      last_no INT NOT NULL DEFAULT 0
    );
    INSERT INTO bill_counter (id, last_no) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
    -- Continue after the highest existing bill number (existing printed bills keep their numbers).
    UPDATE bill_counter SET last_no = GREATEST(last_no, COALESCE((SELECT MAX(bill_no) FROM orders), 0)) WHERE id = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_bill_no ON orders (bill_no);

    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by TEXT;

    -- Who did what, and when (timestamptz: unambiguous regardless of server timezone)
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_email TEXT NOT NULL,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT,
      entity_label TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_email);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity, entity_id);

    -- Keep the log private from Supabase's public REST API (the server role bypasses RLS)
    DO $$ BEGIN
      ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON audit_log FROM anon, authenticated;
    EXCEPTION WHEN OTHERS THEN NULL; END $$;

    -- The audit log is append-only: rows can never be edited or deleted.
    CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $fn$
    BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
    $fn$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_log;
    CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

    DO $$ BEGIN
      ALTER TABLE orders ALTER COLUMN cod_amount TYPE NUMERIC USING (NULLIF(cod_amount::text, '')::NUMERIC);
    EXCEPTION WHEN OTHERS THEN NULL; END $$;
  `);

  // Keep every table away from Supabase's public REST API (this server connects as postgres and bypasses RLS).
  for (const table of ['orders', 'inventory', 'bill_counter', 'audit_log']) {
    await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`).catch((e) => console.warn(`RLS on ${table}:`, e.message));
    await pool.query(`REVOKE ALL ON TABLE ${table} FROM anon, authenticated`).catch(() => {});
  }
  await pool.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated').catch(() => {});
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

    if (!ALLOWED_EMAILS.includes(String(user.email || '').toLowerCase())) {
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

app.get('/api/me', verifyAuth, (req, res) => {
  res.json({ email: req.user.email, is_admin: isAdminUser(req.user) });
});

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

        if (newStatus !== order.status) {
          await auditSafe(pool, 'system', 'order.status_auto', 'order', order.id, `Order #${order.id}`, {
            from: order.status, to: newStatus, tracking_id: order.tracking_id,
          });
        }
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

app.post('/api/inventory', verifyAuth, requireAdmin, async (req, res) => {
  const product_name = sanitizeText(req.body.product_name);
  const sku = sanitizeText(req.body.sku) || '';
  const hs_code = sanitizeText(req.body.hs_code) || '';
  const stock_quantity = parseInt(req.body.stock_quantity, 10);
  const default_price = Number(req.body.default_price);

  if (!product_name) return res.status(400).json({ error: 'Product name is required' });
  if (!Number.isInteger(stock_quantity) || stock_quantity < 0) return res.status(400).json({ error: 'Invalid stock quantity' });
  if (!Number.isFinite(default_price) || default_price < 0) return res.status(400).json({ error: 'Invalid price' });

  try {
    const row = await withTransaction(async (client) => {
      const prev = (await client.query('SELECT * FROM inventory WHERE product_name = $1 FOR UPDATE', [product_name])).rows[0];
      const result = await client.query(
        `INSERT INTO inventory (product_name, stock_quantity, sku, hs_code, default_price)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (product_name) DO UPDATE SET
           stock_quantity = EXCLUDED.stock_quantity, sku = EXCLUDED.sku,
           hs_code = EXCLUDED.hs_code, default_price = EXCLUDED.default_price
         RETURNING *`,
        [product_name, stock_quantity, sku, hs_code, default_price]
      );
      const saved = result.rows[0];
      const snap = (r) => (r ? { stock: r.stock_quantity, price: Number(r.default_price), sku: r.sku || '', hs_code: r.hs_code || '' } : null);
      const before = snap(prev);
      const after = snap(saved);

      if (!prev || JSON.stringify(before) !== JSON.stringify(after)) {
        const delta = saved.stock_quantity - (prev ? prev.stock_quantity : 0);
        await audit(client, who(req), prev ? 'inventory.update' : 'inventory.create', 'inventory', saved.id, product_name,
          withStock({ before, after }, delta !== 0 ? [{ product: product_name, delta }] : []));
      }
      return saved;
    });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save inventory item' });
  }
});

app.patch('/api/inventory/:id/stock', verifyAuth, async (req, res) => {
  const adjustment = parseInt(req.body.adjustment, 10);
  if (!Number.isInteger(adjustment)) return res.status(400).json({ error: 'Invalid adjustment' });

  try {
    const row = await withTransaction(async (client) => {
      const result = await client.query(
        `WITH old AS (SELECT id, stock_quantity FROM inventory WHERE id = $2 FOR UPDATE)
         UPDATE inventory i SET stock_quantity = GREATEST(0, old.stock_quantity + $1)
         FROM old WHERE i.id = old.id
         RETURNING i.*, old.stock_quantity AS old_qty`,
        [adjustment, req.params.id]
      );
      if (result.rows.length === 0) return null;
      const r = result.rows[0];
      const delta = r.stock_quantity - r.old_qty;
      await audit(client, who(req), 'inventory.adjust', 'inventory', r.id, r.product_name,
        withStock({ before: r.old_qty, after: r.stock_quantity }, delta !== 0 ? [{ product: r.product_name, delta }] : []));
      delete r.old_qty;
      return r;
    });
    if (!row) return res.status(404).json({ error: 'Product not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'Failed to adjust stock' });
  }
});

app.delete('/api/inventory/:id', verifyAuth, requireAdmin, async (req, res) => {
  try {
    await withTransaction(async (client) => {
      const del = await client.query('DELETE FROM inventory WHERE id = $1 RETURNING *', [req.params.id]);
      if (del.rows.length > 0) {
        const r = del.rows[0];
        await audit(client, who(req), 'inventory.delete', 'inventory', r.id, r.product_name,
          withStock({ stock_quantity: r.stock_quantity }, r.stock_quantity ? [{ product: r.product_name, delta: -r.stock_quantity }] : []));
      }
    });
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

    // Take the next bill number last (row lock is held until COMMIT). If anything above fails,
    // the whole transaction rolls back and the number is NOT consumed.
    const billRes = await client.query('UPDATE bill_counter SET last_no = last_no + 1 WHERE id = 1 RETURNING last_no');
    const billNo = billRes.rows[0].last_no;

    const result = await client.query(
      `INSERT INTO orders (customer_name, phone_number, phone2, shipping_address, package_name, items,
                           cod_amount, to_branch, instruction, delivery_type, customer_pan, bill_no, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13) RETURNING id, bill_no`,
      [
        body.customer_name, body.phone_number, body.phone2, body.shipping_address, packageName,
        JSON.stringify(savedItems), body.cod_amount, body.to_branch, body.instruction,
        body.delivery_type, body.customer_pan, billNo, who(req),
      ]
    );

    await audit(client, who(req), 'order.create', 'order', result.rows[0].id, body.customer_name,
      withStock({ customer: body.customer_name, package: packageName, cod: body.cod_amount }, stockDelta([], savedItems)));

    await client.query('COMMIT');
    res.json({ id: result.rows[0].id, bill_no: result.rows[0].bill_no, package_name: packageName });
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

    const current = await client.query('SELECT status, items, customer_name, package_name, cod_amount FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
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

    const prev = current.rows[0];
    await audit(client, who(req), 'order.update', 'order', req.params.id, body.customer_name,
      withStock({
        customer: body.customer_name,
        package: packageName,
        before: { customer: prev.customer_name, package: prev.package_name, cod: Number(prev.cod_amount) },
        after: { customer: body.customer_name, package: packageName, cod: body.cod_amount },
      }, stockDelta(oldItems, savedItems)));

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

app.patch('/api/orders/:id/status', verifyAuth, statusLimiter, async (req, res) => {
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
        await auditSafe(pool, who(req), 'order.status', 'order', orderId, order.customer_name, {
          from: order.status, to: 'packed', tracking_id: String(ncmOrderId), dispatched: true,
        });
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
    if (order.status !== status) {
      await auditSafe(pool, who(req), 'order.status', 'order', orderId, order.customer_name, { from: order.status, to: status });
    }
    res.json({ success: true, status });
  } catch (error) {
    console.error('Status update failed:', error.message);
    res.status(500).json({ error: 'Logistics processing failed' });
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

    await auditSafe(pool, who(req), 'order.comment', 'order', req.params.id, updatedRes.rows[0].customer_name, {
      text: text.slice(0, 200), ncm_pushed: ncmPushed,
    });
    res.json({ ...updatedRes.rows[0], ncm_pushed: ncmPushed });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

app.post('/api/orders/sync', verifyAuth, syncLimiter, async (req, res) => {
  await syncOrdersWithNCM();
  res.json({ success: true });
});

app.delete('/api/orders/:id', verifyAuth, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query('SELECT status, items, customer_name, package_name FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);

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
    if (orderRes.rows.length > 0) {
      const o = orderRes.rows[0];
      const restored = o.status !== 'delivered' ? stockDelta(Array.isArray(o.items) ? o.items : [], []) : [];
      await audit(client, who(req), 'order.delete', 'order', req.params.id, o.customer_name,
        withStock({ customer: o.customer_name, package: o.package_name, status: o.status }, restored));
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
/*  Team activity (audit log + contribution report)                           */
/* -------------------------------------------------------------------------- */
const AUDIT_LOCAL = `(created_at AT TIME ZONE '${BUSINESS_TZ}')`;

// Date range (business timezone). Defaults to the last 30 days.
function activityRange(query) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ }).format(new Date());
  const from = new Date(`${today}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 29);
  const pick = (v, fallback) => {
    const m = typeof v === 'string' ? v.match(/^(\d{4}-\d{2}-\d{2})/) : null;
    return m ? m[1] : fallback;
  };
  return {
    start: `${pick(query.startDate, from.toISOString().slice(0, 10))} 00:00:00`,
    end: `${pick(query.endDate, today)} 23:59:59`,
  };
}

app.get('/api/activity', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { start, end } = activityRange(req.query);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const params = [start, end];
    let where = `${AUDIT_LOCAL} >= $1::timestamp AND ${AUDIT_LOCAL} <= $2::timestamp`;
    if (req.query.user) {
      params.push(String(req.query.user));
      where += ` AND user_email = $${params.length}`;
    }
    if (req.query.type === 'stock') where += ` AND (action LIKE 'inventory.%' OR details->'stock' IS NOT NULL)`;
    else if (req.query.type === 'orders') where += ` AND entity = 'order'`;

    params.push(limit + 1, offset);
    const result = await pool.query(
      `SELECT id, created_at, user_email, action, entity, entity_id, entity_label, details
       FROM audit_log WHERE ${where}
       ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ rows: result.rows.slice(0, limit), hasMore: result.rows.length > limit });
  } catch (err) {
    console.error('Activity feed error:', err.message);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

app.get('/api/activity/summary', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { start, end } = activityRange(req.query);

    const [auditRes, ordersRes] = await Promise.all([
      pool.query(
        `SELECT user_email,
           COUNT(*) FILTER (WHERE action = 'order.create') AS orders_created,
           COUNT(*) FILTER (WHERE action = 'order.update') AS orders_edited,
           COUNT(*) FILTER (WHERE action = 'order.status') AS status_changes,
           COUNT(*) FILTER (WHERE action LIKE 'inventory.%') AS stock_changes,
           COUNT(*) FILTER (WHERE action = 'order.delete') AS orders_deleted,
           COUNT(*) FILTER (WHERE action = 'order.comment') AS comments,
           COUNT(*) AS total_actions,
           MAX(created_at) AS last_active
         FROM audit_log
         WHERE ${AUDIT_LOCAL} >= $1::timestamp AND ${AUDIT_LOCAL} <= $2::timestamp AND user_email <> 'system'
         GROUP BY user_email`,
        [start, end]
      ),
      pool.query(
        `SELECT created_by, COUNT(*) AS orders, COALESCE(SUM(cod_amount), 0) AS value,
                COALESCE(SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered
         FROM orders
         WHERE created_by IS NOT NULL AND ${LOCAL_CREATED} >= $1::timestamp AND ${LOCAL_CREATED} <= $2::timestamp
         GROUP BY created_by`,
        [start, end]
      ),
    ]);

    const n = (v) => parseInt(v, 10) || 0;
    const byUser = {};
    auditRes.rows.forEach((r) => {
      byUser[r.user_email] = {
        user: r.user_email,
        orders_created: n(r.orders_created), orders_edited: n(r.orders_edited), status_changes: n(r.status_changes),
        stock_changes: n(r.stock_changes), orders_deleted: n(r.orders_deleted), comments: n(r.comments),
        total_actions: n(r.total_actions), last_active: r.last_active,
        order_value: 0, orders_delivered: 0,
      };
    });
    ordersRes.rows.forEach((r) => {
      if (byUser[r.created_by]) {
        byUser[r.created_by].order_value = parseFloat(r.value) || 0;
        byUser[r.created_by].orders_delivered = n(r.delivered);
      }
    });

    const users = Object.values(byUser).sort((a, b) => b.orders_created - a.orders_created || b.total_actions - a.total_actions);
    res.json({ range: { start, end }, users });
  } catch (err) {
    console.error('Activity summary error:', err.message);
    res.status(500).json({ error: 'Failed to load activity summary' });
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