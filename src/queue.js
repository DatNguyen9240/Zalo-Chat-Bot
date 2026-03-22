const log = require("./logger");

// Simple request queue để tránh Gemini quá tải
// Giới hạn số request đồng thời
const MAX_CONCURRENT = 3;
let activeCount = 0;
const queue = [];

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      activeCount++;
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
      task();
    } else {
      log.debug(`📋 Queue: ${queue.length + 1} waiting (${activeCount} active)`);
      queue.push(task);
    }
  });
}

function processNext() {
  if (queue.length > 0 && activeCount < MAX_CONCURRENT) {
    const next = queue.shift();
    next();
  }
}

function getQueueInfo() {
  return { active: activeCount, waiting: queue.length };
}

module.exports = { enqueue, getQueueInfo };
