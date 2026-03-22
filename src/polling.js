const axios = require("axios");
const { BOT_API } = require("./config");
const { KEYWORDS, PHOTO_CAPTIONS, REPLIES, PRODUCT_IMAGES_PLACEHOLDER, matchKeywords } = require("./constants");
const { generateReply } = require("./gemini");
const { sendMessage, sendPhoto, sendSticker, sendTyping } = require("./zaloBot");
const { saveChatMessage, trackEvent } = require("./database");
const log = require("./logger");

// Xử lý 1 update event
async function handleUpdate(update) {
  const { event_name, message } = update;

  if (!event_name || !message) return;

  const chatId = message?.chat?.id;
  const from = message?.from;

  log.info(`📩 [${event_name}] ${from?.display_name || "Unknown"}`);

  switch (event_name) {
    case "message.text.received": {
      const text = message?.text;
      if (chatId && text && !from?.is_bot) {
        log.info(`💬 ${from.display_name}: ${text}`);

        trackEvent("message", chatId);
        saveChatMessage(chatId, from.display_name, "user", text);

        await sendTyping(chatId);
        const reply = await generateReply(chatId, text);
        await sendMessage(chatId, reply);

        saveChatMessage(chatId, "Bot", "bot", reply);

        // Gửi ảnh sản phẩm theo từ khóa
        if (matchKeywords(text, KEYWORDS.greeting)) {
          await sendPhoto(chatId, PRODUCT_IMAGES_PLACEHOLDER.banner, PHOTO_CAPTIONS.banner);
          trackEvent("photo_sent", chatId);
        } else if (matchKeywords(text, KEYWORDS.price)) {
          await sendPhoto(chatId, PRODUCT_IMAGES_PLACEHOLDER.product, PHOTO_CAPTIONS.product);
          trackEvent("photo_sent", chatId);
        } else if (matchKeywords(text, KEYWORDS.promo)) {
          await sendPhoto(chatId, PRODUCT_IMAGES_PLACEHOLDER.promo, PHOTO_CAPTIONS.promo);
          trackEvent("photo_sent", chatId);
        }
      }
      break;
    }

    case "message.image.received":
      trackEvent("image_received", chatId);
      if (chatId) await sendMessage(chatId, REPLIES.image);
      break;

    case "message.sticker.received": {
      trackEvent("sticker_received", chatId);
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
      trackEvent("unsupported", chatId);
      if (chatId) await sendMessage(chatId, REPLIES.unsupported);
      break;

    default:
      log.debug(`Unhandled: ${event_name}`);
  }
}

// Long polling loop
let isRunning = false;
let lastUpdateId = 0;

async function startPolling() {
  isRunning = true;
  log.info("🔄 Polling mode started (getUpdates)");

  while (isRunning) {
    try {
      const res = await axios.post(`${BOT_API}/getUpdates`, {
        timeout: 30,
        offset: lastUpdateId,
      });

      if (res.data.ok && res.data.result?.length > 0) {
        for (const update of res.data.result) {
          await handleUpdate(update);
          if (update.update_id) {
            lastUpdateId = update.update_id + 1;
          }
        }
      }
    } catch (err) {
      if (err.code === "ECONNABORTED") {
        continue;
      }
      log.error("Polling error:", err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function stopPolling() {
  isRunning = false;
  log.info("🔄 Polling stopped");
}

module.exports = { startPolling, stopPolling };
