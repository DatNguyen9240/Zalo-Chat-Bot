const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GEMINI_API_KEY, GEMINI_MODEL } = require("./config");
const { getSystemPrompt, SESSION_TTL, getReplies, getProducts, getShippingZones, getSettings } = require("./constants");
const { enqueue } = require("./queue");
const { createPendingOrder } = require("./order");
const { trackEvent } = require("./database");
const log = require("./logger");

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Cache model instances by their "signature" (product list) to avoid redundant genAI calls
const modelCache = new Map();

function getDynamicModel() {
  const products = getProducts();
  const productKey = products.map(p => `${p.name}:${p.price}`).join("|");
  
  if (modelCache.has(productKey)) {
    return modelCache.get(productKey);
  }

  // Giới hạn số lượng model trong cache (tránh memory leak nếu product list đổi liên tục)
  if (modelCache.size > 50) {
    const firstKey = modelCache.keys().next().value;
    modelCache.delete(firstKey);
  }

  const orderTool = {
    functionDeclarations: [
      {
        name: "create_order",
        description:
          "Tạo đơn hàng khi đã thu thập đủ thông tin từ khách: sản phẩm, số lượng, họ tên, SĐT, địa chỉ. " +
          "CHỈ GỌI KHI ĐÃ CÕ ĐẦY ĐỦ 5 THÔNG TIN. Nếu thiếu bất kỳ thông tin nào, hãy hỏi khách trước.",
        parameters: {
          type: "object",
          properties: {
            product: {
              type: "string",
              description: "Tên sản phẩm",
              enum: products.map((p) => p.name),
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
              description: "Địa chỉ giao hàng chi tiết (số nhà, đường, phường/xã, quận/huyện, tỉnh/TP)",
            },
          },
          required: ["product", "quantity", "customer_name", "phone", "address"],
        },
      },
    ],
  };

  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    tools: [orderTool],
  });

  modelCache.set(productKey, model);
  return model;
}

// Load kiến thức bổ sung từ data/*.txt
let knowledge = "";
const dataDir = path.join(__dirname, "..", "data");
try {
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".txt"));
  for (const file of files) {
    const content = fs.readFileSync(path.join(dataDir, file), "utf-8");
    knowledge += content + "\n\n";
  }
} catch {
  // Ignore
}

function getDynamicInstruction() {
  const products = getProducts();
  const settings = getSettings();
  const productsText = products.map(p => `- ${p.name}: ${p.price.toLocaleString("vi-VN")}đ`).join("\n");
  const freeShipThreshold = parseInt(settings.FREE_SHIP_THRESHOLD) || 300000;

  return {
    parts: [
      {
        text:
          getSystemPrompt() +
          "\n\n" +
          "## Hướng dẫn đặt hàng\n" +
          "Khi khách muốn đặt hàng/mua hàng, hãy:\n" +
          "1. Hỏi khách muốn mua sản phẩm nào (nếu chưa nói)\n" +
          "2. Hỏi số lượng (nếu chưa nói)\n" +
          "3. Hỏi họ tên người nhận\n" +
          "4. Hỏi SĐT\n" +
          "5. Hỏi địa chỉ giao hàng CHI TIẾT. Khi ĐÃ CÓ ĐỦ 5 thông tin, gọi function create_order.\n\n" +
          "## Menu sản phẩm\n" +
          productsText +
          "\n\n" +
          "## Chính sách giao hàng\n" +
          getShippingZones().map((z) => `- ${z.name}: ${z.fee === 0 ? "MIỄN PHÍ" : z.fee.toLocaleString("vi-VN") + "đ"} (${z.time})`).join("\n") +
          `\n- Đơn từ ${(freeShipThreshold / 1000)}k: MIỄN PHÍ SHIP toàn quốc` +
          "\n\n" +
          (knowledge ? `## Tài liệu tham khảo\n${knowledge}` : ""),
      },
    ],
  };
}

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
    }, SESSION_TTL)
  );

  let chat = chatSessions.get(chatId);
  if (!chat) {
    const model = getDynamicModel();
    chat = model.startChat({
      systemInstruction: getDynamicInstruction(),
      history: [],
    });
    chatSessions.set(chatId, chat);
  }
  return chat;
}

async function callWithRetry(fn, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if ((err.message?.includes("429") || err.message?.includes("Too Many Requests")) && i < retries) {
        const delay = [5000, 15000, 30000][i] || 30000;
        log.warn(`Gemini 429 — retry ${i + 1}/${retries} sau ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

async function handleFunctionCall(functionCall, chatId, displayName) {
  if (functionCall.name === "create_order") {
    const args = functionCall.args;
    const products = getProducts();
    const product = products.find((p) => p.name === args.product);
    
    if (!product) {
      return { result: { error: "Sản phẩm không tìm thấy hoặc không chính xác" } };
    }

    const qty = parseInt(args.quantity) || 0;
    const settings = getSettings();
    const MAX_QTY = parseInt(settings.MAX_ORDER_QTY) || 10;

    if (qty < 1 || qty > MAX_QTY) {
      return { result: { error: `Số lượng không hợp lệ. Shop chỉ nhận tối đa ${MAX_QTY} gói mỗi đơn. Vui lòng liên hệ chủ shop qua Zalo: ${settings.OWNER_PHONE} để mua số lượng lớn.` } };
    }

    const parsed = {
      product,
      quantity: qty,
      customerName: args.customer_name,
      phone: args.phone,
      address: args.address,
    };

    const orderMessage = await createPendingOrder(chatId, displayName, parsed);

    return {
      result: {
        success: true,
        pending: true,
        message: orderMessage,
        product: product.name,
        quantity: Number(args.quantity),
        totalPrice: product.price * Number(args.quantity),
      },
    };
  }
  return { result: { error: "Function không hợp lệ" } };
}

async function generateReply(chatId, messageText, displayName = "Khách") {
  return enqueue(async () => {
    try {
      const chat = getOrCreateChat(chatId);
      const timeoutMs = 30000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Gemini timeout")), timeoutMs)
      );

      let result = await callWithRetry(() =>
        Promise.race([chat.sendMessage(messageText), timeoutPromise])
      );

      let response = result.response;
      const functionCalls = response.functionCalls();
      let pendingOrderMessage = null;

      if (functionCalls && functionCalls.length > 0) {
        const fc = functionCalls[0];
        const functionResult = await handleFunctionCall(fc, chatId, displayName);

        if (functionResult.result?.message) {
          pendingOrderMessage = functionResult.result.message;
        }

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

      let reply = "";
      try {
        reply = response.text();
      } catch (e) {
        // No text
      }

      if (pendingOrderMessage) return pendingOrderMessage;
      return reply;
    } catch (err) {
      log.error("❌ Gemini API Error Details:", err);
      if (err.response) log.error("Response data:", JSON.stringify(err.response.data));
      return getReplies().error;
    }
  });
}

function hasActiveSession(chatId) {
  return chatSessions.has(chatId);
}

function getSessionCount() {
  return chatSessions.size;
}

function cleanup() {
  for (const timer of sessionTimers.values()) clearTimeout(timer);
  sessionTimers.clear();
  chatSessions.clear();
  modelCache.clear();
}

module.exports = { generateReply, hasActiveSession, getSessionCount, cleanup };
