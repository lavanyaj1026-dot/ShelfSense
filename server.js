"use strict";
// ShelfSense backend. No npm packages needed. Requires Node.js 22.13 or newer.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const DAY = 86400000;
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, "shelfsense.db"));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, sku TEXT, price REAL NOT NULL, cost REAL NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, reorder_level INTEGER NOT NULL DEFAULT 5, expiry_date TEXT);
CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, qty INTEGER NOT NULL, unit_price REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sales_user_time ON sales(user_id, created_at);
`);

/* ---------- helpers ---------- */
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const send = (res, status, data) => { res.writeHead(status, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(data)); };
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
const newSession = (uid) => { const t = crypto.randomBytes(32).toString("hex"); run("INSERT INTO sessions VALUES(?,?,?)", t, uid, Date.now()); return t; };
const num = (v, name, { min = 0, int = false } = {}) => {
  const n = Number(v);
  if (v === "" || v == null || !Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw fail(400, `Invalid ${name}`);
  return n;
};
const readBody = (req) => new Promise((ok, no) => {
  let s = "";
  req.on("data", (c) => { s += c; if (s.length > 1e6) { no(fail(413, "Request too large")); req.destroy(); } });
  req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(fail(400, "Invalid JSON")); } });
});
const blank = (v, dflt) => (v === "" || v == null ? dflt : v);
function parseProduct(b) {
  const name = String(b.name || "").trim();
  if (!name) throw fail(400, "Product name is required");
  const exp = b.expiry_date ? String(b.expiry_date) : null;
  if (exp && isNaN(Date.parse(exp))) throw fail(400, "Invalid expiry date");
  return [name, String(b.sku || "").trim() || null, num(b.price, "price"), num(blank(b.cost, 0), "cost"),
    num(blank(b.stock, 0), "stock", { int: true }), num(blank(b.reorder_level, 5), "reorder level", { int: true }), exp];
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, p, auth, fn) =>
  routes.push({ method, auth, fn, re: new RegExp("^" + p.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$") });

route("POST", "/api/register", false, ({ body }) => {
  const email = String(body.email || "").trim().toLowerCase();
  const pw = String(body.password || "");
  if (!/^\S+@\S+\.\S+$/.test(email)) throw fail(400, "Enter a valid email address");
  if (pw.length < 8) throw fail(400, "Password must be at least 8 characters");
  if (one("SELECT id FROM users WHERE email=?", email)) throw fail(409, "That email is already registered");
  const salt = crypto.randomBytes(16).toString("hex");
  const name = String(body.name || "").trim() || "Shop owner";
  const id = run("INSERT INTO users(email,name,salt,hash) VALUES(?,?,?,?)", email, name, salt, hashPw(pw, salt)).lastInsertRowid;
  return [201, { token: newSession(id), name }];
});

route("POST", "/api/login", false, ({ body }) => {
  const u = one("SELECT * FROM users WHERE email=?", String(body.email || "").trim().toLowerCase());
  const given = Buffer.from(hashPw(String(body.password || ""), u ? u.salt : "x"), "hex");
  if (!u || !crypto.timingSafeEqual(given, Buffer.from(u.hash, "hex"))) throw fail(401, "Wrong email or password");
  return { token: newSession(u.id), name: u.name };
});

route("GET", "/api/products", true, ({ user }) => all("SELECT * FROM products WHERE user_id=? ORDER BY name", user.id));

route("POST", "/api/products", true, ({ user, body }) => {
  const r = run("INSERT INTO products(user_id,name,sku,price,cost,stock,reorder_level,expiry_date) VALUES(?,?,?,?,?,?,?,?)", user.id, ...parseProduct(body));
  return [201, one("SELECT * FROM products WHERE id=?", r.lastInsertRowid)];
});

route("PUT", "/api/products/:id", true, ({ user, params, body }) => {
  const r = run("UPDATE products SET name=?,sku=?,price=?,cost=?,stock=?,reorder_level=?,expiry_date=? WHERE id=? AND user_id=?", ...parseProduct(body), params.id, user.id);
  if (!r.changes) throw fail(404, "Product not found");
  return one("SELECT * FROM products WHERE id=?", params.id);
});

route("DELETE", "/api/products/:id", true, ({ user, params }) => {
  if (!run("DELETE FROM products WHERE id=? AND user_id=?", params.id, user.id).changes) throw fail(404, "Product not found");
  return { ok: true };
});

route("POST", "/api/products/:id/restock", true, ({ user, params, body }) => {
  const qty = num(body.qty, "quantity", { int: true, min: 1 });
  if (!run("UPDATE products SET stock=stock+? WHERE id=? AND user_id=?", qty, params.id, user.id).changes) throw fail(404, "Product not found");
  return one("SELECT * FROM products WHERE id=?", params.id);
});

// Selling reduces stock and records the sale together, or does neither.
route("POST", "/api/sales", true, ({ user, body }) => {
  const pid = num(body.product_id, "product", { int: true, min: 1 });
  const qty = num(body.qty ?? 1, "quantity", { int: true, min: 1 });
  db.exec("BEGIN");
  try {
    const p = one("SELECT * FROM products WHERE id=? AND user_id=?", pid, user.id);
    if (!p) throw fail(404, "Product not found");
    if (!run("UPDATE products SET stock=stock-? WHERE id=? AND stock>=?", qty, pid, qty).changes) throw fail(409, `Only ${p.stock} in stock`);
    run("INSERT INTO sales(user_id,product_id,qty,unit_price,unit_cost,created_at) VALUES(?,?,?,?,?,?)", user.id, pid, qty, p.price, p.cost, Date.now());
    db.exec("COMMIT");
    return [201, { ok: true, stock: p.stock - qty, total: p.price * qty }];
  } catch (e) { db.exec("ROLLBACK"); throw e; }
});

route("GET", "/api/dashboard", true, ({ user }) => {
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const start = t0.getTime();
  const sum = (a, b) => one("SELECT COALESCE(SUM(qty*unit_price),0) AS revenue, COALESCE(SUM(qty*(unit_price-unit_cost)),0) AS profit FROM sales WHERE user_id=? AND created_at>=? AND created_at<?", user.id, a, b);
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const a = start - i * DAY;
    week.push({ day: new Date(a).toLocaleDateString("en-IN", { weekday: "short" }), revenue: sum(a, a + DAY).revenue });
  }
  const prods = all("SELECT * FROM products WHERE user_id=?", user.id);
  const soon = new Date(start + 7 * DAY).toISOString().slice(0, 10);
  const today = sum(start, start + DAY);
  return {
    stock_value: prods.reduce((s, p) => s + p.stock * (p.cost || p.price), 0),
    product_count: prods.length,
    sold_today: today.revenue,
    profit_today: today.profit,
    low_stock: prods.filter((p) => p.stock <= p.reorder_level),
    expiring: prods.filter((p) => p.expiry_date && p.expiry_date <= soon).sort((a, b) => a.expiry_date.localeCompare(b.expiry_date)),
    week,
  };
});

/* ---------- server ---------- */
const pages = { "/": "index.html", "/app": "app.html" };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && pages[url.pathname]) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(__dirname, "public", pages[url.pathname])));
    }
    if (!url.pathname.startsWith("/api/")) throw fail(404, "Not found");
    let params, r;
    for (const x of routes) { const m = x.method === req.method && x.re.exec(url.pathname); if (m) { r = x; params = m.groups || {}; break; } }
    if (!r) throw fail(404, "Not found");
    let user = null;
    if (r.auth) {
      const tok = (req.headers.authorization || "").replace(/^Bearer /, "");
      user = one("SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.created_at>?", tok, Date.now() - 30 * DAY);
      if (!user) throw fail(401, "Please log in");
    }
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readBody(req);
    const out = await r.fn({ user, params, body });
    Array.isArray(out) && typeof out[0] === "number" ? send(res, out[0], out[1]) : send(res, 200, out);
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : "Server error" });
  }
}).listen(PORT, () => console.log(`ShelfSense is running: open http://localhost:${PORT}`));

