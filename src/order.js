const axios = require("axios");
const { GOOGLE_SHEET_URL } = require("./config");
const { getProducts, calculateShipping, getSettings, getOrderReplies } = require("./constants");
const { saveOrder, updateOrderStatus, updateOrderPaymentMethod, trackEvent, getOrdersByChatId, cancelOrder: dbCancelOrder } = require("./database");
const { createPaymentLink, isPayOSEnabled } = require("./payos");
const log = require("./logger");

// ============================================================
// Bank BIN mapping — cho VietQR
// ============================================================
const BANK_BIN_MAP = {
  "mb": "970422", "mbbank": "970422",
  "vcb": "970436", "vietcombank": "970436",
  "tcb": "970407", "techcombank": "970407",
  "acb": "970416",
  "bidv": "970418",
  "vpbank": "970432", "vpb": "970432",
  "tpbank": "970423", "tpb": "970423",
  "sacombank": "970403", "stb": "970403",
  "vietinbank": "970415", "ctg": "970415",
  "agribank": "970405",
  "msb": "970426",
  "shb": "970443",
  "hdbank": "970437",
  "ocb": "970448",
  "vib": "970441",
  "eximbank": "970431",
  "lpb": "970449", "lienvietpostbank": "970449",
  "seabank": "970440",
  "namabank": "970428",
  "abbank": "970425",
  "bvbank": "970438",
  "pvcombank": "970412",
  "baovietbank": "970438",
  "cake": "546034", "cakebank": "546034",
};

