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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_chat_history_chat_id ON chat_history(chat_id);
  CREATE INDEX IF NOT EXISTS idx_chat_history_created ON chat_history(created_at);
  CREATE INDEX IF NOT EXISTS idx_stats_event ON stats(event_type);
  CREATE INDEX IF NOT EXISTS idx_stats_created ON stats(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
`);

log.info("💾 Database ready");

// ============================================================
// Chat History
// ============================================================
const insertChat = db.prepare(
  "INSERT INTO chat_history (chat_id, display_name, role, message) VALUES (?, ?, ?, ?)"
);

function saveChatMessage(chatId, displayName, role, message) {
  try {
    insertChat.run(chatId, displayName, role, message);
  } catch (err) {
    log.error("DB saveChatMessage:", err.message);
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
  "INSERT INTO orders (chat_id, display_name, product, quantity, total_price, customer_name, phone, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);

function saveOrder({ chatId, displayName, product, quantity, totalPrice, customerName, phone, address }) {
  try {
    const info = insertOrder.run(chatId, displayName, product, quantity, totalPrice, customerName, phone, address);
    log.info(`🛒 Order #${info.lastInsertRowid} saved: ${quantity}x ${product} = ${totalPrice}đ`);
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
    db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, orderId);
  } catch (err) {
    log.error("DB updateOrderStatus:", err.message);
  }
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
  const today = new Date().toISOString().split("T")[0];

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

  const daily = db
    .prepare(`
      SELECT date(created_at) as day, COUNT(*) as count 
      FROM stats WHERE event_type = 'message'
      GROUP BY date(created_at)
      ORDER BY day DESC LIMIT 7
    `)
    .all()
    .reverse();

  return {
    totalMessages, todayMessages, uniqueUsers, todayUsers,
    totalPhotos, totalErrors, totalOrders, newOrders, daily,
  };
}

function closeDb() {
  db.close();
  log.info("💾 Database closed");
}

module.exports = {
  saveChatMessage, getChatHistory,
  trackEvent, getStats,
  saveOrder, getOrders, updateOrderStatus,
  closeDb,
};
