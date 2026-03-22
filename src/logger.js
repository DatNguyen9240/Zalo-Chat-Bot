const path = require("path");
const winston = require("winston");
require("winston-daily-rotate-file");
const { LOG_LEVEL } = require("./config");

const logDir = path.join(__dirname, "..", "logs");

// Format log
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
  })
);

// Format cho console (giữ emoji như cũ)
const consoleFormat = winston.format.combine(
  winston.format.printf(({ level, message }) => {
    const icons = { debug: "🔍", info: "ℹ️", warn: "⚠️", error: "❌" };
    return `${icons[level] || ""} ${message}`;
  })
);

const logger = winston.createLogger({
  level: LOG_LEVEL,
  transports: [
    // Console output (giống logger cũ)
    new winston.transports.Console({ format: consoleFormat }),

    // File log xoay vòng hàng ngày
    new winston.transports.DailyRotateFile({
      dirname: logDir,
      filename: "bot-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "10m",
      maxFiles: "14d", // Giữ log 14 ngày
      format: logFormat,
    }),

    // File riêng cho errors
    new winston.transports.DailyRotateFile({
      dirname: logDir,
      filename: "error-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "10m",
      maxFiles: "30d", // Giữ errors 30 ngày
      level: "error",
      format: logFormat,
    }),
  ],
});

module.exports = logger;
