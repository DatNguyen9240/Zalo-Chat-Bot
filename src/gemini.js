const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GEMINI_API_KEY, GEMINI_MODEL } = require("./config");
const { SYSTEM_PROMPT, SESSION_TTL, REPLIES } = require("./constants");
const log = require("./logger");

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

// Load tài liệu từ data/knowledge.txt
let knowledge = "";
const knowledgePath = path.join(__dirname, "..", "data", "knowledge.txt");
try {
  knowledge = fs.readFileSync(knowledgePath, "utf-8");
  log.info(`📚 Loaded knowledge (${knowledge.length} chars)`);
} catch {
  log.warn("Không tìm thấy data/knowledge.txt — bot trả lời chung chung");
}

// System instruction cho Gemini
const SYSTEM_INSTRUCTION = {
  parts: [
    {
      text:
        SYSTEM_PROMPT +
        "\n\n" +
        (knowledge
          ? `Dưới đây là tài liệu tham khảo của công ty, hãy dựa vào đây để trả lời:\n\n${knowledge}`
          : ""),
    },
  ],
};

// Chat session management
const chatSessions = new Map();
const sessionTimers = new Map();

function getOrCreateChat(chatId) {
  if (sessionTimers.has(chatId)) {
    clearTimeout(sessionTimers.get(chatId));
  }
  sessionTimers.set(
    chatId,
    setTimeout(() => {
      chatSessions.delete(chatId);
      sessionTimers.delete(chatId);
      log.debug(`🗑️ Session expired: ${chatId}`);
    }, SESSION_TTL)
  );

  let chat = chatSessions.get(chatId);
  if (!chat) {
    chat = model.startChat({
      systemInstruction: SYSTEM_INSTRUCTION,
      history: [],
    });
    chatSessions.set(chatId, chat);
  }
  return chat;
}

// Retry logic cho Gemini 429
async function callWithRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const is429 =
        err.message?.includes("429") ||
        err.message?.includes("Too Many Requests");
      if (is429 && i < retries) {
        const delay = Math.pow(2, i + 1) * 1000;
        log.warn(`Gemini 429 — retry ${i + 1}/${retries} sau ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

async function generateReply(chatId, messageText) {
  try {
    log.debug(`🧠 Generating reply for ${chatId}...`);
    const chat = getOrCreateChat(chatId);
    const result = await callWithRetry(() => chat.sendMessage(messageText));
    const reply = result.response.text();
    log.debug(`🧠 Reply: ${reply.substring(0, 80)}...`);
    return reply;
  } catch (err) {
    log.error("Gemini error:", err.message);
    return REPLIES.error;
  }
}

function getSessionCount() {
  return chatSessions.size;
}

function cleanup() {
  for (const timer of sessionTimers.values()) {
    clearTimeout(timer);
  }
  sessionTimers.clear();
  chatSessions.clear();
  log.info("🧹 Sessions cleaned up");
}

module.exports = { generateReply, getSessionCount, cleanup };
