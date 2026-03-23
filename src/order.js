const axios = require("axios");
const { GOOGLE_SHEET_URL } = require("./config");
const { PRODUCTS } = require("./constants");
const { saveOrder, trackEvent } = require("./database");
const log = require("./logger");

// ============================================================
// Pending Orders — chờ xác nhận trước khi lưu
// ============================================================
const pendingOrders = new Map(); // chatId -> { parsed, displayName, createdAt, timer }

const PENDING_TIMEOUT = 5 * 60 * 1000; // 5 phút

function createPendingOrder(chatId, displayName, parsed) {
  // Xóa pending cũ nếu có
  cancelPendingTimeout(chatId);

  const totalPrice = parsed.product.price * parsed.quantity;
  const priceStr = totalPrice.toLocaleString("vi-VN") + "đ";

  // Lưu vào pending
  const timer = setTimeout(() => {
    pendingOrders.delete(chatId);
    log.debug(`⏰ Pending order expired: ${chatId}`);
  }, PENDING_TIMEOUT);

  pendingOrders.set(chatId, { parsed, displayName, createdAt: Date.now(), timer });

  const unitPriceStr = parsed.product.price.toLocaleString("vi-VN") + "đ";

  // Trả về message preview (plain text, không buttons)
  return (
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `    🛒  XÁC NHẬN ĐƠN HÀNG\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Sản phẩm: ${parsed.product.name}\n` +
    `Số lượng: ${parsed.quantity} gói\n` +
    `Đơn giá: ${unitPriceStr}\n` +
    `Tổng tiền: ${priceStr}\n\n` +
    `Người nhận: ${parsed.customerName}\n` +
    `SĐT: ${parsed.phone}\n` +
    `Địa chỉ: ${parsed.address}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Trả lời: "OK" · "Hủy" · "Sửa"`
  );
}

function confirmPendingOrder(chatId) {
  const pending = pendingOrders.get(chatId);
  if (!pending) return null;

  const { parsed, displayName } = pending;
  cancelPendingTimeout(chatId);
  pendingOrders.delete(chatId);

  // Tạo đơn thật
  const result = createOrderFromParsed(chatId, displayName, parsed);
  return result;
}

function cancelPendingOrder(chatId) {
  const pending = pendingOrders.get(chatId);
  if (!pending) return null;

  cancelPendingTimeout(chatId);
  pendingOrders.delete(chatId);

  return "❌ Đã hủy đơn hàng. Nếu bạn muốn đặt lại, cứ nhắn mình nhé! 🙏";
}

function hasPendingOrder(chatId) {
  return pendingOrders.has(chatId);
}

function cancelPendingTimeout(chatId) {
  const pending = pendingOrders.get(chatId);
  if (pending && pending.timer) {
    clearTimeout(pending.timer);
  }
}