/* ---------- demo data on first run ---------- */
if (!one("SELECT id FROM users LIMIT 1")) {
  const salt = crypto.randomBytes(16).toString("hex");
  const uid = run("INSERT INTO users(email,name,salt,hash) VALUES(?,?,?,?)", "demo@shelfsense.in", "Demo Store", salt, hashPw("demo1234", salt)).lastInsertRowid;
  const d = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
  [["Basmati rice 5 kg", 520, 430, 24, 10, d(210)], ["Toned milk 1 L", 56, 48, 7, 12, d(2)], ["Sunflower oil 1 L", 148, 124, 15, 8, d(180)],
   ["Wheat bread", 45, 34, 5, 6, d(3)], ["Tea powder 250 g", 135, 108, 31, 10, d(300)]].forEach(([n, pr, c, s, rl, e]) => {
    const pid = run("INSERT INTO products(user_id,name,price,cost,stock,reorder_level,expiry_date) VALUES(?,?,?,?,?,?,?)", uid, n, pr, c, s, rl, e).lastInsertRowid;
    for (let i = 6; i >= 0; i--) run("INSERT INTO sales(user_id,product_id,qty,unit_price,unit_cost,created_at) VALUES(?,?,?,?,?,?)", uid, pid, 4 + ((pid + i) % 6), pr, c, Date.now() - i * DAY - 3600000);
  });
  console.log("Demo login: demo@shelfsense.in / demo1234");
}
