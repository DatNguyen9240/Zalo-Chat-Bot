const { getCacheEntries } = require("./constants");
const log = require("./logger");

/**
 * Tìm câu trả lời cache phù hợp
 */
function getCachedReply(text) {
  const lower = text.toLowerCase();
  const cacheEntries = getCacheEntries();

  for (const entry of cacheEntries) {
    if (entry.keywords.some((kw) => lower.includes(kw))) {
      log.debug(`⚡ Cache hit: "${text.substring(0, 30)}..."`);
      return entry.reply;
    }
  }

  return null;
}

module.exports = { getCachedReply };
