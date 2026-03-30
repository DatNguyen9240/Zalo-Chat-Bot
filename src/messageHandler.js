const { getKeywords, getPhotoCaptions, getReplies, getWelcomeMessage, getOrderKeywords, getOrderReplies, getProducts, matchKeywords, getCacheEntries } = require("./constants");
const { generateReply, hasActiveSession } = require("./gemini");
const { getCachedReply } = require("./cache");
const { tryParseOrder, createPendingOrder, confirmPendingOrder, cancelPendingOrder, hasPendingOrder, hasPendingPaymentChoice, handlePaymentChoice, formatOrderHistory, cancelConfirmedOrder, confirmBankTransfer } = require("./order");
const { sendMessage, sendPhoto, sendSticker, sendTyping } = require("./zaloBot");
const { saveChatMessage, trackEvent, getOrdersByChatId } = require("./database");
const { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW } = require("./config");
const log = require("./logger");

const rateLimitMap = new Map();
const orderConfirmCooldown = new Map();
const ORDER_CONFIRM_COOLDOWN_MS = 5000;

function isOrderConfirmCooledDown(chatId) {
  const last = orderConfirmCooldown.get(chatId);
  const now = Date.now();
  if (last && now - last < ORDER_CONFIRM_COOLDOWN_MS) return false;
  orderConfirmCooldown.set(chatId, now);
  return true;
}

function isRateLimited(chatId) {
  const now = Date.now();
  let record = rateLimitMap.get(chatId);
  if (!record) { record = { count: 0, resetAt: now + RATE_LIMIT_WINDOW }; rateLimitMap.set(chatId, record); }
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + RATE_LIMIT_WINDOW; }
  record.count++;
  return record.count > RATE_LIMIT_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap) if (now > val.resetAt) rateLimitMap.delete(key);
  for (const [key, ts] of orderConfirmCooldown) if (now - ts > ORDER_CONFIRM_COOLDOWN_MS * 10) orderConfirmCooldown.delete(key);
}, 5 * 60 * 1000);

const chatLocks = new Map();

// ============================================================
// Keywords cho các tính năng mới
// ============================================================
const ORDER_HISTORY_KEYWORDS = [
  "đơn hàng của tôi", "đơn hàng của mình", "đơn của tôi", "đơn của mình",
  "xem đơn hàng", "xem đơn", "kiểm tra đơn", "check đơn", "check don",
  "don cua toi", "xem don hang",
  "lịch sử đơn", "lich su don", "tra cứu đơn", "tra cuu don",
  "tracking", "trạng thái đơn", "trang thai don",
  "đơn đã đặt", "don da dat"
];

// "đơn hàng" và "don hang" bị loại vì quá chung, dễ match "đặt đơn hàng"

const ORDER_CANCEL_KEYWORDS = [
  "hủy đơn", "huy don", "cancel order", "huỷ đơn",
  "hủy đơn hàng", "huy don hang", "bỏ đơn", "bo don"
];

const BANK_TRANSFER_CONFIRM_KEYWORDS = [
  "đã chuyển khoản", "da chuyen khoan", "đã ck", "da ck",
  "đã thanh toán", "da thanh toan", "đã chuyển", "da chuyen",
  "chuyển rồi", "chuyen roi", "đã gửi tiền", "da gui tien"
];

const ORDER_INTENT_WORDS = ["đặt hàng", "mua hàng", "đặt đơn", "muốn mua", "muốn đặt", "order "];

function matchesAny(text, keywords) {
  const lower = text.toLowerCase().trim();
  return keywords.some(kw => lower.includes(kw));
}

function isOrderHistoryIntent(text) {
  const lower = text.toLowerCase().trim();
  // Phải match keyword xem đơn
  if (!ORDER_HISTORY_KEYWORDS.some(kw => lower.includes(kw))) return false;
  // Nhưng không match intent đặt hàng (ví dụ: "đặt đơn hàng", "muốn mua hàng")
  if (ORDER_INTENT_WORDS.some(w => lower.includes(w))) return false;
  return true;
}

async function handleTextMessage(chatId, from, text, getPhotoUrl) {
  const previousTask = chatLocks.get(chatId) || Promise.resolve();
  const currentTask = previousTask.then(async () => {
    try {
      await processUserMessage(chatId, from, text, getPhotoUrl);
    } catch (err) {
      log.error(`Error in handleTextMessage [${chatId}]: ${err.message}`);
    }
  });
  chatLocks.set(chatId, currentTask);
  currentTask.finally(() => { if (chatLocks.get(chatId) === currentTask) chatLocks.delete(chatId); });
  return currentTask;
}