function getBankBin(bankName) {
  if (!bankName) return null;
  const lower = bankName.toLowerCase().replace(/\s+/g, "").replace(/bank$/i, "");
  // Thử match trực tiếp
  if (BANK_BIN_MAP[lower]) return BANK_BIN_MAP[lower];
  // Thử match có "bank" suffix
  if (BANK_BIN_MAP[lower + "bank"]) return BANK_BIN_MAP[lower + "bank"];
  // Thử từng key
  for (const [key, bin] of Object.entries(BANK_BIN_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return bin;
  }
  return null;
}

/**
 * Tạo link VietQR từ thông tin bank settings
 */
function createVietQRLink(amount, orderId) {
  const settings = getSettings();
  const bankName = settings.BANK_NAME;
  const bankAccount = settings.BANK_ACCOUNT;
  const bankOwner = settings.BANK_OWNER;

  if (!bankName || !bankAccount || !bankOwner) return null;

  const bin = settings.BANK_BIN || getBankBin(bankName);
  if (!bin) {
    log.warn(`⚠️ Không tìm được BIN cho ngân hàng: ${bankName}. Sẽ hiện STK thay vì QR.`);
    return null;
  }

  const description = `DH${orderId} Tra Lai Shop`;
  const encodedDesc = encodeURIComponent(description);
  const encodedName = encodeURIComponent(bankOwner);

  return `https://img.vietqr.io/image/${bin}-${bankAccount}-compact.png?amount=${amount}&addInfo=${encodedDesc}&accountName=${encodedName}`;
}

/**
 * Kiểm tra thanh toán online có được bật không
 */
function isOnlinePaymentEnabled() {
  const settings = getSettings();
  const val = (settings.PAYMENT_ONLINE || "").toString().toLowerCase();
  
  // Nếu cài đặt rõ ràng là tắt, thì tắt
  if (["false", "0", "no", "off", "tắt", "không"].includes(val)) return false;
  
  // Nếu cài đặt rõ ràng là bật, thì bật
  if (["true", "1", "yes", "on", "bật", "có"].includes(val)) return true;

  // Nếu không có cài đặt rõ ràng, tự động bật nếu đã cấu hình PayOS
  return isPayOSEnabled();
}

/**
 * Kiểm tra có thông tin bank hay không
 */
function hasBankInfo() {
  const settings = getSettings();
  return !!(settings.BANK_NAME && settings.BANK_ACCOUNT && settings.BANK_OWNER);
}

// ============================================================
// Pending Orders — chờ xác nhận trước khi lưu
// ============================================================
const pendingOrders = new Map(); // chatId -> { parsed, displayName, createdAt, timer }

const PENDING_TIMEOUT = 5 * 60 * 1000; // 5 phút

async function createPendingOrder(chatId, displayName, parsed) {
  cancelPendingTimeout(chatId);

  const unitPrice = Math.round(Number(parsed.product.price) || 0);
  const qty = Math.round(Number(parsed.quantity) || 1);
  const totalProductPrice = unitPrice * qty;
  const shipping = calculateShipping(parsed.address, totalProductPrice);
  const totalPrice = totalProductPrice + Math.round(shipping.fee || 0);
  
  if (isNaN(totalPrice)) {
    log.error(`❌ NaN Price error for ${chatId}: p=${parsed.product.price}, q=${parsed.quantity}, s=${shipping.fee}`);
    return "❌ Xin lỗi, hệ thống tính toán gặp sự cố nhỏ. Vui lòng liên hệ chủ shop để đặt hàng nhé! 🙏";
  }

  // ── Kiểm tra tồn kho SỚM — trước khi hỏi xác nhận ──
  const checkResult = await sendToGoogleSheet({
    action: "check_stock",
    product: parsed.product.name,
    quantity: qty
  });

  if (checkResult && !checkResult.ok) {
    const settings = getSettings();
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

  const orderReplies = getOrderReplies();
  const footer = orderReplies.reminder.split('\n').pop() || '"OK" · "Hủy" · "Sửa"';

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
    `Trả lời: ${footer}`
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

  // 2) Detect SĐT (+84, 84 hoặc 0...) - Chấp nhận cả dấu cách/chấm phân cách
  const phoneMatch = text.match(/((?:\+84|84|0)\s?(\d{2,3}[\.\s]?){2,3}\d{3,4})/);
  if (!phoneMatch) return null;
  const phone = phoneMatch[1].replace(/[\s\.]/g, ""); // Làm sạch SĐT
  if (phone.length < 9) return null;

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

  quantity = parseInt(quantity);
  if (isNaN(quantity) || quantity < 1 || quantity > 99) quantity = 1;

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

  // Tồn kho đã được kiểm tra ở createPendingOrder — không cần check lại

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
    paymentMethod: "pending", // Sẽ update sau khi khách chọn
  });

  if (!orderId) {
    log.error(`❌ Không thể lưu đơn hàng cho ${chatId}`);
    return `❌ Xin lỗi, hệ thống gặp sự cố khi tạo đơn hàng. Vui lòng thử lại hoặc liên hệ chủ shop nhé! 🙏`;
  }

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
    paymentMethod: isOnlinePaymentEnabled() ? "Chờ chọn" : "cod",
  });

  if (!confirmResult || !confirmResult.ok) {
    log.error(`⚠️ Đồng bộ đơn hàng #${orderId} thất bại!`);
    updateOrderStatus(orderId, "error_sheet");
    return `⚠️ CẢNH BÁO: Đã có lỗi kỹ thuật khi đồng bộ đơn hàng #${orderId} lên Google Sheet.\n\nTuy nhiên, Bot đã ghi nhận thông tin thành công. Chủ shop sẽ kiểm tra và xác nhận sớm qua SĐT ${parsed.phone} của bạn nhé! 🙏`;
  }

  trackEvent("order_created", chatId);

  const priceStr = totalPrice.toLocaleString("vi-VN") + "đ";
  const productTotalStr = totalProductPrice.toLocaleString("vi-VN") + "đ";
  let shipLine = shipping.fee === 0 ? `Phí ship: MIỄN PHÍ (${shipping.zone})` : `Phí ship: ${shipping.fee.toLocaleString("vi-VN")}đ (${shipping.zone})`;

  const orderInfo =
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `  📋  ĐƠN HÀNG #${orderId}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Sản phẩm: ${parsed.product.name}\n` +
    `Số lượng: ${parsed.quantity} gói\n` +
    `Tiền hàng: ${productTotalStr}\n` +
    `${shipLine}\n` +
    `Tổng thanh toán: ${priceStr}\n\n` +
    `Người nhận: ${parsed.customerName}\n` +
    `SĐT: ${parsed.phone}\n` +
    `Địa chỉ: ${parsed.address}\n`;

  // 4) Kiểm tra thanh toán online
  if (isOnlinePaymentEnabled()) {
    // Lưu pending payment choice với timeout
    setPendingPaymentChoice(chatId, {
      orderId,
      totalPrice,
      product: parsed.product.name,
      buyerName: parsed.customerName,
      buyerPhone: parsed.phone,
      displayName,
    });

    return (
      orderInfo + `\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `  💳  CHỌN THANH TOÁN\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `1️⃣ Nhắn "chuyển khoản" → Thanh toán trước\n` +
      `2️⃣ Nhắn "tiền mặt" → COD (trả khi nhận hàng)`
    );
  }

  // Không bật thanh toán online → COD mặc định
  updateOrderPaymentMethod(orderId, "cod");
  updateOrderStatus(orderId, "cod");
  sendToGoogleSheet({ action: "update_payment_status", orderId, status: "cod", paymentMethod: "cod" }).catch(() => {});
  return (
    orderInfo + `\n` +
    `💰 Thanh toán: Tiền mặt khi nhận hàng (COD)\n` +
    `Cảm ơn ${displayName}! Chủ shop sẽ liên hệ xác nhận sớm nhất! 🙏`
  );
}

