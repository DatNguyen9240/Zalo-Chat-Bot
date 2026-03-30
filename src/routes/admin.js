const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

const { requireAdmin } = require("../middleware/auth");
const { getStats, getOrders, getOrderById, updateOrderStatus } = require("../database");
const { getOrderStatusNotification, sendToGoogleSheet } = require("../order");
const { sendMessage } = require("../zaloBot");
const { fetchConfig } = require("../configManager");
const log = require("../logger");

const dataDir = path.join(__dirname, "../../data");

/**
 * Validate filename — chặn path traversal
 */
function isValidFilename(filename) {
  if (!filename || !filename.endsWith(".txt")) return false;
  // Chặn path traversal: không cho ../ hoặc ký tự đặc biệt
  if (/[\/\\:*?"<>|]/.test(filename)) return false;
  if (filename.includes("..")) return false;
  return true;
}

// 📌 Bảo vệ toàn bộ các route admin bằng middleware requireAdmin
router.use(requireAdmin);

/**
 * GET /stats — Thống kê doanh số & tin nhắn
 */
router.get("/stats", (req, res) => {
  try {
    const stats = getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/refresh — Tải lại cấu hình từ Sheet ngay lập tức
 */
router.post("/admin/refresh", async (req, res) => {
  try {
    await fetchConfig();
    log.info("🔄 Cấu hình đã được Admin làm mới thủ công.");
    res.json({ ok: true, message: "Cấu hình đã được cập nhật từ Google Sheet." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/knowledge — Danh sách file kiến thức
 */
router.get("/admin/knowledge", (req, res) => {
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

/**
 * POST /admin/knowledge — Thêm/Sửa kiến thức
 */
router.post("/admin/knowledge", (req, res) => {
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
    res.json({ ok: true, message: `Đã lưu ${filename}. Knowledge sẽ được tải lại tự động khi có session mới.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /admin/knowledge/:filename — Xóa kiến thức
 */
router.delete("/admin/knowledge/:filename", (req, res) => {
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
    res.json({ ok: true, message: `Đã xóa ${filename}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/orders — Danh sách đơn hàng
 */
router.get("/admin/orders", (req, res) => {
  const status = req.query.status || null;
  res.json({ orders: getOrders(status) });
});

/**
 * PATCH /admin/orders/:id — Cập nhật trạng thái đơn + thông báo khách
 */
router.patch("/admin/orders/:id", async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "status là bắt buộc" });
  
  // Whitelist status hợp lệ — chặn giá trị tùy ý
  const VALID_STATUSES = ["new", "pending", "pending_payment", "cod", "paid", "confirmed", "shipping", "delivered", "cancelled"];
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status không hợp lệ. Chấp nhận: ${VALID_STATUSES.join(", ")}` });
  }
  
  const orderId = parseInt(req.params.id);
  if (isNaN(orderId)) return res.status(400).json({ error: "ID đơn hàng không hợp lệ" });
  
  // Lấy thông tin đơn trước khi update
  const order = getOrderById(orderId);
  if (!order) return res.status(404).json({ error: "Không tìm thấy đơn hàng" });
  
  updateOrderStatus(orderId, status);
  
  // Gửi thông báo cho khách qua Zalo
  if (order && order.chat_id) {
    try {
      const notification = getOrderStatusNotification(order, status);
      await sendMessage(order.chat_id, notification);
      log.info(`📢 Notified customer ${order.chat_id} about order #${orderId} → ${status}`);
    } catch (err) {
      log.error(`⚠️ Failed to notify customer: ${err.message}`);
    }
  }
  
  // Đồng bộ lên Google Sheet
  sendToGoogleSheet({ action: "update_status", orderId, status }).catch(() => {});
  
  res.json({ ok: true, message: `Đơn #${orderId} → ${status}` });
});

module.exports = router;
