const express = require("express");
const router = express.Router();

const { isPayOSEnabled, verifyWebhookData } = require("../payos");
const { updateOrderStatus, updateOrderPaymentMethod, trackEvent } = require("../database");
const { getOrderStatusNotification, sendToGoogleSheet } = require("../order");
const { sendMessage } = require("../zaloBot");
const { setupWebhook } = require("../webhookHandler");
const log = require("../logger");

/**
 * 💳 PayOS Webhook — Nhận thông báo thanh toán thành công
 */
router.post("/payos/webhook", async (req, res) => {
  try {
    if (!req.body || !isPayOSEnabled()) return res.json({ ok: true });
    
    // 1. Xác thực chữ ký webhook
    const webhookData = verifyWebhookData(req.body);
    if (!webhookData) {
      log.warn("⚠️ PayOS webhook: Invalid signature");
      return res.status(400).json({ error: "Invalid signature" });
    }

    const { orderCode, amount, description } = webhookData;
    log.info(`💰 PayOS Webhook: Order #${orderCode} - Amount: ${amount}đ - Desc: ${description}`);

    // 2. Trả kết quả 200 NGAY LẬP TỨC để ngắt retry từ PayOS
    res.json({ ok: true });

    // 3. Xử lý logic ẩn (A-sync)
    processPayOSWebhook(webhookData).catch(err => log.error("PayOS process error:", err.message));
  } catch (err) {
    log.error("❌ PayOS webhook error:", err.message);
    if (!res.headersSent) return res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * Logic xử lý PayOS sau khi đã trả 200
 */
async function processPayOSWebhook(webhookData) {
  const { orderCode } = webhookData;
  const { getOrderById } = require("../database");
  const order = getOrderById(orderCode);

  if (order) {
    // Chống nổ trùng đơn
    if (order.status === "paid" || order.status === "delivered") return;

    updateOrderStatus(orderCode, "paid");
    updateOrderPaymentMethod(orderCode, "payos");
    trackEvent("payment_success", order.chat_id);
    
    if (order.chat_id) {
      const notification = getOrderStatusNotification(order, "paid");
      await sendMessage(order.chat_id, notification);
    }

    sendToGoogleSheet({ 
      action: "update_payment_status", 
      orderId: orderCode, 
      status: "paid", 
      paymentMethod: "PayOS" 
    }).catch(() => {});
  } else {
    log.warn(`⚠️ PayOS: Order #${orderCode} not found in database.`);
  }
}

/**
 * 📲 Zalo Webhook — Xử lý tin nhắn và sự kiện từ Zalo OA
 * (Sử dụng module setupWebhook cũ đã được tối ưu)
 */
// Chúng ta sẽ "đóng gói" logic lại vào Router này để index.js không cần biết Zalo hoạt động thế nào
router.post("/webhook", (req, res) => {
  // Trả kết quả ngay để Zalo không báo lỗi (tuân thủ tài liệu Zalo)
  res.json({ ok: true });
  
  // Xử lý logic ẩn phía sau (A-sync)
  const body = req.body;
  if (body) {
    // Gọi trực tiếp vào logic xử lý webhook cũ
    const { handleUpdate } = require("../webhookHandler"); 
    // Giả lập instance giả để tận dụng logic có sẵn hoặc refactor webhookHandler sau
    // Hiện tại chuyển tiếp body cho logic xử lý
    handleUpdate(body, req).catch(err => log.error("Zalo webhook processing error:", err.message));
  }
});

/**
 * 💳 Payment Success — Trang đích sau khi thanh toán thành công
 */
router.get("/payment/success", (req, res) => {
  res.send("<html><body style='text-align:center;font-family:sans-serif;padding:50px'><h1>✅ Thanh toán thành công!</h1><p>Cảm ơn bạn! Quay lại Zalo để xem xác nhận đơn hàng nhé 🍵</p></body></html>");
});

/**
 * 💳 Payment Cancel — Trang đích khi khách hủy thanh toán
 */
router.get("/payment/cancel", (req, res) => {
  res.send("<html><body style='text-align:center;font-family:sans-serif;padding:50px'><h1>❌ Thanh toán đã hủy</h1><p>Bạn có thể nhắn lại Bot trên Zalo để đặt hàng lại nhé! 🍵</p></body></html>");
});

module.exports = router;