// ============================================================
// Pending Payment Choice — chờ khách chọn phương thức thanh toán
// ============================================================
const pendingPaymentChoice = new Map(); // chatId -> { orderId, totalPrice, ..., timer }

const PAYMENT_CHOICE_TIMEOUT = 10 * 60 * 1000; // 10 phút

function setPendingPaymentChoice(chatId, data) {
  // Cleanup cũ nếu có
  const old = pendingPaymentChoice.get(chatId);
  if (old && old.timer) clearTimeout(old.timer);

  // Tự động fallback COD nếu hết hạn
  const timer = setTimeout(() => {
    const pending = pendingPaymentChoice.get(chatId);
    if (pending) {
      updateOrderPaymentMethod(pending.orderId, "cod");
      updateOrderStatus(pending.orderId, "cod");
      pendingPaymentChoice.delete(chatId);
      log.info(`⏰ Payment choice expired for ${chatId}, defaulting to COD for order #${pending.orderId}`);
    }
  }, PAYMENT_CHOICE_TIMEOUT);

  pendingPaymentChoice.set(chatId, { ...data, timer, createdAt: Date.now() });
}

function hasPendingPaymentChoice(chatId) {
  return pendingPaymentChoice.has(chatId);
}

async function handlePaymentChoice(chatId, text) {
  const pending = pendingPaymentChoice.get(chatId);
  if (!pending) return null;

  const lower = text.toLowerCase().trim();

  // Khách chọn Chuyển khoản
  if (lower.includes("chuyển khoản") || lower.includes("chuyen khoan") || lower.includes("chuyển tiền") || lower.includes("qr") || lower.includes("online") || lower === "1" || lower === "ck" || lower === "chuyển" || lower.includes("banking")) {
    // Cleanup timer
    if (pending.timer) clearTimeout(pending.timer);
    pendingPaymentChoice.delete(chatId);

    // Ưu tiên PayOS
    if (isPayOSEnabled()) {
      const payResult = await createPaymentLink({
        orderId: pending.orderId,
        amount: pending.totalPrice,
        description: `DH${pending.orderId} ${pending.product}`,
        buyerName: pending.buyerName,
        buyerPhone: pending.buyerPhone,
      });

      if (payResult && payResult.checkoutUrl) {
        updateOrderPaymentMethod(pending.orderId, "payos");
        updateOrderStatus(pending.orderId, "pending_payment");
        sendToGoogleSheet({ action: "update_payment_status", orderId: pending.orderId, status: "pending_payment", paymentMethod: "PayOS" }).catch(() => {});
        return (
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `  💳  THANH TOÁN ĐƠN #${pending.orderId}\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Số tiền: ${pending.totalPrice.toLocaleString("vi-VN")}đ\n\n` +
          `👉 Nhấn link để thanh toán:\n${payResult.checkoutUrl}\n\n` +
          `⏰ Link có hiệu lực trong 15 phút.\n` +
          `Sau khi thanh toán, Shop sẽ xác nhận tự động! ✅`
        );
      }
      // PayOS lỗi → thử VietQR fallback
      log.warn(`⚠️ PayOS lỗi cho đơn #${pending.orderId}, thử VietQR fallback...`);
    }

    // Fallback: VietQR (nếu có bank info)
    if (hasBankInfo()) {
      const settings = getSettings();
      const qrLink = createVietQRLink(pending.totalPrice, pending.orderId);

      updateOrderPaymentMethod(pending.orderId, "bank_transfer");
      updateOrderStatus(pending.orderId, "pending_payment");
      sendToGoogleSheet({ action: "update_payment_status", orderId: pending.orderId, status: "pending_payment", paymentMethod: "Chuyển khoản" }).catch(() => {});

      let msg =
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `  💳  CHUYỂN KHOẢN ĐƠN #${pending.orderId}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Ngân hàng: ${settings.BANK_NAME}\n` +
        `Số TK: ${settings.BANK_ACCOUNT}\n` +
        `Chủ TK: ${settings.BANK_OWNER}\n` +
        `Số tiền: ${pending.totalPrice.toLocaleString("vi-VN")}đ\n` +
        `Nội dung CK: DH${pending.orderId}\n`;

      if (qrLink) {
        msg += `\n📱 Quét mã QR để chuyển khoản:\n${qrLink}\n`;
      }

      msg += `\n⏰ Sau khi chuyển khoản, bạn nhắn "đã chuyển khoản" để shop xác nhận nhé! 🙏`;

      return msg;
    }

    // Không có PayOS, không có bank info → hướng dẫn liên hệ
    const settings = getSettings();
    if (pending.timer) clearTimeout(pending.timer);
    pendingPaymentChoice.delete(chatId);
    
    updateOrderPaymentMethod(pending.orderId, "cod");
    updateOrderStatus(pending.orderId, "cod");
    sendToGoogleSheet({ action: "update_payment_status", orderId: pending.orderId, status: "COD", paymentMethod: "COD" }).catch(() => {});
    return (
      `⚠️ Chức năng chuyển khoản đang được cập nhật.\n\n` +
      `Đơn hàng #${pending.orderId} sẽ thanh toán COD (trả khi nhận hàng).\n` +
      `Hoặc liên hệ chủ shop qua Zalo ${settings.OWNER_PHONE || "0975324568"} để chuyển khoản trực tiếp ạ! 🙏`
    );
  }

  // Khách chọn COD
  if (lower.includes("tiền mặt") || lower.includes("tien mat") || lower.includes("cod") || lower === "2" || lower.includes("nhận hàng")) {
    if (pending.timer) clearTimeout(pending.timer);
    pendingPaymentChoice.delete(chatId);
    updateOrderPaymentMethod(pending.orderId, "cod");
    updateOrderStatus(pending.orderId, "cod");
    sendToGoogleSheet({ action: "update_payment_status", orderId: pending.orderId, status: "cod", paymentMethod: "cod" }).catch(() => {});
    return `✅ Đơn hàng #${pending.orderId} sẽ thanh toán khi nhận hàng (COD).\nCảm ơn ${pending.displayName}! Chủ shop sẽ liên hệ xác nhận sớm nhất! 🙏🍵`;
  }

  // Không hiểu lựa chọn
  return `Bạn vui lòng chọn phương thức thanh toán:\n1️⃣ Nhắn "chuyển khoản" → Thanh toán trước\n2️⃣ Nhắn "tiền mặt" → COD (trả khi nhận hàng)`;
}

