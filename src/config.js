require("dotenv").config();

const {
  PORT,
  BOT_TOKEN,
  BOT_MODE,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  WEBHOOK_SECRET,
  LOG_LEVEL,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW,
} = process.env;

if (!BOT_TOKEN) throw new Error("❌ Missing BOT_TOKEN in .env");
if (!GEMINI_API_KEY) throw new Error("❌ Missing GEMINI_API_KEY in .env");

const BOT_API = `https://bot-api.zaloplatforms.com/bot${BOT_TOKEN}`;

module.exports = {
  PORT: PORT || 3000,
  BOT_TOKEN,
  BOT_MODE: BOT_MODE || "webhook", // "webhook" | "polling"
  GEMINI_API_KEY,
  GEMINI_MODEL: GEMINI_MODEL || "gemini-2.5-flash",
  WEBHOOK_SECRET,
  BOT_API,
  LOG_LEVEL: LOG_LEVEL || "info", // "debug" | "info" | "warn" | "error"
  RATE_LIMIT_MAX: parseInt(RATE_LIMIT_MAX) || 10, // Số tin nhắn tối đa
  RATE_LIMIT_WINDOW: parseInt(RATE_LIMIT_WINDOW) || 60000, // Trong khoảng thời gian (ms)
};
