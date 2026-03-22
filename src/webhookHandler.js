const { WEBHOOK_SECRET, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW } = require("./config");
const { KEYWORDS, PHOTO_CAPTIONS, REPLIES, PRODUCT_IMAGES, matchKeywords } = require("./constants");
const { generateReply } = require("./gemini");
const { sendMessage, sendPhoto, sendSticker, sendTyping } = require("./zaloBot");
const log = require("./logger");

// Lấy base URL từ request (ngrok URL)
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  return `${proto}://${host}`;
}

// Rate limiter per user
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

function setupWebhook(app) {
  app.post("/webhook", async (req, res) => {
    const body = req.body;

    // Xác thực secret token
    if (WEBHOOK_SECRET) {
      const token = req.headers["x-bot-api-secret-token"];
      if (token !== WEBHOOK_SECRET) {
        log.warn("Invalid secret token");
        return res.sendStatus(403);
      }
    }

    // Hỗ trợ cả 2 format webhook
    const data = body.result || body;
    const { event_name, message } = data;

    if (!event_name || !message) {
      return res.sendStatus(200);
    }

    const chatId = message?.chat?.id;
    const from = message?.from;

    log.info(`📩 [${event_name}] ${from?.display_name || "Unknown"}`);

    switch (event_name) {
      case "message.text.received": {
        const text = message?.text;
        if (chatId && text && !from?.is_bot) {
          log.info(`💬 ${from.display_name}: ${text}`);

          if (isRateLimited(chatId)) {
            await sendMessage(chatId, REPLIES.rateLimited);
            break;
          }

          await sendTyping(chatId);
          const reply = await generateReply(chatId, text);
          await sendMessage(chatId, reply);

          // Gửi ảnh sản phẩm theo từ khóa
          const baseUrl = getBaseUrl(req);
          if (matchKeywords(text, KEYWORDS.greeting)) {
            await sendPhoto(chatId, baseUrl + PRODUCT_IMAGES.banner, PHOTO_CAPTIONS.banner);
          } else if (matchKeywords(text, KEYWORDS.price)) {
            await sendPhoto(chatId, baseUrl + PRODUCT_IMAGES.product, PHOTO_CAPTIONS.product);
          } else if (matchKeywords(text, KEYWORDS.promo)) {
            await sendPhoto(chatId, baseUrl + PRODUCT_IMAGES.promo, PHOTO_CAPTIONS.promo);
          }
        }
        break;
      }

      case "message.image.received":
        if (chatId) await sendMessage(chatId, REPLIES.image);
        break;

      case "message.sticker.received": {
        const stickerId = message?.sticker;
        if (chatId) {
          if (stickerId) {
            await sendSticker(chatId, stickerId);
          } else {
            await sendMessage(chatId, REPLIES.sticker);
          }
        }
        break;
      }

      case "message.unsupported.received":
        if (chatId) await sendMessage(chatId, REPLIES.unsupported);
        break;

      default:
        log.debug(`Unhandled: ${event_name}`);
    }

    res.sendStatus(200);
  });
}

module.exports = { setupWebhook };
