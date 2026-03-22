const axios = require("axios");
const { GOOGLE_SHEET_URL } = require("./config");
const log = require("./logger");

// ============================================================
// Google Sheets — Gửi đơn hàng lên sheet
// ============================================================
async function sendToGoogleSheet(order) {
  if (!GOOGLE_SHEET_URL) {
    log.debug("Google Sheet URL chưa cấu hình — bỏ qua");
    return;
  }

  try {
    await axios.post(GOOGLE_SHEET_URL, order, { timeout: 10000 });
    log.info(`📊 Google Sheet updated: Order #${order.orderId}`);
  } catch (err) {
    log.error("Google Sheet error:", err.message);
    // Không throw — đơn đã lưu trong SQLite, sheet chỉ là backup
  }
}

module.exports = { sendToGoogleSheet };
