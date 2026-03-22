const fs = require("fs");
const express = require("express");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const { PORT, BOT_MODE, GEMINI_MODEL, ADMIN_SECRET } = require("./src/config");
const { getSessionCount, cleanup } = require("./src/gemini");
const { registerWebhook, deleteWebhook, getWebhookInfo, getMe } = require("./src/zaloBot");
const { setupWebhook } = require("./src/webhookHandler");
const { startPolling, stopPolling } = require("./src/polling");
const { getStats, closeDb } = require("./src/database");
const { getQueueInfo } = require("./src/queue");
const log = require("./src/logger");

// ============================================================
// Express App
// ============================================================
const app = express();
app.use(helmet());
app.use(cors({ origin: false }));
app.use(express.json({ limit: "1mb" })); // Giới hạn body size
app.use("/public", express.static(path.join(__dirname, "public")));

// Webhook endpoint
setupWebhook(app);

// Health check (public — không lộ thông tin nhạy cảm)
app.get("/", (req, res) => {
  res.json({
    status: "running",
    bot: "Zalo Bot 🤖",
    mode: BOT_MODE,
    uptime: Math.floor(process.uptime()) + "s",
  });
});

// ============================================================
// Admin Auth Middleware — BẢO VỆ /stats và /admin/*
// ============================================================
function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ error: "ADMIN_SECRET chưa được cấu hình trong .env" });
  }
  const auth = req.headers["authorization"];
  if (!auth || auth !== `Bearer ${ADMIN_SECRET}`) {
    log.warn(`🔒 Unauthorized admin access from ${req.ip}`);
    return res.status(401).json({ error: "Unauthorized — cần header: Authorization: Bearer <ADMIN_SECRET>" });
  }
  next();
}

// ============================================================
// Stats API (protected)
// ============================================================
app.get("/stats", requireAdmin, (req, res) => {
  const stats = getStats();
  stats.sessions = getSessionCount();
  stats.queue = getQueueInfo();
  stats.uptime = Math.floor(process.uptime()) + "s";
  res.json(stats);
});

// ============================================================
// Admin API — Quản lý knowledge (protected)
// ============================================================
const dataDir = path.join(__dirname, "data");

// Validate filename — chặn path traversal
function isValidFilename(filename) {
  if (!filename || !filename.endsWith(".txt")) return false;
  // Chặn path traversal: không cho ../ hoặc ký tự đặc biệt
  if (/[\/\\:*?"<>|]/.test(filename)) return false;
  if (filename.includes("..")) return false;
  return true;
}

// GET /admin/knowledge
app.get("/admin/knowledge", requireAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".txt"));
    const result = files.map((f) => ({
      filename: f,
      size: fs.statSync(path.join(dataDir, f)).size,
      content: fs.readFileSync(path.join(dataDir, f), "utf-8"),
    }));
    res.json({ files: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/knowledge
app.post("/admin/knowledge", requireAdmin, (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) {
    return res.status(400).json({ error: "filename và content là bắt buộc" });
  }
  if (!isValidFilename(filename)) {
    return res.status(400).json({ error: "filename không hợp lệ (chỉ cho phép .txt, không có ký tự đặc biệt)" });
  }
  try {
    fs.writeFileSync(path.join(dataDir, filename), content, "utf-8");
    log.info(`📝 Knowledge updated: ${filename}`);
    res.json({ ok: true, message: `Đã lưu ${filename}. Restart bot để áp dụng.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/knowledge/:filename
app.delete("/admin/knowledge/:filename", requireAdmin, (req, res) => {
  const { filename } = req.params;
  if (!isValidFilename(filename)) {
    return res.status(400).json({ error: "filename không hợp lệ" });
  }
  const filePath = path.join(dataDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File không tồn tại" });
  }
  try {
    fs.unlinkSync(filePath);
    log.info(`🗑️ Knowledge deleted: ${filename}`);
    res.json({ ok: true, message: `Đã xóa ${filename}. Restart bot để áp dụng.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Start Server
// ============================================================
const server = app.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════════╗
║       🤖 Zalo Bot is running!               ║
║                                              ║
║  Server:    http://localhost:${String(PORT).padEnd(16)}║
║  Mode:      ${BOT_MODE.padEnd(33)}║
║  AI:        ${GEMINI_MODEL.padEnd(33)}║
║  Platform:  bot.zapps.me                     ║
║  Admin:     ${ADMIN_SECRET ? "🔒 Protected" : "⚠️  UNPROTECTED (set ADMIN_SECRET!)"}${ADMIN_SECRET ? "                     " : "  "}║
╚══════════════════════════════════════════════╝
  `);

  if (!ADMIN_SECRET) {
    log.warn("⚠️  ADMIN_SECRET chưa được đặt — /stats và /admin/* sẽ bị khóa!");
  }

  await getMe();

  if (BOT_MODE === "webhook") {
    await getWebhookInfo();
  }

  if (BOT_MODE === "polling") {
    await deleteWebhook();
    startPolling();
  }
});

// ============================================================
// Graceful Shutdown
// ============================================================
function gracefulShutdown(signal) {
  log.info(`${signal} received — shutting down...`);
  if (BOT_MODE === "polling") stopPolling();
  cleanup();
  closeDb();
  server.close(() => {
    log.info("Server closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

module.exports = { app, registerWebhook };