// ============================================================
// Xem đơn hàng (customer-facing)
// ============================================================
const STATUS_LABELS = {
  "new": "📋 Mới tạo",
  "pending": "⏳ Chờ xử lý",
  "pending_payment": "💳 Chờ thanh toán",
  "pending_verification": "⏳ Chờ shop check tiền",
  "cod": "📦 COD - Chờ giao",
  "paid": "✅ Đã thanh toán",
  "confirmed": "📋 Đã xác nhận",
  "shipping": "🚚 Đang giao hàng",
  "delivered": "✅ Đã giao",
  "cancelled": "❌ Đã hủy",
  "error_sheet": "⚠️ Lỗi hệ thống",
};

const SHEET_STATUS_LABELS = {
  "new": "Mới",
  "pending": "Chờ xử lý",
  "pending_payment": "Chờ thanh toán",
  "cod": "Chờ giao (COD)",
  "paid": "Đã thanh toán",
  "confirmed": "Đã xác nhận",
  "shipping": "Đang giao",
  "delivered": "Đã giao",
  "cancelled": "Đã hủy",
  "error_sheet": "Lỗi đồng bộ",
};

const PAYMENT_LABELS = {
  "cod": "💰 Tiền mặt (COD)",
  "bank_transfer": "🏦 Chuyển khoản",
  "payos": "💳 Online (PayOS)",
  "pending": "⏳ Chưa chọn",
};

