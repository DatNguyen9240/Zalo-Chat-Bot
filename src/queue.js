const log = require("./logger");

/**
 * Request Queue để giới hạn số lượng request Gemini chạy đồng thời.
 * Tránh lỗi 429 và quá tải server.
 */
const MAX_CONCURRENT = 3;
let activeCount = 0;
const queue = [];

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        activeCount--;
        processNext();
      }
    };

    if (activeCount < MAX_CONCURRENT) {
      activeCount++; // Tăng ngay lập tức để tránh race condition
      task();
    } else {
      log.debug(`📋 Queue: ${queue.length + 1} đang chờ (${activeCount} đang chạy)`);
      queue.push(task);
    }
  });
}

function processNext() {
  while (queue.length > 0 && activeCount < MAX_CONCURRENT) {
    activeCount++;
    const next = queue.shift();
    next();
  }
}

function getQueueInfo() {
  return { active: activeCount, waiting: queue.length };
}

module.exports = { enqueue, getQueueInfo };
