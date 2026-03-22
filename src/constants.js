// ============================================================
// Tất cả text/cấu hình có thể tùy chỉnh — sửa tại đây
// ============================================================

// System prompt cho Gemini AI
const SYSTEM_PROMPT =
  "Bạn là trợ lý ảo của công ty. Trả lời ngắn gọn, thân thiện bằng tiếng Việt. " +
  "Không dùng markdown formatting (không bold, không bullet, không heading) " +
  "vì tin nhắn sẽ hiển thị trên Zalo dạng plain text. " +
  "Giới hạn trả lời dưới 500 ký tự.";

// Thời gian session hết hạn (ms) — mặc định 1 giờ
const SESSION_TTL = 60 * 60 * 1000;

// Giới hạn ký tự tin nhắn Zalo
const MAX_MESSAGE_LENGTH = 2000;

// Đường dẫn ảnh sản phẩm (relative URL)
const PRODUCT_IMAGES = {
  banner: "/public/images/tra-lai-banner.png",
  product: "/public/images/tra-lai-product.png",
  promo: "/public/images/tra-lai-promo.png",
};

// Placeholder ảnh cho polling mode (không có ngrok URL)
const PRODUCT_IMAGES_PLACEHOLDER = {
  banner: "https://placehold.co/600x400?text=Tra+Lai+Binh+Long",
  product: "https://placehold.co/600x400?text=Bang+Gia+Tra+Lai",
  promo: "https://placehold.co/600x400?text=Khuyen+Mai",
};

// ============================================================
// Từ khóa trigger gửi ảnh sản phẩm
// ============================================================
const KEYWORDS = {
  greeting: ["chào", "hello", "hi", "xin chào", "hey", "alo"],
  price: ["giá", "bao nhiêu", "bảng giá", "price", "mua"],
  promo: ["khuyến mãi", "giảm giá", "ưu đãi", "sale", "km", "free ship"],
};

// ============================================================
// Caption đi kèm ảnh sản phẩm
// ============================================================
const PHOTO_CAPTIONS = {
  banner: "🍵 Trà Lài Bình Long — Thơm tự nhiên, vị thanh mát!",
  product: "📋 100g: 50k | 250g: 110k | 500g: 200k",
  promo: "🎁 Mua 2 tặng 1 | FREE SHIP từ 500k | Giảm 10% khách mới",
};

// ============================================================
// Tin nhắn mẫu cho các loại event
// ============================================================
const REPLIES = {
  image: "Tôi đã nhận được hình ảnh! Hiện tại tôi chỉ hỗ trợ tin nhắn text. Bạn có thể mô tả bằng chữ được không? 😊",
  sticker: "😄",
  unsupported: "Xin lỗi, tôi chưa hỗ trợ loại tin nhắn này. Vui lòng gửi tin nhắn text nhé! 📝",
  rateLimited: "Bạn gửi tin nhắn quá nhanh. Vui lòng đợi chút rồi thử lại nhé! ⏳",
  error: "Xin lỗi, tôi đang gặp sự cố. Vui lòng thử lại sau! 🙏",
};

// Kiểm tra text có chứa từ khóa không
function matchKeywords(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

module.exports = {
  SYSTEM_PROMPT,
  SESSION_TTL,
  MAX_MESSAGE_LENGTH,
  PRODUCT_IMAGES,
  PRODUCT_IMAGES_PLACEHOLDER,
  KEYWORDS,
  PHOTO_CAPTIONS,
  REPLIES,
  matchKeywords,
};
