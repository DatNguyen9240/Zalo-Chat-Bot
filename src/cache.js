const { CACHE_ENTRIES } = require("./constants");
const log = require("./logger");

/**
 * Tìm câu trả lời cache phù hợp
 * @param {string} text - Tin nhắn user
 * @returns {string|null} - Câu trả lời cache hoặc null nếu không khớp
 */
function getCachedReply(text) {
  const lower = text.toLowerCase();

  for (const entry of CACHE_ENTRIES) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      log.debug(`⚡ Cache hit: "${text.substring(0, 30)}..."`);
      return entry.reply;
    }
  }

  return null;
}

module.exports = { getCachedReply };
