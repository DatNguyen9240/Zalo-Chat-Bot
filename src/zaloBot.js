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
      if (!res.data.ok) {
        const ec = res.data.error_code;
        // -32 = rate limit, -1 = system error
        if (ec === -32 || ec === -1) {
          if (i < retries) {
            const delay = (i + 1) * 2000;
            log.warn(`⏳ Zalo error ${ec} — retry ${i + 1}/${retries} sau ${delay}ms`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        }
        // Các mã lỗi vĩnh viễn (như 111: chưa quan tâm OA) thì không retry
        return res;
      }
      return res;
    } catch (err) {
      const isNetworkError = !err.response && (err.code === "ETIMEDOUT" || err.code === "ECONNABORTED" || err.code === "ECONNRESET" || err.code === "ENOTFOUND");
      if ((err.response?.status === 429 || isNetworkError) && i < retries) {
        const delay = (i + 1) * 2000;
        log.warn(`⏳ Zalo ${err.code || "429"} — retry ${i + 1}/${retries} sau ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// Chia tin nhắn dài thành nhiều phần
function splitMessage(text, maxLen = MAX_MESSAGE_LENGTH) {
  if (!text || text.trim().length === 0) return [];
  if (text.length <= maxLen) return [text.trim()];

  const parts = [];
  let remaining = text.trim();

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

  return parts.filter(p => p.length > 0);
}

async function sendMessage(chatId, text) {
  try {
    const parts = splitMessage(text);
    if (parts.length === 0) return;

    for (let i = 0; i < parts.length; i++) {
      const res = await zaloRetry(() =>
        axios.post(`${BOT_API}/sendMessage`, {
          chat_id: chatId,
          text: parts[i],
        }, { timeout: 10000 })
      );

      if (!res) {
        log.error(`❌ sendMessage failed [${chatId}]: No response after retries`);
        continue;
      }

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
    if (caption) {
      body.caption = caption.toString().substring(0, 1000);
    }

    const res = await zaloRetry(() =>
      axios.post(`${BOT_API}/sendPhoto`, body, { timeout: 15000 })
    );

    if (!res) {
      log.error(`❌ sendPhoto failed [${chatId}]: No response after retries`);
      return null;
    }

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
    const res = await zaloRetry(() =>
      axios.post(`${BOT_API}/sendSticker`, {
        chat_id: chatId,
        sticker: stickerId,
      }, { timeout: 10000 })
    );

    if (!res) {
      log.error(`❌ sendSticker failed [${chatId}]: No response after retries`);
      return null;
    }

    if (res.data.ok) {
      log.info(`🎭 Sticker sent to ${chatId}`);
    } else {
      log.error("sendSticker failed:", JSON.stringify(res.data));
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
    }, { timeout: 5000 });
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
