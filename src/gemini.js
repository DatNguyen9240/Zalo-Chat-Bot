const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GEMINI_API_KEY, GEMINI_MODEL } = require("./config");
const { SYSTEM_PROMPT, SESSION_TTL, REPLIES, PRODUCTS } = require("./constants");
const { enqueue } = require("./queue");
const { saveOrder } = require("./database");
const { trackEvent } = require("./database");
const log = require("./logger");

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const PRODUCTS_TEXT = PRODUCTS.map(
  (p) => `- ${p.name}: ${p.price.toLocaleString("vi-VN")}đ`
).join("\n");

// ============================================================
// Function calling — AI gọi khi đủ info đặt hàng
// ============================================================
const ORDER_TOOL = {
  functionDeclarations: [
    {
      name: "create_order",
      description:
        "Tạo đơn hàng khi đã thu thập đủ thông tin từ khách: sản phẩm, số lượng, họ tên, SĐT, địa chỉ. " +
        "CHỈ GỌI KHI ĐÃ CÓ ĐẦY ĐỦ 5 THÔNG TIN. Nếu thiếu bất kỳ thông tin nào, hãy hỏi khách trước.",
      parameters: {
        type: "object",
        properties: {
          product: {
            type: "string",
            description: "Tên sản phẩm (Trà Lài 100g, Trà Lài 250g, hoặc Trà Lài 500g)",
            enum: PRODUCTS.map((p) => p.name),
          },
          quantity: {
            type: "integer",
            description: "Số lượng gói",
          },
          customer_name: {
            type: "string",
            description: "Họ tên người nhận hàng",
          },
          phone: {
            type: "string",
            description: "Số điện thoại nhận hàng (VD: 0901234567)",
          },
          address: {
            type: "string",
            description: "Địa chỉ giao hàng",
          },
        },
        required: ["product", "quantity", "customer_name", "phone", "address"],
      },
    },
  ],
};

// ============================================================
// Model config với function calling
// ============================================================
const model = genAI.getGenerativeModel({
  model: GEMINI_MODEL,
  tools: [ORDER_TOOL],
});

// Load tất cả file .txt từ data/
let knowledge = "";
const dataDir = path.join(__dirname, "..", "data");
try {
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".txt"));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dataDir, file), "utf-8");
    knowledge += content + "\n\n";
    log.info(`📚 Loaded: ${file} (${content.length} chars)`);
  }
  if (!knowledge) log.warn("Không tìm thấy file .txt trong data/");
} catch {
  log.warn("Không tìm thấy thư mục data/ — bot trả lời chung chung");
}

// System instruction kèm order instructions
const SYSTEM_INSTRUCTION = {
  parts: [
    {
      text:
        SYSTEM_PROMPT +
        "\n\n" +
        "## Hướng dẫn đặt hàng\n" +
        "Khi khách muốn đặt hàng/mua hàng, hãy:\n" +
        "1. Hỏi khách muốn mua sản phẩm nào (nếu chưa nói)\n" +
        "2. Hỏi số lượng (nếu chưa nói)\n" +
        "3. Hỏi họ tên người nhận\n" +
        "4. Hỏi SĐT\n" +
        "5. Hỏi địa chỉ giao hàng\n" +
        "Khi ĐÃ CÓ ĐỦ 5 thông tin trên, gọi function create_order.\n" +
        "Khách có thể cung cấp nhiều thông tin cùng lúc — hãy tự extract.\n" +
        "Nếu khách nói sai tên sản phẩm, gợi ý đúng tên.\n\n" +
        "## Menu sản phẩm\n" +
        PRODUCTS_TEXT +
        "\n\n" +
        (knowledge
          ? `## Tài liệu tham khảo\n${knowledge}`
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

// Retry logic cho 429
async function callWithRetry(fn, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const is429 =
        err.message?.includes("429") ||
        err.message?.includes("Too Many Requests");
      if (is429 && i < retries) {
        const delay = [5000, 15000, 30000][i] || 30000;
        log.warn(`Gemini 429 — retry ${i + 1}/${retries} sau ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// ============================================================
// Xử lý function call từ Gemini
// ============================================================
function handleFunctionCall(functionCall, chatId, displayName) {
  if (functionCall.name === "create_order") {
    const args = functionCall.args;

    // Tìm sản phẩm
    const product = PRODUCTS.find((p) => p.name === args.product);
    if (!product) {
      return { result: { error: "Sản phẩm không tìm thấy" } };
    }

    const totalPrice = product.price * args.quantity;

    // Lưu vào DB
    const orderId = saveOrder({
      chatId,
      displayName,
      product: product.name,
      quantity: args.quantity,
      totalPrice,
      customerName: args.customer_name,
      phone: args.phone,
      address: args.address,
    });

    trackEvent("order_created", chatId);

    // Gửi lên Google Sheets (async)
    const { sendToGoogleSheet } = require("./order");
    sendToGoogleSheet({
      orderId,
      displayName,
      product: product.name,
      quantity: args.quantity,
      totalPrice,
      customerName: args.customer_name,
      phone: args.phone,
      address: args.address,
    });

    return {
      result: {
        success: true,
        orderId,
        product: product.name,
        quantity: args.quantity,
        totalPrice,
        customerName: args.customer_name,
        phone: args.phone,
        address: args.address,
      },
    };
  }

  return { result: { error: "Function không hợp lệ" } };
}

// ============================================================
// Generate Reply — hỗ trợ function calling
// ============================================================
async function generateReply(chatId, messageText, displayName = "Khách") {
  return enqueue(async () => {
    try {
      log.debug(`🧠 Generating reply for ${chatId}...`);
      const chat = getOrCreateChat(chatId);

      const timeoutMs = 30000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs)
      );

      let result = await callWithRetry(() =>
        Promise.race([chat.sendMessage(messageText), timeoutPromise])
      );

      let response = result.response;

      // Kiểm tra function call
      const functionCalls = response.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        const fc = functionCalls[0];
        log.info(`🔧 Function call: ${fc.name}(${JSON.stringify(fc.args)})`);

        // Thực thi function
        const functionResult = handleFunctionCall(fc, chatId, displayName);

        // Gửi kết quả về Gemini để nó tạo phản hồi cho user
        result = await callWithRetry(() =>
          Promise.race([
            chat.sendMessage([
              {
                functionResponse: {
                  name: fc.name,
                  response: functionResult,
                },
              },
            ]),
            timeoutPromise,
          ])
        );
        response = result.response;
      }

      const reply = response.text();
      log.debug(`🧠 Reply: ${reply.substring(0, 80)}...`);
      return reply;
    } catch (err) {
      if (err.message === "Gemini timeout") {
        log.error("Gemini timeout — quá 30s không phản hồi");
        return "Xin lỗi, tôi đang xử lý chậm. Vui lòng thử lại! 🙏";
      }
      log.error("Gemini error:", err.message);
      return REPLIES.error;
    }
  });
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
