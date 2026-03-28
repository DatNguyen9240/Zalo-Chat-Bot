const axios = require("axios");
const { GOOGLE_SHEET_URL } = require("./config");
const { getProducts, calculateShipping, getSettings } = require("./constants");
const { saveOrder, updateOrderStatus, trackEvent } = require("./database");
const log = require("./logger");

// ============================================================
// Pending Orders — chờ xác nhận trước khi lưu
// ============================================================
const pendingOrders = new Map(); // chatId -> { parsed, displayName, createdAt, timer }

const PENDING_TIMEOUT = 5 * 60 * 1000; // 5 phút

function createPendingOrder(chatId, displayName, parsed) {
  cancelPendingTimeout(chatId);

  const unitPrice = Math.round(parsed.product.price || 0);
  const qty = Math.round(parsed.quantity || 1);
  const totalProductPrice = unitPrice * qty;
  const shipping = calculateShipping(parsed.address, totalProductPrice);
  const totalPrice = totalProductPrice + Math.round(shipping.fee || 0);
  
  if (isNaN(totalPrice)) {
    log.error(`❌ NaN Price error for ${chatId}: p=${parsed.product.price}, q=${parsed.quantity}, s=${shipping.fee}`);
    return "❌ Xin lỗi, hệ thống tính toán gặp sự cố nhỏ. Vui lòng liên hệ chủ shop để đặt hàng nhé! 🙏";
  }
  const priceStr = totalPrice.toLocaleString("vi-VN") + "đ";

  const timer = setTimeout(() => {
    pendingOrders.delete(chatId);
    log.debug(`⏰ Pending order expired: ${chatId}`);
  }, PENDING_TIMEOUT);

  pendingOrders.set(chatId, { parsed, displayName, createdAt: Date.now(), timer });

  const unitPriceStr = parsed.product.price.toLocaleString("vi-VN") + "đ";
  const productTotalStr = totalProductPrice.toLocaleString("vi-VN") + "đ";

  let shipLine;
  if (shipping.fee === 0 && shipping.originalFee === 0) {
    shipLine = `Phí ship: MIỄN PHÍ (${shipping.zone})`;
  } else if (shipping.freeShip) {
    shipLine = `Phí ship: MIỄN PHÍ 🎁 (${shipping.zone} ~${shipping.originalFee.toLocaleString("vi-VN")}đ)`;
  } else {
    shipLine = `Phí ship: ${shipping.fee.toLocaleString("vi-VN")}đ (${shipping.zone}, ${shipping.time})`;
  }

  return (
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `    🛒  XÁC NHẬN ĐƠN HÀNG\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Sản phẩm: ${parsed.product.name}\n` +
    `Số lượng: ${parsed.quantity} gói\n` +
    `Đơn giá: ${unitPriceStr}\n` +
    `Tiền hàng: ${productTotalStr}\n` +
    `${shipLine}\n` +
    `Tổng thanh toán: ${priceStr}\n\n` +
    `Người nhận: ${parsed.customerName}\n` +
    `SĐT: ${parsed.phone}\n` +
    `Địa chỉ: ${parsed.address}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Trả lời: "OK" · "Hủy" · "Sửa"`
  );
}

async function confirmPendingOrder(chatId) {
  const pending = pendingOrders.get(chatId);
  if (!pending) return null;

  if (pending.confirming) {
    log.warn(`⚠️ Double-confirm blocked for ${chatId}`);
    return null;
  }
  pending.confirming = true;

  const { parsed, displayName } = pending;
  cancelPendingTimeout(chatId);
  pendingOrders.delete(chatId);

  return await createOrderFromParsed(chatId, displayName, parsed);
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
  if (pending && pending.timer) clearTimeout(pending.timer);
}

// ============================================================
// Parse đơn hàng từ text
// ============================================================
function tryParseOrder(text) {
  const lower = text.toLowerCase();
  const products = getProducts();

  let product = null;
  for (const p of products) {
    if (p.aliases.some((a) => lower.includes(a))) {
      product = p;
      break;
    }
  }
  if (!product) return null;

  // 2) Detect SĐT (+84, 84 hoặc 0...)
  const phoneMatch = text.match(/((?:\+84|84|0)\d{9,10})/);
  if (!phoneMatch) return null;
  const phone = phoneMatch[1];

  let qtyMatch = lower.match(/(\d+)\s*(gói|hộp|bịch|cái|lon|hũ)/);
  let quantity = 1;

  if (qtyMatch) {
    quantity = parseInt(qtyMatch[1]);
  } else {
    const phoneIdx = lower.indexOf(phone);
    const textBeforePhone = phoneIdx !== -1 ? lower.substring(0, phoneIdx) : lower;
    const independentQtyMatch = textBeforePhone.match(/\b(\d{1,2})\b/g);
    
    if (independentQtyMatch) {
      for (let i = independentQtyMatch.length - 1; i >= 0; i--) {
        const val = parseInt(independentQtyMatch[i]);
        if (val >= 1 && val <= 50) {
          quantity = val;
          break;
        }
      }
    }
  }

  if (quantity < 1 || quantity > 99) quantity = 1;

  let remaining = text;
  remaining = remaining.replace(phoneMatch[0], "");
  for (const a of product.aliases) {
    // Thoát ký tự đặc biệt trong alias trước khi tạo RegExp
    const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    remaining = remaining.replace(new RegExp(escaped, "gi"), "");
  }
  remaining = remaining.replace(/trà\s*lài?/gi, "").replace(/đặt|mua|order/gi, "");
  if (qtyMatch) remaining = remaining.replace(qtyMatch[0], "");

  let parts = remaining.split(/[,|]/).map((s) => s.trim()).filter((s) => s.length >= 2);

  if (parts.length >= 2) {
    return { product, quantity, customerName: parts[0], phone, address: parts.slice(1).join(", ") };
  }

  const phoneIdx = text.indexOf(phone);
  const beforePhone = text.substring(0, phoneIdx).replace(/[,|]/g, "").trim();
  const afterPhone = text.substring(phoneIdx + phone.length).replace(/[,|]/g, "").trim();

  let cleanBefore = beforePhone;
  for (const a of product.aliases) {
    const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleanBefore = cleanBefore.replace(new RegExp(escaped, "gi"), "");
  }
  cleanBefore = cleanBefore.replace(/trà\s*lài?/gi, "").replace(/\d+\s*(gói|hộp)/gi, "").replace(/đặt|mua|order/gi, "").trim();

  let cleanAfter = afterPhone;
  for (const a of product.aliases) {
    const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleanAfter = cleanAfter.replace(new RegExp(escaped, "gi"), "");
  }
  cleanAfter = cleanAfter.replace(/trà\s*lài?/gi, "").replace(/\d+\s*(gói|hộp)/gi, "").replace(/đặt|mua|order/gi, "").trim();

  if (cleanBefore.length >= 2 && cleanAfter.length >= 2) {
    return { product, quantity, customerName: cleanBefore, phone, address: cleanAfter };
  }

  return null;
}

