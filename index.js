const express = require("express");
const path = require("path");
const { PORT, BOT_MODE, GEMINI_MODEL } = require("./src/config");
const { getSessionCount, cleanup } = require("./src/gemini");
const { registerWebhook, deleteWebhook, getWebhookInfo, getMe } = require("./src/zaloBot");
const { setupWebhook } = require("./src/webhookHandler");
const { startPolling, stopPolling } = require("./src/polling");
const log = require("./src/logger");

// ============================================================
// Express App
// ============================================================
const app = express();
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

// Webhook endpoint (luôn mount để health check hoạt động)
setupWebhook(app);

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "running",
    bot: "Zalo Bot 🤖",
    mode: BOT_MODE,
    platform: "Zalo Bot Platform (bot.zapps.me)",
    model: GEMINI_MODEL,
    activeSessions: getSessionCount(),
    uptime: Math.floor(process.uptime()) + "s",
  });
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
╚══════════════════════════════════════════════╝
  `);

  // Verify bot token
  await getMe();

  // Webhook mode: hiện trạng thái webhook hiện tại
  if (BOT_MODE === "webhook") {
    await getWebhookInfo();
  }

  // Polling mode: xóa webhook cũ rồi bắt đầu long polling
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
  server.close(() => {
    log.info("Server closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

module.exports = { app, registerWebhook };
