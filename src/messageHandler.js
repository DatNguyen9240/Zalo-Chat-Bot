const { KEYWORDS, PHOTO_CAPTIONS, REPLIES, getWelcomeMessage, ORDER_KEYWORDS, ORDER_REPLIES, PRODUCTS, matchKeywords } = require("./constants");
const { generateReply, hasActiveSession } = require("./gemini");
const { getCachedReply } = require("./cache");
const { tryParseOrder, createPendingOrder, confirmPendingOrder, cancelPendingOrder, hasPendingOrder } = require("./order");
const { sendMessage, sendPhoto, sendSticker, sendTyping } = require("./zaloBot");
const { saveChatMessage, trackEvent } = require("./database");
const { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW } = require("./config");
const log = require("./logger");

// ============================================================
// Rate Limiter — giới hạn tin nhắn mỗi user
// ============================================================
const rateLimitMap = new Map();

function isRateLimited(chatId) {
  const now = Date.now();
  let record = rateLimitMap.get(chatId);

  if (!record) {
    record = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(chatId, record);
  }

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + RATE_LIMIT_WINDOW;
  }

  record.count++;

  if (record.count > RATE_LIMIT_MAX) {
    log.warn(`Rate limited: ${chatId} (${record.count}/${RATE_LIMIT_MAX})`);
    return true;
  }
  return false;
}

// Cleanup rate limit entries cũ mỗi 5 phút
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000);

// ============================================================
// Xử lý text message — gọi chung từ webhook + polling
// ============================================================
async function handleTextMessage(chatId, from, text, getPhotoUrl) {
  log.info(`💬 ${from.display_name}: ${text}`);

  // Track & save
  trackEvent("message", chatId);
  saveChatMessage(chatId, from.display_name, "user", text);

  // Rate limit
  if (isRateLimited(chatId)) {
    await sendMessage(chatId, REPLIES.rateLimited);
    return;
  }

  // Gửi welcome nếu session mới (user lần đầu hoặc session đã hết hạn)
  let sentWelcome = false;
  if (!hasActiveSession(chatId)) {
    const welcomeMsg = getWelcomeMessage(from.display_name);
    log.info(`👋 New/expired session — sending welcome to ${from.display_name} (${chatId})`);
    await sendMessage(chatId, welcomeMsg);
    saveChatMessage(chatId, "Bot", "bot", welcomeMsg);
    sentWelcome = true;
  }

  // 0) Kiểm tra đơn hàng chờ xác nhận
  if (hasPendingOrder(chatId)) {
    await handlePendingOrder(chatId, text);
    return;
  }

  // 1) Thử parse đơn hàng trực tiếp (không cần Gemini)
  const parsed = tryParseOrder(text);
  if (parsed) {
    const orderMsg = createPendingOrder(chatId, from.display_name, parsed);
    await sendMessage(chatId, orderMsg);
    saveChatMessage(chatId, "Bot", "bot", orderMsg);
    return;
  }

  // 2) Cache cho FAQ — nhưng skip nếu user nhắc đến sản phẩm cụ thể
  //    (để Gemini xử lý conversational order flow)
  const lower = text.toLowerCase();
  const mentionsProduct = PRODUCTS.some(p => p.aliases.some(a => lower.includes(a)));

  const cached = (!mentionsProduct && !sentWelcome) ? getCachedReply(text) : null;
  let reply;

  if (cached) {
    reply = cached;
  } else {
    // 3) Gemini AI (function calling cho đơn phức tạp)
    await sendTyping(chatId);
    reply = await generateReply(chatId, text, from.display_name);
  }

  // Gửi reply
  await sendMessage(chatId, reply);
  saveChatMessage(chatId, "Bot", "bot", reply);

  // 4) Gửi ảnh sản phẩm theo từ khóa
  if (getPhotoUrl) {
    if (matchKeywords(text, KEYWORDS.greeting)) {
      await sendPhoto(chatId, getPhotoUrl("banner"), PHOTO_CAPTIONS.banner);
      trackEvent("photo_sent", chatId);
    } else if (matchKeywords(text, KEYWORDS.price)) {
      await sendPhoto(chatId, getPhotoUrl("product"), PHOTO_CAPTIONS.product);
      trackEvent("photo_sent", chatId);
    } else if (matchKeywords(text, KEYWORDS.promo)) {
      await sendPhoto(chatId, getPhotoUrl("promo"), PHOTO_CAPTIONS.promo);
      trackEvent("photo_sent", chatId);
    } else if (matchKeywords(text, KEYWORDS.image)) {
      await sendPhoto(chatId, getPhotoUrl("product"), PHOTO_CAPTIONS.product);
      trackEvent("photo_sent", chatId);
    }
  }
}

// ============================================================
// Xử lý đơn hàng chờ xác nhận
// ============================================================
async function handlePendingOrder(chatId, text) {
  const lower = text.toLowerCase().trim();

  if (ORDER_KEYWORDS.confirm.some(k => lower.includes(k))) {
    const confirmReply = confirmPendingOrder(chatId);
    if (confirmReply) {
      await sendMessage(chatId, confirmReply);
      saveChatMessage(chatId, "Bot", "bot", confirmReply);
    }
  } else if (ORDER_KEYWORDS.cancel.some(k => lower.includes(k))) {
    const cancelReply = cancelPendingOrder(chatId);
    if (cancelReply) {
      await sendMessage(chatId, cancelReply);
      saveChatMessage(chatId, "Bot", "bot", cancelReply);
    }
  } else if (ORDER_KEYWORDS.edit.some(k => lower.includes(k))) {
    cancelPendingOrder(chatId);
    await sendMessage(chatId, ORDER_REPLIES.editPrompt);
    saveChatMessage(chatId, "Bot", "bot", ORDER_REPLIES.editPrompt);
  } else {
    // Nhắc nhở user chọn OK / Hủy / Sửa
    await sendMessage(chatId, ORDER_REPLIES.reminder);
  }
}

// ============================================================
// Xử lý các loại message khác
// ============================================================
async function handleImageMessage(chatId) {
  trackEvent("image_received", chatId);
  if (chatId) await sendMessage(chatId, REPLIES.image);
}

async function handleStickerMessage(chatId, message) {
  trackEvent("sticker_received", chatId);
  const stickerId = message?.sticker;
  if (chatId) {
    if (stickerId) {
      await sendSticker(chatId, stickerId);
    } else {
      await sendMessage(chatId, REPLIES.sticker);
    }
  }
}

module.exports = {
  handleTextMessage,
  handleImageMessage,
  handleStickerMessage,
};