function formatOrderHistory(chatId) {
  const orders = getOrdersByChatId(chatId, 5);

  if (!orders || orders.length === 0) {
    return "📋 Bạn chưa có đơn hàng nào.\n\nNhắn \"đặt hàng\" để mua trà nhé! 🍵";
  }

  let msg = `━━━━━━━━━━━━━━━━━━━━\n  📋  ĐƠN HÀNG CỦA BẠN\n━━━━━━━━━━━━━━━━━━━━\n`;

  for (const o of orders) {
    const statusLabel = STATUS_LABELS[o.status] || o.status;
    const paymentLabel = PAYMENT_LABELS[o.payment_method] || o.payment_method || "COD";
    const date = o.created_at ? new Date(o.created_at + "Z").toLocaleDateString("vi-VN") : "";

    msg += `\n📦 Đơn #${o.id} (${date})\n`;
    msg += `  ${o.product} x${o.quantity} — ${o.total_price.toLocaleString("vi-VN")}đ\n`;
    msg += `  Trạng thái: ${statusLabel}\n`;
    msg += `  Thanh toán: ${paymentLabel}\n`;
  }

  msg += `\n━━━━━━━━━━━━━━━━━━━━`;
  msg += `\n💡 Nhắn "hủy đơn X" để hủy đơn (nếu chưa giao).`;

  return msg;
}

