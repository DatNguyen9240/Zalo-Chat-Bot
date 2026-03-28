const { WEBHOOK_SECRET } = require("./config");
const { getProductImages } = require("./constants");
const { handleTextMessage, handleImageMessage, handleStickerMessage, handleFollowEvent } = require("./messageHandler");
const { trackEvent } = require("./database");
const log = require("./logger");

// ============================================================
// Webhook deduplication — tránh Zalo retry gửi 2 lần cùng event
// ============================================================
const processedMessages = new Map(); // msgId -> timestamp
const DEDUP_TTL = 60 * 1000; // 60 giây

function isDuplicate(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  // Logic dọn dẹp đã được chuyển sang setInterval định kỳ
  if (processedMessages.has(msgId)) {
    log.warn(`⚠️ Duplicate webhook skipped: ${msgId}`);
    return true;
  }
  processedMessages.set(msgId, now);
  return false;
}

// Cleanup định kỳ mỗi 5 phút (thay vì lặp trên mỗi request)
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL) processedMessages.delete(id);
  }
}, 5 * 60 * 1000);

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
    const { event_name } = data;

    if (!event_name) {
      return res.sendStatus(200);
    }

    // ✅ Trả 200 NGAY LẬP TỨC
    res.sendStatus(200);

    // Deduplication
    const msgId = data.message?.msg_id || data.msg_id || data.timestamp;
    if (isDuplicate(msgId)) return;

    // Lấy thông tin cơ bản
    const chatId = data.message?.chat?.id || data.follower?.id || data.user_id;
    const from = data.message?.from || data.follower;

    log.info(`📩 [${event_name}] ${from?.display_name || chatId || "User"}`);

    processWebhookEvent(event_name, data, chatId, from, req).catch((err) => {
      log.error(`Webhook processing error: ${err.message}`);
    });
  });
}

// Xử lý event bất đồng bộ — chạy sau khi đã trả 200
async function processWebhookEvent(event_name, payload, chatId, from, req) {
  switch (event_name) {
    case "message.text.received": {
      const text = payload.message?.text;
      if (chatId && text && !from?.is_bot) {
        const baseUrl = getBaseUrl(req);
        const getPhotoUrl = (type) => {
          const img = getProductImages()[type];
          return (img && img.startsWith("http")) ? img : baseUrl + img;
        };
        await handleTextMessage(chatId, from, text, getPhotoUrl);
      }
      break;
    }

    case "message.image.received":
      await handleImageMessage(chatId);
      break;

    case "message.sticker.received":
      await handleStickerMessage(chatId, payload.message);
      break;

    case "oa.follow": {
      const followerId = payload.follower?.id || chatId;
      if (followerId) {
        log.info(`👥 New follower: ${followerId}`);
        trackEvent("oa_follow", followerId);
        const baseUrl = getBaseUrl(req);
        const getPhotoUrl = (type) => {
          const img = getProductImages()[type];
          return (img && img.startsWith("http")) ? img : baseUrl + img;
        };
        await handleFollowEvent(followerId, getPhotoUrl);
      }
      break;
    }

    case "oa.unfollow": {
      const followerId = payload.follower?.id || chatId;
      if (followerId) {
        log.info(`👋 Lost follower: ${followerId}`);
        trackEvent("oa_unfollow", followerId);
      }
      break;
    }

    case "message.unsupported.received":
      // Không reply — tránh gửi tin nhắn thừa
      break;

    default:
      log.debug(`Unhandled: ${event_name}`);
  }
}

module.exports = { setupWebhook };
