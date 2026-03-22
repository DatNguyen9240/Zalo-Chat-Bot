# 🤖 Zalo Bot Platform + Gemini AI

Chatbot Zalo tự động phản hồi bằng AI (Google Gemini), xây dựng trên nền tảng [Zalo Bot Platform](https://bot.zapps.me/docs).

## ✨ Tính năng

- Trả lời tin nhắn bằng **Gemini AI** (multi-turn conversation)
- Gửi **ảnh sản phẩm** tự động theo từ khóa (sendPhoto)
- **Reply sticker** — bot trả lại đúng sticker khách gửi
- Đọc **tài liệu kiến thức** từ file text
- **2 chế độ**: Webhook (cần ngrok) hoặc Polling (không cần ngrok)
- **Verify bot token** khi khởi động (getMe)
- **Rate limiting** chống spam per user
- **Retry** tự động khi Gemini bị rate limit (429)
- **Chia tin nhắn dài** thành nhiều phần
- Hiển thị "đang soạn tin" khi AI xử lý (sendChatAction)
- **Graceful shutdown** cleanup sessions
- **Log level** tùy chỉnh qua env

## 📁 Cấu trúc project

```
zalo-oa-bot/
├── index.js                # Entry point
├── src/
│   ├── config.js           # Biến môi trường
│   ├── constants.js        # ⭐ Tất cả text/cấu hình tùy chỉnh
│   ├── logger.js           # Logger theo level
│   ├── gemini.js           # Gemini AI & chat sessions
│   ├── zaloBot.js          # 9 Zalo API functions
│   ├── webhookHandler.js   # Xử lý webhook events
│   └── polling.js          # Polling mode (getUpdates)
├── data/
│   └── knowledge.txt       # ⭐ Tài liệu kiến thức cho bot
├── public/images/           # ⭐ Ảnh sản phẩm
├── .env                    # Secrets (git ignored)
├── .env.example            # Template
└── package.json
```

### ⭐ Khi cần sửa nội dung, chỉ cần sửa 3 file:

| Muốn sửa | Sửa file |
|-----------|----------|
| Thông tin sản phẩm, giá, FAQ | `data/knowledge.txt` |
| Từ khóa, caption ảnh, tin nhắn mẫu | `src/constants.js` |
| Ảnh sản phẩm | Đổi file trong `public/images/` |

## 🚀 Cài đặt & Chạy

### 1. Cài dependencies

```bash
npm install
```

### 2. Tạo Bot trên Zalo

1. Mở **Zalo** → tìm OA **Zalo Bot Manager** → nhắn **"Tạo bot"**
2. Nhập tên bot (VD: `Bot MyShop`)
3. Nhận **Bot Token** qua tin nhắn Zalo

### 3. Cấu hình

```bash
cp .env.example .env
```

Điền `BOT_TOKEN` và `GEMINI_API_KEY` vào `.env`

### 4. Chạy

```bash
npm run dev     # Development (tự reload)
npm start       # Production
```

### 5a. Webhook Mode (mặc định, cần ngrok)

```bash
ngrok http 3000
```

```bash
curl -X POST "https://bot-api.zaloplatforms.com/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://xxxx.ngrok-free.app/webhook","secret_token":"your_secret"}'
```

### 5b. Polling Mode (không cần ngrok)

Đổi trong `.env`:

```env
BOT_MODE=polling
```

Restart server — bot tự gọi `deleteWebhook` rồi bắt đầu `getUpdates` long polling.

### 6. Test

Mở Zalo → tìm Bot → gửi tin nhắn! 🎉

## 📡 Zalo Bot API (9/9 đã implement)

| API | Function | File |
|-----|----------|------|
| `getMe` | `getMe()` | `zaloBot.js` |
| `getUpdates` | `startPolling()` | `polling.js` |
| `setWebhook` | `registerWebhook()` | `zaloBot.js` |
| `deleteWebhook` | `deleteWebhook()` | `zaloBot.js` |
| `getWebhookInfo` | `getWebhookInfo()` | `zaloBot.js` |
| `sendMessage` | `sendMessage()` | `zaloBot.js` |
| `sendPhoto` | `sendPhoto()` | `zaloBot.js` |
| `sendSticker` | `sendSticker()` | `zaloBot.js` |
| `sendChatAction` | `sendTyping()` | `zaloBot.js` |

## 📡 Express Routes

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/` | Health check |
| POST | `/webhook` | Nhận events từ Zalo |
| GET | `/public/images/*` | Ảnh sản phẩm (static) |

## ⚙️ Biến môi trường (.env)

| Biến | Bắt buộc | Mặc định | Mô tả |
|------|----------|----------|-------|
| `BOT_TOKEN` | ✅ | — | Token từ Zalo Bot Manager |
| `GEMINI_API_KEY` | ✅ | — | Google AI API Key |
| `BOT_MODE` | — | `webhook` | `webhook` \| `polling` |
| `GEMINI_MODEL` | — | `gemini-2.5-flash` | Model Gemini |
| `WEBHOOK_SECRET` | — | — | Secret xác thực webhook |
| `LOG_LEVEL` | — | `info` | `debug\|info\|warn\|error` |
| `RATE_LIMIT_MAX` | — | `10` | Tin nhắn tối đa/user/phút |
| `RATE_LIMIT_WINDOW` | — | `60000` | Khoảng thời gian (ms) |

## 📄 License

ISC
