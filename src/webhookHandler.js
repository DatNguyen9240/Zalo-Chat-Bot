const { WEBHOOK_SECRET } = require("./config");
const { PRODUCT_IMAGES } = require("./constants");
const { handleTextMessage, handleImageMessage, handleStickerMessage } = require("./messageHandler");
const log = require("./logger");

// ============================================================
// Webhook deduplication — tránh Zalo retry gửi 2 lần cùng event
// ============================================================
const processedMessages = new Map(); // msgId -> timestamp
const DEDUP_TTL = 60 * 1000; // 60 giây

function isDuplicate(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  // Dọn dẹp entries cũ
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL) processedMessages.delete(id);
  }
  if (processedMessages.has(msgId)) {
    log.warn(`⚠️ Duplicate webhook skipped: ${msgId}`);
    return true;
  }
  processedMessages.set(msgId, now);
  return false;
}

// Lấy base URL từ request (ngrok URL)
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  return `${proto}://${host}`;
}

function setupWebhook(app) {
  app.post("/webhook", (req, res) => {
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

    if (!event_name) {
      return res.sendStatus(200);
    }

    // ✅ Trả 200 NGAY LẬP TỨC — Zalo không phải chờ bot xử lý xong
    res.sendStatus(200);

    // Deduplication — bỏ qua nếu đã xử lý message này rồi
    const msgId = message?.msg_id;
    if (isDuplicate(msgId)) return;

    // Xử lý message bất đồng bộ (không block webhook response)
    const chatId = message?.chat?.id;
    const from = message?.from;

    log.info(`📩 [${event_name}] ${from?.display_name || "Unknown"}`);

    processWebhookEvent(event_name, message, chatId, from, req).catch((err) => {
      log.error(`Webhook processing error: ${err.message}`);
    });
  });
}

// Xử lý event bất đồng bộ — chạy sau khi đã trả 200
async function processWebhookEvent(event_name, message, chatId, from, req) {
  switch (event_name) {
    case "message.text.received": {
      const text = message?.text;
      if (chatId && text && !from?.is_bot) {
        const baseUrl = getBaseUrl(req);
        const getPhotoUrl = (type) => baseUrl + PRODUCT_IMAGES[type];
        await handleTextMessage(chatId, from, text, getPhotoUrl);
      }
      break;
    }

    case "message.image.received":
      await handleImageMessage(chatId);
      break;

    case "message.sticker.received":
      await handleStickerMessage(chatId, message);
      break;

    case "message.unsupported.received":
      // Không reply — tránh gửi tin nhắn thừa
      break;

    default:
      log.debug(`Unhandled: ${event_name}`);
  }
}

module.exports = { setupWebhook };
