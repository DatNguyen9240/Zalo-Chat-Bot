const axios = require("axios");
const { BOT_API } = require("./config");
const { MAX_MESSAGE_LENGTH } = require("./constants");
const log = require("./logger");

// Retry helper cho Zalo API (rate limit / lỗi tạm)
async function zaloRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fn();
      // Zalo trả ok=false nhưng HTTP 200 — kiểm tra error code
      if (!res.data.ok && res.data.error_code === -32) {
        // -32 = rate limit từ Zalo
        if (i < retries) {
          const delay = (i + 1) * 1000; // 1s, 2s
          log.warn(`⏳ Zalo rate limit — retry ${i + 1}/${retries} sau ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      return res;
    } catch (err) {
      if (err.response?.status === 429 && i < retries) {
        const delay = (i + 1) * 2000;
        log.warn(`⏳ Zalo 429 — retry ${i + 1}/${retries} sau ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// Chia tin nhắn dài thành nhiều phần
function splitMessage(text, maxLen = MAX_MESSAGE_LENGTH) {
  if (text.length <= maxLen) return [text];

  const parts = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }

    let cutAt = remaining.lastIndexOf("\n", maxLen);
    if (cutAt < maxLen * 0.5) cutAt = remaining.lastIndexOf(". ", maxLen);
    if (cutAt < maxLen * 0.5) cutAt = remaining.lastIndexOf(" ", maxLen);
    if (cutAt < maxLen * 0.5) cutAt = maxLen;

    parts.push(remaining.substring(0, cutAt + 1).trim());
    remaining = remaining.substring(cutAt + 1).trim();
  }

  return parts;
}

async function sendMessage(chatId, text) {
  try {
    const parts = splitMessage(text);

    for (let i = 0; i < parts.length; i++) {
      const res = await zaloRetry(() =>
        axios.post(`${BOT_API}/sendMessage`, {
          chat_id: chatId,
          text: parts[i],
        })
      );

      if (res.data.ok) {
        log.info(`✅ Sent (${i + 1}/${parts.length}): "${parts[i].substring(0, 50)}..."`);
      } else {
        log.error(`❌ sendMessage failed [${chatId}]:`, JSON.stringify(res.data, null, 2));
      }

      if (i < parts.length - 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  } catch (err) {
    log.error("sendMessage failed:", err.response?.data || err.message);
  }
}


async function sendPhoto(chatId, photoUrl, caption = "") {
  try {
    const body = { chat_id: chatId, photo: photoUrl };
    if (caption) body.caption = caption;

    const res = await zaloRetry(() =>
      axios.post(`${BOT_API}/sendPhoto`, body)
    );

    if (res.data.ok) {
      log.info(`📷 Photo sent to ${chatId}`);
    } else {
      log.error(`❌ sendPhoto failed [${chatId}]:`, JSON.stringify(res.data, null, 2));
    }
    return res.data;
  } catch (err) {
    log.error("sendPhoto failed:", err.response?.data || err.message);
  }
}

async function sendSticker(chatId, stickerId) {
  try {
    const res = await axios.post(`${BOT_API}/sendSticker`, {
      chat_id: chatId,
      sticker: stickerId,
    });

    if (res.data.ok) {
      log.info(`🎭 Sticker sent to ${chatId}`);
    } else {
      log.error("sendSticker:", JSON.stringify(res.data));
    }
    return res.data;
  } catch (err) {
    log.error("sendSticker failed:", err.response?.data || err.message);
  }
}

async function sendTyping(chatId) {
  try {
    await axios.post(`${BOT_API}/sendChatAction`, {
      chat_id: chatId,
      action: "typing",
    });
  } catch {
    // Non-critical
  }
}

async function registerWebhook(url, secretToken) {
  try {
    const params = { url };
    if (secretToken) params.secret_token = secretToken;

    const res = await axios.post(`${BOT_API}/setWebhook`, params);
    if (res.data.ok) {
      log.info(`✅ Webhook registered: ${url}`);
    } else {
      log.error("setWebhook:", JSON.stringify(res.data));
    }
    return res.data;
  } catch (err) {
    log.error("setWebhook failed:", err.response?.data || err.message);
  }
}

async function deleteWebhook() {
  try {
    const res = await axios.post(`${BOT_API}/deleteWebhook`, {});
    if (res.data.ok) {
      log.info("✅ Webhook deleted — ready for polling");
    } else {
      log.error("deleteWebhook:", JSON.stringify(res.data));
    }
    return res.data;
  } catch (err) {
    log.error("deleteWebhook failed:", err.response?.data || err.message);
  }
}

async function getWebhookInfo() {
  try {
    const res = await axios.post(`${BOT_API}/getWebhookInfo`, {});
    if (res.data.ok) {
      const info = res.data.result;
      if (info.url) {
        log.info(`🔗 Webhook URL: ${info.url}`);
      } else {
        log.info("🔗 Webhook: chưa đăng ký");
      }
      return info;
    } else {
      log.error("getWebhookInfo:", JSON.stringify(res.data));
    }
  } catch (err) {
    log.error("getWebhookInfo failed:", err.response?.data || err.message);
  }
  return null;
}

async function getMe() {
  try {
    const res = await axios.post(`${BOT_API}/getMe`, {});
    if (res.data.ok) {
      const bot = res.data.result;
      log.info(`🤖 Bot verified: ${bot.account_name} (${bot.account_type})`);
      return bot;
    } else {
      log.error("getMe:", JSON.stringify(res.data));
    }
  } catch (err) {
    log.error("getMe failed — kiểm tra lại BOT_TOKEN:", err.response?.data || err.message);
  }
  return null;
}

module.exports = { sendMessage, sendPhoto, sendSticker, sendTyping, registerWebhook, deleteWebhook, getWebhookInfo, getMe };
