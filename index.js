const express = require("express");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");

// Configurations & Utils
const { PORT, BOT_MODE, GEMINI_MODEL, ADMIN_SECRET, WEBHOOK_SECRET, WEBHOOK_URL, CONFIG_REFRESH_MINUTES } = require("./src/config");
const { getSessionCount, cleanup } = require("./src/gemini");
const { registerWebhook, deleteWebhook, getWebhookInfo, getMe } = require("./src/zaloBot");
const { startPolling, stopPolling } = require("./src/polling");
const { fetchConfig } = require("./src/configManager");
const { getQueueInfo } = require("./src/queue");
const { closeDb } = require("./src/database");
const log = require("./src/logger");

// 🟢 Routers & Middleware
const adminRouter = require("./src/routes/admin");
const webhookRouter = require("./src/routes/webhooks");

// ============================================================
// Express App Setup
// ============================================================
const app = express();

app.use(helmet());
app.use(cors({ origin: false }));
app.use(express.json({ limit: "1mb" }));
app.use("/public", express.static(path.join(__dirname, "public")));

// 🏥 Health Check (Công khai)
app.get("/", (req, res) => {
  res.json({
    status: "online 🚀",
    bot: "Nhất Lài Shop - Zalo AI Bot 🤖",
    mode: BOT_MODE,
    uptime: Math.floor(process.uptime()) + "s",
    message: "Hệ thống đang hoạt động ổn định. Chúc bạn một ngày tốt lành! ✨",
  });
});

// 🛠️ Mount Routers (SOLID: Tách biệt trách nhiệm)
app.use("/", webhookRouter); // Xử lý /webhook, /payos/webhook, /payment/*
app.use("/", adminRouter);   // Xử lý /admin/* và /stats

// ============================================================
// Startup Sequence
// ============================================================
const server = app.listen(PORT, async () => {
  // 1. Khởi tạo cấu hình từ Google Sheet
  await fetchConfig(true);
  
  // 2. Tự động tải lại cấu hình định kỳ
  setInterval(async () => {
    try {
      await fetchConfig();
    } catch (err) {
      log.error("❌ Lỗi khi tự động cập nhật cấu hình:", err.message);
    }
  }, CONFIG_REFRESH_MINUTES * 60 * 1000);

  // 3. Hiển thị bảng điều khiển Console
  console.log(`
╔══════════════════════════════════════════════╗
║       🤖 Zalo Bot is modularized!            ║
║                                              ║
║  Server:    http://localhost:${String(PORT).padEnd(16)}║
║  Mode:      ${BOT_MODE.padEnd(33)}║
║  AI:        ${GEMINI_MODEL.padEnd(33)}║
║  Admin:     ${ADMIN_SECRET ? "🔒 Protected (SOLID)" : "⚠️  UNPROTECTED"}${ADMIN_SECRET ? "             " : "  "}║
╚══════════════════════════════════════════════╝
  `);

  await getMe();

  // 4. Cấu hình Webhook hoặc Polling
  if (BOT_MODE === "webhook") {
    if (WEBHOOK_URL) {
      const endpoint = WEBHOOK_URL.endsWith("/webhook") ? WEBHOOK_URL : WEBHOOK_URL + "/webhook";
      await registerWebhook(endpoint, WEBHOOK_SECRET);
    }
    await getWebhookInfo();
  } else if (BOT_MODE === "polling") {
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
    log.info("Server closed successfully");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => log.error("💥 Unhandled Rejection:", reason));
process.on("uncaughtException", (err) => log.error("💥 Uncaught Exception:", err));

module.exports = { app };