// ============================================================
// Parse đơn hàng từ text — KHÔNG CẦN GEMINI
// Trả về { product, quantity, customerName, phone, address } hoặc null
// ============================================================
function tryParseOrder(text) {
  const lower = text.toLowerCase();

  // 1) Detect sản phẩm
  let product = null;
  for (const p of PRODUCTS) {
    if (p.aliases.some((a) => lower.includes(a))) {
      product = p;
      break;
    }
  }
  if (!product) return null;

  // 2) Detect SĐT (bắt buộc)
  const phoneMatch = text.match(/(0\d{8,10})/);
  if (!phoneMatch) return null;
  const phone = phoneMatch[1];

  // 3) Detect số lượng (mặc định 1)
  const qtyMatch = lower.match(/(\d+)\s*(gói|hộp|bịch|cái)/);
  const quantity = qtyMatch ? parseInt(qtyMatch[1]) : 1;
  if (quantity < 1 || quantity > 99) return null;

  // 4) Tách tên + địa chỉ từ phần còn lại
  // Loại bỏ phần product alias + phone + quantity khỏi text
  let remaining = text;
  // Bỏ SĐT
  remaining = remaining.replace(phoneMatch[0], "");
  // Bỏ product aliases
  for (const a of product.aliases) {
    remaining = remaining.replace(new RegExp(a, "gi"), "");
  }
  // Bỏ "trà", "trà lài"
  remaining = remaining.replace(/trà\s*lài?/gi, "");
  // Bỏ quantity pattern
  if (qtyMatch) remaining = remaining.replace(qtyMatch[0], "");
  // Bỏ keywords thừa
  remaining = remaining.replace(/đặt\s*hàng|đặt\s*mua|mua|đặt|order/gi, "");

  // Split bằng dấu , hoặc |
  let parts = remaining.split(/[,|]/).map((s) => s.trim()).filter((s) => s.length >= 2);

  if (parts.length >= 2) {
    // Có ít nhất tên + địa chỉ
    const customerName = parts[0];
    const address = parts.slice(1).join(", ");
    return { product, quantity, customerName, phone, address };
  }

  // Thử detect bằng vị trí SĐT: text trước = tên, text sau = địa chỉ
  const phoneIdx = text.indexOf(phone);
  const beforePhone = text.substring(0, phoneIdx).replace(/[,|]/g, "").trim();
  const afterPhone = text.substring(phoneIdx + phone.length).replace(/[,|]/g, "").trim();

  // Xử lý: loại bỏ product/qty keywords từ beforePhone
  let cleanBefore = beforePhone;
  for (const a of product.aliases) {
    cleanBefore = cleanBefore.replace(new RegExp(a, "gi"), "");
  }
  cleanBefore = cleanBefore.replace(/trà\s*lài?/gi, "").replace(/\d+\s*(gói|hộp)/gi, "").replace(/đặt|mua|order/gi, "").trim();

  let cleanAfter = afterPhone;
  for (const a of product.aliases) {
    cleanAfter = cleanAfter.replace(new RegExp(a, "gi"), "");
  }
  cleanAfter = cleanAfter.replace(/trà\s*lài?/gi, "").replace(/\d+\s*(gói|hộp)/gi, "").replace(/đặt|mua|order/gi, "").trim();

  if (cleanBefore.length >= 2 && cleanAfter.length >= 2) {
    return { product, quantity, customerName: cleanBefore, phone, address: cleanAfter };
  }

  return null;
}

// ============================================================
// Tạo đơn hàng — gọi khi parse thành công
// ============================================================
function createOrderFromParsed(chatId, displayName, parsed) {
  const totalPrice = parsed.product.price * parsed.quantity;

  const orderId = saveOrder({
    chatId,
    displayName,
    product: parsed.product.name,
    quantity: parsed.quantity,
    totalPrice,
    customerName: parsed.customerName,
    phone: parsed.phone,
    address: parsed.address,
  });

  sendToGoogleSheet({
    orderId,
    displayName,
    product: parsed.product.name,
    quantity: parsed.quantity,
    totalPrice,
    customerName: parsed.customerName,
    phone: parsed.phone,
    address: parsed.address,
  });

  trackEvent("order_created", chatId);

  const priceStr = totalPrice.toLocaleString("vi-VN") + "đ";

  return (
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `  ✅  ĐƠN HÀNG #${orderId}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Sản phẩm: ${parsed.product.name}\n` +
    `Số lượng: ${parsed.quantity} gói\n` +
    `Tổng tiền: ${priceStr}\n\n` +
    `Người nhận: ${parsed.customerName}\n` +
    `SĐT: ${parsed.phone}\n` +
    `Địa chỉ: ${parsed.address}\n\n` +
    `Cảm ơn ${displayName}! Chủ shop sẽ liên hệ xác nhận sớm nhất! 🙏`
  );
}

// ============================================================
// Google Sheets
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
  }
}

module.exports = {
  tryParseOrder,
  createOrderFromParsed,
  createPendingOrder,
  confirmPendingOrder,
  cancelPendingOrder,
  hasPendingOrder,
  sendToGoogleSheet,
};

