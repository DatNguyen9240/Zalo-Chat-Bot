const path = require("path");
const Database = require("better-sqlite3");
const log = require("./logger");

const dbPath = path.join(__dirname, "..", "data", "bot.db");
const db = new Database(dbPath);

// WAL mode cho performance
db.pragma("journal_mode = WAL");

// Tạo tables
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    chat_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    display_name TEXT,
    product TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total_price INTEGER NOT NULL,
    customer_name TEXT,
    phone TEXT,
    address TEXT,
    status TEXT DEFAULT 'new',
    payment_method TEXT DEFAULT 'cod',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_chat_history_chat_id ON chat_history(chat_id);
  CREATE INDEX IF NOT EXISTS idx_chat_history_created ON chat_history(created_at);
  CREATE INDEX IF NOT EXISTS idx_stats_event ON stats(event_type);
  CREATE INDEX IF NOT EXISTS idx_stats_created ON stats(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_chat_id ON orders(chat_id);
`);

// Safe migration: thêm cột payment_method nếu chưa có (cho DB cũ)
try {
  const tableInfo = db.prepare("PRAGMA table_info(orders)").all();
  const hasCol = tableInfo.some((col) => col.name === "payment_method");
  if (!hasCol) {
    db.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT DEFAULT 'cod'");
    log.info("📦 DB Migration: added payment_method column");
  }
} catch (err) {
  // Column already exists or other error
}

log.info("💾 Database ready");

// ============================================================
// Chat History
// ============================================================
function saveChatMessage(chatId, displayName, role, message) {
  try {
    const stmt = db.prepare("INSERT INTO chat_history (chat_id, display_name, role, message) VALUES (?, ?, ?, ?)");
    stmt.run(chatId, displayName, role, message);
  } catch (err) {
    log.error("❌ DB saveChatMessage failed:", err.message);
  }
}

function getChatHistory(chatId, limit = 20) {
  return db
    .prepare("SELECT * FROM chat_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(chatId, limit)
    .reverse();
}

// ============================================================
// Orders
// ============================================================
const insertOrder = db.prepare(
  "INSERT INTO orders (chat_id, display_name, product, quantity, total_price, customer_name, phone, address, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
);

function saveOrder({ chatId, displayName, product, quantity, totalPrice, customerName, phone, address, paymentMethod = "cod" }) {
  try {
    const info = insertOrder.run(chatId, displayName, product, quantity, totalPrice, customerName, phone, address, paymentMethod);
    log.info(`🛒 Order #${info.lastInsertRowid} saved: ${quantity}x ${product} = ${totalPrice}đ [${paymentMethod}]`);
    return info.lastInsertRowid;
  } catch (err) {
    log.error("DB saveOrder:", err.message);
    return null;
  }
}

function getOrders(status = null) {
  if (status) {
    return db.prepare("SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC").all(status);
  }
  return db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
}

function updateOrderStatus(orderId, status) {
  try {
    db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, Number(orderId));
  } catch (err) {
    log.error("DB updateOrderStatus:", err.message);
  }
}

function updateOrderPaymentMethod(orderId, paymentMethod) {
  try {
    db.prepare("UPDATE orders SET payment_method = ? WHERE id = ?").run(paymentMethod, Number(orderId));
  } catch (err) {
    log.error("DB updateOrderPaymentMethod:", err.message);
  }
}

function getOrdersByChatId(chatId, limit = 5) {
  return db
    .prepare("SELECT * FROM orders WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(chatId, limit);
}

function getOrderById(orderId) {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(Number(orderId));
}

function cancelOrder(orderId) {
  const oId = Number(orderId);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(oId);
  if (!order) return { ok: false, error: "not_found" };
  if (["cancelled", "delivered", "shipping"].includes(order.status)) {
    return { ok: false, error: "cannot_cancel", status: order.status };
  }
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(oId);
  return { ok: true, order };
}

// ============================================================
// Stats / Analytics
// ============================================================
const insertStat = db.prepare(
  "INSERT INTO stats (event_type, chat_id) VALUES (?, ?)"
);

function trackEvent(eventType, chatId = null) {
  try {
    insertStat.run(eventType, chatId);
  } catch (err) {
    log.error("DB trackEvent:", err.message);
  }
}

function getStats() {
  // Lấy ngày hiện tại theo múi giờ Việt Nam (ISO YYYY-MM-DD)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const vnTime = new Date(utc + (3600000 * 7));
  const today = vnTime.toISOString().split("T")[0];

  const totalMessages = db
    .prepare("SELECT COUNT(*) as count FROM stats WHERE event_type = 'message'")
    .get().count;

  const todayMessages = db
    .prepare("SELECT COUNT(*) as count FROM stats WHERE event_type = 'message' AND date(created_at) = ?")
    .get(today).count;

  const uniqueUsers = db
    .prepare("SELECT COUNT(DISTINCT chat_id) as count FROM stats WHERE event_type = 'message'")
    .get().count;

  const todayUsers = db
    .prepare("SELECT COUNT(DISTINCT chat_id) as count FROM stats WHERE event_type = 'message' AND date(created_at) = ?")
    .get(today).count;

  const totalPhotos = db
    .prepare("SELECT COUNT(*) as count FROM stats WHERE event_type = 'photo_sent'")
    .get().count;

  const totalErrors = db
    .prepare("SELECT COUNT(*) as count FROM stats WHERE event_type = 'error'")
    .get().count;

  const totalOrders = db
    .prepare("SELECT COUNT(*) as count FROM orders")
    .get().count;

  const newOrders = db
    .prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'new'")
    .get().count;

  const totalRevenue = db
    .prepare("SELECT SUM(total_price) as total FROM orders WHERE status != 'cancelled'")
    .get().total || 0;

  const todayRevenue = db
    .prepare("SELECT SUM(total_price) as total FROM orders WHERE status != 'cancelled' AND date(created_at) = ?")
    .get(today).total || 0;

  const daily = db
    .prepare(`
      SELECT date(created_at) as day, COUNT(*) as count, SUM(total_price) as total
      FROM orders WHERE status != 'cancelled'
      GROUP BY date(created_at)
      ORDER BY day DESC LIMIT 7
    `)
    .all()
    .reverse();

  return {
    totalMessages, todayMessages, uniqueUsers, todayUsers,
    totalPhotos, totalErrors, totalOrders, newOrders, totalRevenue, todayRevenue, daily,
  };
}

function closeDb() {
  db.close();
  log.info("💾 Database closed");
}

module.exports = {
  saveChatMessage, getChatHistory,
  trackEvent, getStats,
  saveOrder, getOrders, getOrdersByChatId, getOrderById, updateOrderStatus, updateOrderPaymentMethod, cancelOrder,
  closeDb,
};