// ============================================================
// Hủy đơn hàng sau confirm (customer-facing)
// ============================================================
function cancelConfirmedOrder(chatId, text) {
  // Tìm order ID từ text: "hủy đơn 5", "hủy đơn hàng #3", "cancel order 2"
  const match = text.match(/(?:hủy\s*đơn|cancel\s*order|huy\s*don)\s*(?:hàng\s*)?#?(\d+)/i);

  if (!match) {
    // Nếu không có ID cụ thể, hủy đơn gần nhất
    const orders = getOrdersByChatId(chatId, 1);
    if (!orders || orders.length === 0) {
      return "Bạn chưa có đơn hàng nào để hủy ạ.";
    }
    const latestOrder = orders[0];
    if (["cancelled", "delivered", "shipping"].includes(latestOrder.status)) {
      return `Đơn hàng #${latestOrder.id} đang ở trạng thái "${STATUS_LABELS[latestOrder.status] || latestOrder.status}" nên không thể hủy ạ.`;
    }

    const result = dbCancelOrder(latestOrder.id);
    if (result.ok) {
      // Đồng bộ hủy lên Sheet
      sendToGoogleSheet({
        action: "update_status",
        orderId: latestOrder.id,
        status: "cancelled",
      }).catch(() => {});

      return `✅ Đã hủy đơn hàng #${latestOrder.id} (${latestOrder.product} x${latestOrder.quantity}).\n\nNếu bạn muốn đặt lại, cứ nhắn mình nhé! 🙏`;
    }
    return `Không thể hủy đơn #${latestOrder.id}. ${result.error === "cannot_cancel" ? `Đơn đang "${STATUS_LABELS[result.status] || result.status}".` : ""}`;
  }

  const orderId = parseInt(match[1]);
  // Kiểm tra đơn thuộc về khách này
  const orders = getOrdersByChatId(chatId, 50);
  const order = orders.find(o => o.id === orderId);

  if (!order) {
    return `Không tìm thấy đơn hàng #${orderId} của bạn ạ.`;
  }

  const result = dbCancelOrder(orderId);
  if (result.ok) {
    sendToGoogleSheet({
      action: "update_status",
      orderId,
      status: "cancelled",
    }).catch(() => {});

    return `✅ Đã hủy đơn hàng #${orderId} (${order.product} x${order.quantity}).\n\nNếu bạn muốn đặt lại, cứ nhắn mình nhé! 🙏`;
  }

  if (result.error === "cannot_cancel") {
    return `Không thể hủy đơn #${orderId}. Đơn đang ở trạng thái "${STATUS_LABELS[result.status] || result.status}" ạ.`;
  }
  return `Không tìm thấy đơn hàng #${orderId} ạ.`;
}

// ============================================================
// Xác nhận đã chuyển khoản (customer-facing)
// ============================================================
function confirmBankTransfer(chatId) {
  const orders = getOrdersByChatId(chatId, 5);
  const pendingPayment = orders.find(o => o.status === "pending_payment" && (o.payment_method === "bank_transfer" || o.payment_method === "payos"));

  if (!pendingPayment) {
    return null; // Không có đơn chờ thanh toán
  }

  const settings = getSettings();
  
  // Cập nhật trạng thái đơn sang 'pending_verification' để shop biết cần kiểm tra tiền
  updateOrderStatus(pendingPayment.id, "pending_verification");
  sendToGoogleSheet({ action: "update_status", orderId: pendingPayment.id, status: "pending_verification" }).catch(() => {});

  return (
    `📝 Đã ghi nhận! Đơn hàng #${pendingPayment.id} đang chờ shop xác nhận thanh toán.\n\n` +
    `Chủ shop sẽ kiểm tra và xác nhận sớm nhất ạ!\n` +
    `Nếu cần hỗ trợ, liên hệ Zalo: ${settings.OWNER_PHONE || "0975324568"} 🙏`
  );
}

// ============================================================
// Thông báo cập nhật đơn hàng (gửi cho khách)
// ============================================================
function getOrderStatusNotification(order, newStatus) {
  const statusMessages = {
    "confirmed": `✅ Đơn hàng #${order.id} đã được xác nhận!\n\nShop đang chuẩn bị hàng cho bạn. 📦`,
    "shipping": `🚚 Đơn hàng #${order.id} đang được giao!\n\n${order.product} x${order.quantity}\nShop sẽ thông báo khi giao thành công nhé!`,
    "delivered": `✅ Đơn hàng #${order.id} đã giao thành công!\n\nCảm ơn bạn đã tin tưởng Trà Lài Shop! 🍵💚\nNếu có vấn đề gì, nhắn mình nhé!`,
    "paid": `✅ THANH TOÁN THÀNH CÔNG!\n\nĐơn hàng #${order.id} đã được thanh toán.\nShop sẽ chuẩn bị hàng và giao cho bạn sớm nhất! 🚚`,
    "cancelled": `❌ Đơn hàng #${order.id} đã bị hủy.\n\nNếu bạn muốn đặt lại, cứ nhắn mình nhé! 🙏`,
  };

  return statusMessages[newStatus] || `📋 Đơn hàng #${order.id} đã được cập nhật: ${STATUS_LABELS[newStatus] || newStatus}`;
}

async function sendToGoogleSheet(orderData) {
  if (!GOOGLE_SHEET_URL) return null;
  try {
    const payload = { ...orderData };
    
    // Tự động chuyển đổi status & paymentMethod sang label tiếng Việt cho Sheet
    if (payload.status && SHEET_STATUS_LABELS[payload.status]) {
      payload.status = SHEET_STATUS_LABELS[payload.status];
    }
    if (payload.paymentMethod && PAYMENT_LABELS[payload.paymentMethod]) {
      // Bỏ icon emoji khi gửi lên Sheet để dữ liệu sạch hơn (tùy chọn)
      payload.paymentMethod = PAYMENT_LABELS[payload.paymentMethod].replace(/[\p{Emoji_Presentation}\p{Emoji}\p{Emoji_Modifier_Base}\p{Emoji_Modifier}\p{Emoji_Component}]/gu, '').trim();
    }
    
    const res = await axios.post(GOOGLE_SHEET_URL, payload, { timeout: 10000 });
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
  hasPendingPaymentChoice,
  handlePaymentChoice,
  formatOrderHistory,
  cancelConfirmedOrder,
  confirmBankTransfer,
  getOrderStatusNotification,
  isOnlinePaymentEnabled,
  STATUS_LABELS,
  SHEET_STATUS_LABELS,
  PAYMENT_LABELS,
};
