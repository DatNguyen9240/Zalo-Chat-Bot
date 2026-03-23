const axios = require("axios");
const { BOT_API } = require("./config");
const { PRODUCT_IMAGES_PLACEHOLDER } = require("./constants");
const { handleTextMessage, handleImageMessage, handleStickerMessage } = require("./messageHandler");
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
        const getPhotoUrl = (type) => PRODUCT_IMAGES_PLACEHOLDER[type];
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
