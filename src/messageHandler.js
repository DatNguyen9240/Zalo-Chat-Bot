const { getKeywords, getPhotoCaptions, getReplies, getWelcomeMessage, getOrderKeywords, getOrderReplies, getProducts, matchKeywords, getCacheEntries } = require("./constants");
const { generateReply, hasActiveSession } = require("./gemini");
const { getCachedReply } = require("./cache");
const { tryParseOrder, createPendingOrder, confirmPendingOrder, cancelPendingOrder, hasPendingOrder } = require("./order");
const { sendMessage, sendPhoto, sendSticker, sendTyping } = require("./zaloBot");
const { saveChatMessage, trackEvent } = require("./database");
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
    const welcomeMsg = getWelcomeMessage(from.display_name);
    await sendMessage(chatId, welcomeMsg);
    saveChatMessage(chatId, "Bot", "bot", welcomeMsg);
    sentWelcome = true;
    
    // Nếu tin nhắn đầu tiên chỉ là lời chào, gửi thêm ảnh banner rồi dừng lại
    if (matchKeywords(text, getKeywords().greeting) && text.length < 15) {
      if (getPhotoUrl) {
        const bannerUrl = getPhotoUrl("banner");
        if (bannerUrl) {
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

  // 3) Thử parse đơn hàng trực tiếp
  const parsed = tryParseOrder(text);
  if (parsed) {
    const orderMsg = createPendingOrder(chatId, from.display_name, parsed);
    await sendMessage(chatId, orderMsg);
    saveChatMessage(chatId, "Bot", "bot", orderMsg);
    return;
  }

  // 4) Cache cho FAQ (Skip nếu nhắc đến sản phẩm hoặc vừa gửi Welcome)
  const lower = text.toLowerCase();
  const products = getProducts();
  const mentionsProduct = products.some(p => p.aliases.some(a => lower.includes(a)));
  
  const cached = (!mentionsProduct && !sentWelcome) ? getCachedReply(text) : null;
  
  if (cached) {
    await sendMessage(chatId, cached);
    saveChatMessage(chatId, "Bot", "bot", cached);
  } else {
    // 5) Gemini AI
    await sendTyping(chatId);
    const reply = await generateReply(chatId, text, from.display_name);
    await sendMessage(chatId, reply);
    saveChatMessage(chatId, "Bot", "bot", reply);
  }

  // 6) Gửi ảnh sản phẩm theo từ khóa (có thể gửi kèm sau reply)
  if (getPhotoUrl) {
    const captions = getPhotoCaptions();
    const keywords = getKeywords();
    if (matchKeywords(text, keywords.greeting)) {
      await sendPhoto(chatId, getPhotoUrl("banner"), captions.banner);
    } else if (matchKeywords(text, keywords.price)) {
      await sendPhoto(chatId, getPhotoUrl("product"), captions.product);
    } else if (matchKeywords(text, keywords.promo)) {
      await sendPhoto(chatId, getPhotoUrl("promo"), captions.promo);
    } else if (matchKeywords(text, keywords.image)) {
      await sendPhoto(chatId, getPhotoUrl("product"), captions.product);
    }
  }
}

async function handleFollowEvent(chatId, getPhotoUrl) {
  const welcomeMsg = getWelcomeMessage(null); // Gửi lời chào chung chung nếu chưa có tên
  await sendMessage(chatId, welcomeMsg);
  saveChatMessage(chatId, "Bot", "bot", welcomeMsg);

  if (getPhotoUrl) {
    const captions = getPhotoCaptions();
    await sendPhoto(chatId, getPhotoUrl("banner"), captions.banner);
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
    if (chatId) await sendMessage(chatId, getReplies().image);
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
    }
  });
  chatLocks.set(chatId, currentTask);
  currentTask.finally(() => { if (chatLocks.get(chatId) === currentTask) chatLocks.delete(chatId); });
}

module.exports = { handleTextMessage, handleImageMessage, handleStickerMessage, handleFollowEvent };