async function processUserMessage(chatId, from, text, getPhotoUrl) {
  log.info(`💬 ${from.display_name}: ${text}`);
  trackEvent("message", chatId);
  saveChatMessage(chatId, from.display_name, "user", text);

  if (isRateLimited(chatId)) {
    const replies = getReplies();
    await sendMessage(chatId, replies.rateLimited);
    return;
  }

  // 1) Gửi welcome nếu session mới
  let sentWelcome = false;
  if (!hasActiveSession(chatId)) {
    const welcomeMsg = getWelcomeMessage(from?.display_name || "bạn");
    await sendMessage(chatId, welcomeMsg);
    saveChatMessage(chatId, "Bot", "bot", welcomeMsg);
    sentWelcome = true;
    
    // Nếu tin nhắn đầu tiên chỉ là lời chào, gửi thêm ảnh banner rồi dừng lại
    if (matchKeywords(text, getKeywords().greeting) && text.length < 15) {
      if (getPhotoUrl) {
        const bannerUrl = getPhotoUrl("banner");
        log.info(`🖼️ Banner URL: ${bannerUrl}`);
        if (bannerUrl && bannerUrl.startsWith("http")) {
          await sendPhoto(chatId, bannerUrl, getPhotoCaptions().banner);
        }
      }
      log.debug(`👋 Greeting only in new session - stopping after welcome & banner.`);
      return;
    }
  }

  // 2) Kiểm tra đơn hàng chờ xác nhận
  if (hasPendingOrder(chatId)) {
    await handlePendingOrder(chatId, text);
    return;
  }

  // 2.5) Kiểm tra chờ chọn phương thức thanh toán
  if (hasPendingPaymentChoice(chatId)) {
    const payReply = await handlePaymentChoice(chatId, text);
    if (payReply) {
      await sendMessage(chatId, payReply);
      saveChatMessage(chatId, "Bot", "bot", payReply);
    }
    return;
  }

  // 2.6) Xác nhận đã chuyển khoản
  if (matchesAny(text, BANK_TRANSFER_CONFIRM_KEYWORDS)) {
    const confirmReply = confirmBankTransfer(chatId);
    if (confirmReply) {
      await sendMessage(chatId, confirmReply);
      saveChatMessage(chatId, "Bot", "bot", confirmReply);
      return;
    }
    // Không có đơn chờ thanh toán → để AI xử lý
  }

  // 2.7) Xem đơn hàng
  if (isOrderHistoryIntent(text)) {
    const historyReply = formatOrderHistory(chatId);
    await sendMessage(chatId, historyReply);
    saveChatMessage(chatId, "Bot", "bot", historyReply);
    return;
  }

  // 2.8) Hủy đơn hàng sau confirm
  if (matchesAny(text, ORDER_CANCEL_KEYWORDS)) {
    const cancelReply = cancelConfirmedOrder(chatId, text);
    await sendMessage(chatId, cancelReply);
    saveChatMessage(chatId, "Bot", "bot", cancelReply);
    return;
  }

  // 3) Thử parse đơn hàng trực tiếp
  const parsed = tryParseOrder(text);
  if (parsed) {
    const orderMsg = await createPendingOrder(chatId, from.display_name, parsed);
    await sendMessage(chatId, orderMsg);
    saveChatMessage(chatId, "Bot", "bot", orderMsg);
    return;
  }

  // 4) Gửi ảnh tự động theo từ khóa (Nếu có) - Ưu tiên gửi trước reply
  if (getPhotoUrl) {
    const captions = getPhotoCaptions();
    const keywords = getKeywords();
    let photoType = null;
    if (matchKeywords(text, keywords.greeting)) photoType = "banner";
    else if (matchKeywords(text, keywords.price)) photoType = "product";
    else if (matchKeywords(text, keywords.promo)) photoType = "promo";
    else if (matchKeywords(text, keywords.image)) photoType = "product";

    if (photoType) {
      const url = getPhotoUrl(photoType);
      log.info(`🖼️ Photo URL [${photoType}]: ${url}`);
      if (url && url.startsWith("http")) {
        await sendPhoto(chatId, url, captions[photoType]);
      } else {
        log.warn(`⚠️ Không gửi ảnh vì URL không hợp lệ: ${url}`);
      }
    }
  }

  // 5) Cache cho FAQ (Skip nếu nhắc đến sản phẩm)
  const lower = text.toLowerCase();
  const products = getProducts();
  const mentionsProduct = products.some(p => p.aliases.some(a => lower.includes(a)));
  
  const cached = (!mentionsProduct && !sentWelcome) ? getCachedReply(text) : null;
  
  if (cached) {
    await sendMessage(chatId, cached);
    saveChatMessage(chatId, "Bot", "bot", cached);
  } else {
    // 6) Gemini AI
    await sendTyping(chatId);
    const reply = await generateReply(chatId, text, from.display_name);
    await sendMessage(chatId, reply);
    saveChatMessage(chatId, "Bot", "bot", reply);
  }
}

