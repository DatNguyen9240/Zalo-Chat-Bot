const { KEYWORDS, PHOTO_CAPTIONS, REPLIES, getWelcomeMessage, ORDER_KEYWORDS, ORDER_REPLIES, PRODUCTS, matchKeywords } = require("./constants");
const { generateReply, hasActiveSession } = require("./gemini");
const { getCachedReply } = require("./cache");
const { tryParseOrder, createPendingOrder, confirmPendingOrder, cancelPendingOrder, hasPendingOrder } = require("./order");
const { sendMessage, sendPhoto, sendSticker, sendTyping } = require("./zaloBot");
const { saveChatMessage, trackEvent } = require("./database");
const { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW } = require("./config");
const log = require("./logger");

// ============================================================
// Rate Limiter â€” giá»›i háº¡n tin nháº¯n má»—i user
// ============================================================
const rateLimitMap = new Map();

// Order confirm cooldown â€” chá»‘ng spam confirm
const orderConfirmCooldown = new Map(); // chatId -> timestamp láº§n confirm gáº§n nháº¥t
const ORDER_CONFIRM_COOLDOWN_MS = 5000; // 5 giÃ¢y

function isOrderConfirmCooledDown(chatId) {
  const last = orderConfirmCooldown.get(chatId);
  const now = Date.now();
  if (last && now - last < ORDER_CONFIRM_COOLDOWN_MS) {
    log.warn(`âš ï¸ Order confirm cooldown active for ${chatId}`);
    return false; // chÆ°a háº¿t cooldown
  }
  orderConfirmCooldown.set(chatId, now);
  return true; // Ä‘Æ°á»£c phÃ©p confirm
}

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

// Cleanup rate limit entries cÅ© má»—i 5 phÃºt
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000);

// ============================================================
// Xá»­ lÃ½ text message â€” gá»i chung tá»« webhook + polling
// ============================================================
async function handleTextMessage(chatId, from, text, getPhotoUrl) {
  log.info(`ðŸ’¬ ${from.display_name}: ${text}`);

  // Track & save
  trackEvent("message", chatId);
  saveChatMessage(chatId, from.display_name, "user", text);

  // Rate limit
  if (isRateLimited(chatId)) {
    await sendMessage(chatId, REPLIES.rateLimited);
    return;
  }

  // Gá»­i welcome náº¿u session má»›i (user láº§n Ä‘áº§u hoáº·c session Ä‘Ã£ háº¿t háº¡n)
  let sentWelcome = false;
  if (!hasActiveSession(chatId)) {
    const welcomeMsg = getWelcomeMessage(from.display_name);
    log.info(`ðŸ‘‹ New/expired session â€” sending welcome to ${from.display_name} (${chatId})`);
    await sendMessage(chatId, welcomeMsg);
    saveChatMessage(chatId, "Bot", "bot", welcomeMsg);
    sentWelcome = true;
  }

  // 0) Kiá»ƒm tra Ä‘Æ¡n hÃ ng chá» xÃ¡c nháº­n
  if (hasPendingOrder(chatId)) {
    await handlePendingOrder(chatId, text);
    return;
  }

  // 1) Thá»­ parse Ä‘Æ¡n hÃ ng trá»±c tiáº¿p (khÃ´ng cáº§n Gemini)
  const parsed = tryParseOrder(text);
  if (parsed) {
    const orderMsg = createPendingOrder(chatId, from.display_name, parsed);
    await sendMessage(chatId, orderMsg);
    saveChatMessage(chatId, "Bot", "bot", orderMsg);
    return;
  }

  // 2) Cache cho FAQ â€” nhÆ°ng skip náº¿u user nháº¯c Ä‘áº¿n sáº£n pháº©m cá»¥ thá»ƒ
  //    (Ä‘á»ƒ Gemini xá»­ lÃ½ conversational order flow)
  const lower = text.toLowerCase();
  const mentionsProduct = PRODUCTS.some(p => p.aliases.some(a => lower.includes(a)));

  const cached = (!mentionsProduct && !sentWelcome) ? getCachedReply(text) : null;
  let reply;

  if (cached) {
    reply = cached;
  } else {
    // 3) Gemini AI (function calling cho Ä‘Æ¡n phá»©c táº¡p)
    await sendTyping(chatId);
    reply = await generateReply(chatId, text, from.display_name);
  }

  // Gá»­i reply
  await sendMessage(chatId, reply);
  saveChatMessage(chatId, "Bot", "bot", reply);

  // 4) Gá»­i áº£nh sáº£n pháº©m theo tá»« khÃ³a
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
// Xá»­ lÃ½ Ä‘Æ¡n hÃ ng chá» xÃ¡c nháº­n
// ============================================================
async function handlePendingOrder(chatId, text) {
  const lower = text.toLowerCase().trim();

  if (ORDER_KEYWORDS.confirm.some(k => lower.includes(k))) {
    // Cooldown
    if (!isOrderConfirmCooledDown(chatId)) return;
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
    // Nháº¯c nhá»Ÿ user chá»n OK / Há»§y / Sá»­a
    await sendMessage(chatId, ORDER_REPLIES.reminder);
  }
}

// ============================================================
// Xá»­ lÃ½ cÃ¡c loáº¡i message khÃ¡c
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