// ============================================================
// Tạo đơn hàng chính thức
// ============================================================
async function createOrderFromParsed(chatId, displayName, parsed) {
  const totalProductPrice = parsed.product.price * parsed.quantity;
  const shipping = calculateShipping(parsed.address, totalProductPrice);
  const totalPrice = totalProductPrice + shipping.fee;
  const settings = getSettings();

  // 1) Check tồn kho
  const checkResult = await sendToGoogleSheet({
    action: "check_stock",
    product: parsed.product.name,
    quantity: parsed.quantity
  });

  if (checkResult && !checkResult.ok) {
    const ownerPhone = checkResult.ownerPhone || settings.OWNER_PHONE || "0975324568";
    if (checkResult.error === "het_hang") {
      const available = checkResult.available ?? 0;
      return `❌ Hết hàng!\n\nXin lỗi, ${parsed.product.name} hiện chỉ còn ${available} gói.\nBạn muốn đặt ${available} gói không? Nhắn lại mình nhé!\n\n💬 Liên hệ chủ shop: Zalo ${ownerPhone} 🙏`;
    }
    if (checkResult.error === "so_luong_khong_hop_le") {
      const maxQty = checkResult.maxQty || settings.MAX_ORDER_QTY || 10;
      return `⚠️ Số lượng vượt giới hạn!\nMỗi đơn tối đa ${maxQty} gói.\nNếu bạn cần mua số lượng nhiều hơn, vui lòng liên hệ chủ shop: Zalo ${ownerPhone} 🙏`;
    }
  }

  // 2) Lưu SQLite (Hàng đợi nội bộ)
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

  // 3) Ghi đơn vào Sheet (Đồng bộ)
  const confirmResult = await sendToGoogleSheet({
    action: "confirm",
    orderId,
    displayName,
    product: parsed.product.name,
    quantity: parsed.quantity,
    totalPrice,
    customerName: parsed.customerName,
    phone: parsed.phone,
    address: parsed.address,
    shippingZone: shipping.zone,
    shippingFee: shipping.fee,
  });

  if (!confirmResult || !confirmResult.ok) {
    log.error(`⚠️ Đồng bộ đơn hàng #${orderId} thất bại!`);
    updateOrderStatus(orderId, "error_sheet");
    return `⚠️ CẢNH BÁO: Đã có lỗi kỹ thuật khi đồng bộ đơn hàng #${orderId} lên Google Sheet.\n\nTuy nhiên, Bot đã ghi nhận thông tin thành công. Chủ shop sẽ kiểm tra và xác nhận sớm nhất qua SĐT ${parsed.phone} của bạn nhé! 🙏`;
  }

  trackEvent("order_created", chatId);

  const priceStr = totalPrice.toLocaleString("vi-VN") + "đ";
  const productTotalStr = totalProductPrice.toLocaleString("vi-VN") + "đ";
  let shipLine = shipping.fee === 0 ? `Phí ship: MIỄN PHÍ (${shipping.zone})` : `Phí ship: ${shipping.fee.toLocaleString("vi-VN")}đ (${shipping.zone})`;

  return (
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `  ✅  ĐƠN HÀNG #${orderId}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Sản phẩm: ${parsed.product.name}\n` +
    `Số lượng: ${parsed.quantity} gói\n` +
    `Tiền hàng: ${productTotalStr}\n` +
    `${shipLine}\n` +
    `Tổng thanh toán: ${priceStr}\n\n` +
    `Người nhận: ${parsed.customerName}\n` +
    `SĐT: ${parsed.phone}\n` +
    `Địa chỉ: ${parsed.address}\n\n` +
    `Cảm ơn ${displayName}! Chủ shop sẽ liên hệ xác nhận sớm nhất! 🙏`
  );
}

async function sendToGoogleSheet(order) {
  if (!GOOGLE_SHEET_URL) return null;
  try {
    const res = await axios.post(GOOGLE_SHEET_URL, order, { timeout: 10000 });
    return res.data;
  } catch (err) {
    log.error("Google Sheet error:", err.message);
    return null;
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
