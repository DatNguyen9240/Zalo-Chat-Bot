const { LOG_LEVEL } = require("./config");

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] ?? 1;

const logger = {
  debug: (...args) => currentLevel <= 0 && console.log("🔍", ...args),
  info: (...args) => currentLevel <= 1 && console.log("ℹ️", ...args),
  warn: (...args) => currentLevel <= 2 && console.warn("⚠️", ...args),
  error: (...args) => currentLevel <= 3 && console.error("❌", ...args),
};

module.exports = logger;