async function handleFollowEvent(chatId, getPhotoUrl) {
  const welcomeMsg = getWelcomeMessage(null); // Gửi lời chào chung chung nếu chưa có tên
  await sendMessage(chatId, welcomeMsg);
  saveChatMessage(chatId, "Bot", "bot", welcomeMsg);

  if (getPhotoUrl) {
    const bannerUrl = getPhotoUrl("banner");
    if (bannerUrl && bannerUrl.startsWith("http")) {
      const captions = getPhotoCaptions();
      await sendPhoto(chatId, bannerUrl, captions.banner);
    }
  }
}

async function handlePendingOrder(chatId, text) {
  const lower = text.toLowerCase().trim();
  const orderKeywords = getOrderKeywords();
  const orderReplies = getOrderReplies();

  if (orderKeywords.confirm.some(k => lower.includes(k))) {
    if (!isOrderConfirmCooledDown(chatId)) return;
    const confirmReply = await confirmPendingOrder(chatId);
    if (confirmReply) {
      await sendMessage(chatId, confirmReply);
      saveChatMessage(chatId, "Bot", "bot", confirmReply);
    }
  } else if (orderKeywords.cancel.some(k => lower.includes(k))) {
    const cancelReply = cancelPendingOrder(chatId);
    if (cancelReply) {
      await sendMessage(chatId, cancelReply);
      saveChatMessage(chatId, "Bot", "bot", cancelReply);
    }
  } else if (orderKeywords.edit.some(k => lower.includes(k))) {
    cancelPendingOrder(chatId);
    await sendMessage(chatId, orderReplies.editPrompt);
    saveChatMessage(chatId, "Bot", "bot", orderReplies.editPrompt);
  } else {
    await sendMessage(chatId, orderReplies.reminder);
  }
}

async function handleImageMessage(chatId) {
  const previousTask = chatLocks.get(chatId) || Promise.resolve();
  const currentTask = previousTask.then(async () => {
    trackEvent("image_received", chatId);
    if (!chatId) return;

    // Kiểm tra nếu khách đang có đơn chờ thanh toán → có thể là bill CK
    const orders = getOrdersByChatId(chatId, 3);
    const hasPendingPayment = orders.some(o => o.status === "pending_payment");

    if (hasPendingPayment) {
      const reply = "📸 Cảm ơn bạn đã gửi ảnh! Nếu đây là bill chuyển khoản, chủ shop sẽ kiểm tra và xác nhận sớm nhất ạ! 🙏";
      await sendMessage(chatId, reply);
      saveChatMessage(chatId, "Bot", "bot", reply);
    } else {
      const reply = getReplies().image;
      await sendMessage(chatId, reply);
      saveChatMessage(chatId, "Bot", "bot", reply);
    }
    // Lưu lại trong lịch sử là khách đã gửi ảnh
    saveChatMessage(chatId, "Khách", "user", "[Hình ảnh]");
  });
  chatLocks.set(chatId, currentTask);
  currentTask.finally(() => { if (chatLocks.get(chatId) === currentTask) chatLocks.delete(chatId); });
}

async function handleStickerMessage(chatId, message) {
  const previousTask = chatLocks.get(chatId) || Promise.resolve();
  const currentTask = previousTask.then(async () => {
    trackEvent("sticker_received", chatId);
    const stickerId = message?.sticker;
    if (chatId) {
       const replies = getReplies();
       if (stickerId) await sendSticker(chatId, stickerId);
       else await sendMessage(chatId, replies.sticker);
       
       saveChatMessage(chatId, "Khách", "user", "[Sticker]");
       saveChatMessage(chatId, "Bot", "bot", "[Sticker Response]");
    }
  });
  chatLocks.set(chatId, currentTask);
  currentTask.finally(() => { if (chatLocks.get(chatId) === currentTask) chatLocks.delete(chatId); });
}

module.exports = { handleTextMessage, handleImageMessage, handleStickerMessage, handleFollowEvent };
