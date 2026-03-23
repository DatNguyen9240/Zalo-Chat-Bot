const { WEBHOOK_SECRET } = require("./config");
const { PRODUCT_IMAGES } = require("./constants");
const { handleTextMessage, handleFollowEvent, handleImageMessage, handleStickerMessage } = require("./messageHandler");
const log = require("./logger");

// Lấy base URL từ request (ngrok URL)
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  return `${proto}://${host}`;
}

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

    if (!event_name) {
      return res.sendStatus(200);
    }

    const chatId = message?.chat?.id;
    const from = message?.from;

    log.info(`📩 [${event_name}] ${from?.display_name || "Unknown"}`);

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

      // User mới follow hoặc bắt đầu chat → gửi lời chào
      case "user.followed":
      case "user.started": {
        const followChatId = message?.chat?.id || data?.chat?.id;
        const followFrom = message?.from || data?.from;
        if (followChatId) {
          await handleFollowEvent(followChatId, followFrom);
        }
        break;
      }

      default:
        log.debug(`Unhandled: ${event_name}`);
    }

    res.sendStatus(200);
  });
}

module.exports = { setupWebhook };
