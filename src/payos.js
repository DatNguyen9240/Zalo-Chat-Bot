const { PayOS } = require("@payos/node");
const { PAYOS_CLIENT_ID, PAYOS_API_KEY, PAYOS_CHECKSUM_KEY, WEBHOOK_URL } = require("./config");
const log = require("./logger");

let payosInstance = null;

function getPayOS() {
  if (!payosInstance && PAYOS_CLIENT_ID && PAYOS_API_KEY && PAYOS_CHECKSUM_KEY) {
    payosInstance = new PayOS({
      clientId: PAYOS_CLIENT_ID,
      apiKey: PAYOS_API_KEY,
      checksumKey: PAYOS_CHECKSUM_KEY
    });
    log.info("✅ PayOS SDK initialized");
  }
  return payosInstance;
}

/**
 * Tạo link thanh toán PayOS
 * @param {Object} order - { orderId, amount, description, buyerName, buyerPhone }
 * @returns {Object|null} - { checkoutUrl, qrCode, orderCode } hoặc null nếu lỗi
 */
async function createPaymentLink(order) {
  const payos = getPayOS();
  if (!payos) {
    log.warn("⚠️ PayOS chưa được cấu hình (thiếu Client ID / API Key / Checksum Key)");
    return null;
  }

  try {
    const orderCode = Number(order.orderId) || Date.now();
    let baseUrl = "http://localhost:3000";
    if (WEBHOOK_URL) {
      try {
        const urlObj = new URL(WEBHOOK_URL);
        baseUrl = `${urlObj.protocol}//${urlObj.host}`;
      } catch (e) {
        baseUrl = WEBHOOK_URL.split("/webhook")[0];
      }
    }

    const paymentData = {
      orderCode,
      amount: Math.round(order.amount),
      description: `DH${orderCode} ${order.description || "Tra Lai Shop"}`.substring(0, 25),
      cancelUrl: `${baseUrl}/payment/cancel`,
      returnUrl: `${baseUrl}/payment/success`,
      buyerName: order.buyerName || "",
      buyerPhone: order.buyerPhone || "",
    };

    const result = await payos.createPaymentLink(paymentData);

    log.info(`💳 PayOS link created: Order #${orderCode} — ${result.checkoutUrl}`);

    return {
      checkoutUrl: result.checkoutUrl,
      qrCode: result.qrCode,
      orderCode,
    };
  } catch (err) {
    log.error("❌ PayOS createPaymentLink error:", err);
    return null;
  }
}

/**
 * Xác minh dữ liệu webhook từ PayOS
 * @param {Object} body - Request body từ PayOS webhook
 * @returns {Object|null} - Dữ liệu đã xác minh hoặc null nếu không hợp lệ
 */
function verifyWebhookData(body) {
  const payos = getPayOS();
  if (!payos) return null;

  try {
    return payos.verifyPaymentWebhookData(body);
  } catch (err) {
    log.error("❌ PayOS webhook verification failed:", err);
    return null;
  }
}

/**
 * Kiểm tra PayOS đã được cấu hình hay chưa
 */
function isPayOSEnabled() {
  return !!(PAYOS_CLIENT_ID && PAYOS_API_KEY && PAYOS_CHECKSUM_KEY);
}

module.exports = { createPaymentLink, verifyWebhookData, isPayOSEnabled, getPayOS };
