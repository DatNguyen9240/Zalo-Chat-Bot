# 🤖 Zalo Bot Platform + Gemini AI

Chatbot Zalo tự động phản hồi bằng AI (Google Gemini), xây dựng trên nền tảng [Zalo Bot Platform](https://bot.zapps.me/docs).

## ✨ Tính năng

### Core
- Trả lời tin nhắn bằng **Gemini AI** (multi-turn conversation)
- Gửi **ảnh sản phẩm** tự động theo từ khóa (sendPhoto)
- **Reply sticker** — bot trả lại đúng sticker khách gửi
- **Multi-knowledge** — load tất cả file .txt từ `data/`
- **2 chế độ**: Webhook (cần ngrok) hoặc Polling (không cần ngrok)

### Production
- **Verify bot token** khi khởi động (getMe)
- **Request queue** — giới hạn 3 request Gemini đồng thời, tránh quá tải
- **SQLite database** — lưu lịch sử chat + analytics
- **Rate limiting** chống spam per user
- **Retry** tự động khi Gemini bị rate limit (429)
- **Gemini timeout** 30s — tránh request treo vô hạn
- **Chia tin nhắn dài** thành nhiều phần
- **Helmet + CORS** — bảo mật Express headers
- **Winston logger** — log file xoay vòng 14 ngày + error log 30 ngày
- **PM2 ready** — auto restart, memory limit
- **Graceful shutdown** cleanup sessions + database
- **Stats API** — analytics realtime tại `/stats`
- **Admin API** — quản lý knowledge files qua HTTP

## 📁 Cấu trúc project

```
zalo-oa-bot/
├── index.js                # Entry point + Stats/Admin API
├── ecosystem.config.js     # PM2 config
├── src/
│   ├── config.js           # Biến môi trường
│   ├── constants.js        # ⭐ Tất cả text/cấu hình tùy chỉnh
│   ├── logger.js           # Winston logger (console + file)
│   ├── database.js         # SQLite (chat history + analytics)
│   ├── queue.js            # Request queue (concurrent limit)
│   ├── gemini.js           # Gemini AI & chat sessions
│   ├── zaloBot.js          # 9 Zalo API functions
│   ├── webhookHandler.js   # Webhook mode
│   └── polling.js          # Polling mode (getUpdates)
├── data/
│   ├── knowledge.txt       # ⭐ Tài liệu kiến thức cho bot
│   └── bot.db              # SQLite database (auto-generated)
├── logs/                   # Log files (auto-generated)
├── public/images/          # ⭐ Ảnh sản phẩm
├── .env                    # Secrets (git ignored)
├── .env.example            # Template
└── package.json
```

### ⭐ Khi cần sửa nội dung, chỉ cần sửa 3 nơi:

| Muốn sửa | Sửa ở đâu |
|-----------|----------|
| Thông tin sản phẩm, giá, FAQ | `data/*.txt` (tạo nhiều file tùy ý) |
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
npm start       # Production (node)
npm run pm2     # Production (PM2 — auto restart)
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

```env
BOT_MODE=polling
```

### 6. Test

Mở Zalo → tìm Bot → gửi tin nhắn! 🎉

## 📡 Zalo Bot API (9/9 implemented)

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
| GET | `/` | Health check + queue info |
| POST | `/webhook` | Nhận events từ Zalo |
| GET | `/stats` | 📊 Analytics (messages, users, daily) |
| GET | `/admin/knowledge` | Liệt kê tất cả knowledge files |
| POST | `/admin/knowledge` | Tạo/cập nhật knowledge file |
| DELETE | `/admin/knowledge/:filename` | Xóa knowledge file |
| GET | `/public/images/*` | Ảnh sản phẩm (static) |

### Ví dụ Admin API

```bash
# Xem tất cả knowledge
curl http://localhost:3000/admin/knowledge

# Thêm file FAQ mới
curl -X POST http://localhost:3000/admin/knowledge \
  -H "Content-Type: application/json" \
  -d '{"filename":"faq.txt","content":"Hỏi: Trà có ship không?\nĐáp: Có, free ship từ 500k"}'

# Xóa file
curl -X DELETE http://localhost:3000/admin/knowledge/faq.txt
```

### Ví dụ Stats

```bash
curl http://localhost:3000/stats
```

```json
{
  "totalMessages": 142,
  "todayMessages": 23,
  "uniqueUsers": 15,
  "todayUsers": 5,
  "totalPhotos": 31,
  "totalErrors": 0,
  "daily": [{"day":"2025-03-22","count":119},{"day":"2025-03-23","count":23}],
  "sessions": 3,
  "queue": {"active":1,"waiting":0}
}
```

## 🔍 Monitoring

### PM2 (Production)

```bash
npm run pm2         # Start bot
npm run pm2:stop    # Stop bot  
npm run pm2:logs    # Xem logs realtime
pm2 monit           # Monitor CPU/RAM
```

### UptimeRobot (Free)

1. Đăng ký [UptimeRobot](https://uptimerobot.com/)
2. Thêm HTTP Monitor → URL: `https://your-domain.com/`
3. Interval: 5 phút → Alert qua email/Telegram khi bot down

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
