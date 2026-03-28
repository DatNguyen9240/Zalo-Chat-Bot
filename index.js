const fs = require("fs");
const express = require("express");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const { PORT, BOT_MODE, GEMINI_MODEL, ADMIN_SECRET, WEBHOOK_SECRET, WEBHOOK_URL, CONFIG_REFRESH_MINUTES } = require("./src/config");
const { getSessionCount, cleanup } = require("./src/gemini");
const { registerWebhook, deleteWebhook, getWebhookInfo, getMe, sendMessage } = require("./src/zaloBot");
const { setupWebhook } = require("./src/webhookHandler");
const { startPolling, stopPolling } = require("./src/polling");
const { getStats, getOrders, updateOrderStatus, closeDb } = require("./src/database");
const { getQueueInfo } = require("./src/queue");
const { fetchConfig } = require("./src/configManager");
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
    status: "online 🚀",
    bot: "Nhất Lài Shop - Zalo AI Bot 🤖",
    mode: BOT_MODE,
    uptime: Math.floor(process.uptime()) + "s",
    message: "Hệ thống đang hoạt động ổn định. Chúc bạn một ngày tốt lành! ✨",
  });
});

// ============================================================
// Admin Auth Middleware — BẢO VỆ /stats và /admin/*
// ============================================================
function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET || ADMIN_SECRET.length < 8) {
    log.error("❌ ADMIN_SECRET chưa được cấu hình hoặc quá ngắn (tối thiểu 8 ký tự)");
    return res.status(503).json({ error: "Lỗi bảo mật server: ADMIN_SECRET không hợp lệ." });
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

// POST /admin/refresh — Tải lại cấu hình từ Sheet ngay lập tức
app.post("/admin/refresh", requireAdmin, async (req, res) => {
  try {
    await fetchConfig();
    log.info("🔄 Cấu hình đã được Admin làm mới thủ công.");
    res.json({ ok: true, message: "Cấu hình đã được cập nhật từ Google Sheet." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
// Admin API — Quản lý đơn hàng (protected)
// ============================================================

// GET /admin/orders — Danh sách đơn hàng
app.get("/admin/orders", requireAdmin, (req, res) => {
  const status = req.query.status || null;
  res.json({ orders: getOrders(status) });
});

// PATCH /admin/orders/:id — Cập nhật trạng thái đơn
app.patch("/admin/orders/:id", requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "status là bắt buộc" });
  updateOrderStatus(req.params.id, status);
  res.json({ ok: true, message: `Đơn #${req.params.id} → ${status}` });
});

// ============================================================
// PayOS Webhook — Nhận thông báo thanh toán
// ============================================================
const { verifyWebhookData, isPayOSEnabled } = require("./src/payos");
const { sendToGoogleSheet } = require("./src/order");

app.post("/payos/webhook", async (req, res) => {
  try {
    if (!isPayOSEnabled()) return res.json({ ok: true });

    const webhookData = verifyWebhookData(req.body);
    if (!webhookData) {
      log.warn("⚠️ PayOS webhook: Invalid signature");
      return res.status(400).json({ error: "Invalid signature" });
    }

    const { orderCode, code, desc } = webhookData;
    log.info(`💳 PayOS webhook: Order #${orderCode} — ${code} (${desc})`);

    if (code === "00") {
      // Thanh toán thành công
      updateOrderStatus(orderCode, "paid");

      // Đồng bộ trạng thái sang Google Sheet
      await sendToGoogleSheet({
        action: "update_payment_status",
        orderId: orderCode,
        status: "Đã thanh toán",
      });

      // Tìm chatId từ đơn hàng để gửi tin nhắn xác nhận
      const orders = getOrders();
      const order = orders.find(o => o.id === orderCode || o.id === String(orderCode));
      if (order && order.chat_id) {
        await sendMessage(order.chat_id,
          `✅ THANH TOÁN THÀNH CÔNG!\n\n` +
          `Đơn hàng #${orderCode} đã được thanh toán.\n` +
          `Shop sẽ chuẩn bị hàng và giao cho bạn sớm nhất! 🚚\n\n` +
          `Cảm ơn bạn đã tin tưởng Trà Lài Shop! 🍵💚`
        );
      }

      log.info(`✅ PayOS: Đơn #${orderCode} đã thanh toán thành công!`);
    }

    res.json({ ok: true });
  } catch (err) {
    log.error("❌ PayOS webhook error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Payment return pages
app.get("/payment/success", (req, res) => {
  res.send("<html><body style='text-align:center;font-family:sans-serif;padding:50px'><h1>✅ Thanh toán thành công!</h1><p>Cảm ơn bạn! Quay lại Zalo để xem xác nhận đơn hàng nhé 🍵</p></body></html>");
});

app.get("/payment/cancel", (req, res) => {
  res.send("<html><body style='text-align:center;font-family:sans-serif;padding:50px'><h1>❌ Thanh toán đã hủy</h1><p>Bạn có thể nhắn lại Bot trên Zalo để đặt hàng lại nhé! 🍵</p></body></html>");
});

const server = app.listen(PORT, async () => {
  // ── Khởi tạo cấu hình từ Google Sheet ──
  await fetchConfig(true);
  
  // Tự động tải lại cấu hình mỗi 10 phút
  setInterval(async () => {
    try {
      await fetchConfig();
    } catch (err) {
      log.error("❌ Lỗi khi tự động cập nhật cấu hình:", err.message);
    }
  }, CONFIG_REFRESH_MINUTES * 60 * 1000);

  console.log(`
╔══════════════════════════════════════════════╗
║       🤖 Zalo Bot is running!                ║
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
    if (WEBHOOK_URL) {
      // Auto-register webhook với URL từ env
      const webhookEndpoint = WEBHOOK_URL.endsWith("/webhook") ? WEBHOOK_URL : WEBHOOK_URL + "/webhook";
      await registerWebhook(webhookEndpoint, WEBHOOK_SECRET);
    }
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

process.on("unhandledRejection", (reason) => {
  log.error("💥 Unhandled Rejection at:", reason);
});

process.on("uncaughtException", (err) => {
  log.error("💥 Uncaught Exception:", err);
  // Optional: Graceful shutdown if needed, but for bot it's better to keep running if possible
});

module.exports = { app, registerWebhook };
