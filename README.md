# 🤖 Zalo Bot Platform + Gemini AI

Chatbot Zalo tự động phản hồi bằng AI (Google Gemini), xây dựng trên nền tảng [Zalo Bot Platform](https://bot.zapps.me/docs).
Dành cho **Trà Lài Shop** — chuyên trà lài Bình Long, Bình Phước.

## ✨ Tính năng

### Core
- Trả lời tin nhắn bằng **Gemini AI** (multi-turn conversation)
- **Đặt hàng tự động** — parse đơn trực tiếp hoặc qua Gemini function calling
- **Xác nhận đơn** — hỏi OK/Hủy/Sửa trước khi lưu
- **Tính phí ship tự động** — nhận diện khu vực từ địa chỉ, tính phí ship phù hợp
- Gửi **ảnh sản phẩm** tự động theo từ khóa (sendPhoto)
- **Reply sticker** — bot trả lại đúng sticker khách gửi
- **Multi-knowledge** — load tất cả file .txt từ `data/`
- **Cache FAQ** — trả lời tức thì câu hỏi phổ biến không cần Gemini
- **2 chế độ**: Webhook (cần ngrok) hoặc Polling (không cần ngrok)

### Production
- **Verify bot token** khi khởi động (getMe)
- **Request queue** — giới hạn 3 request Gemini đồng thời, tránh quá tải
- **SQLite database** — lưu lịch sử chat + đơn hàng + analytics
- **Google Sheets** — đồng bộ đơn hàng lên Google Sheets (tùy chọn)
- **Rate limiting** chống spam per user
- **Retry** tự động khi Gemini bị rate limit (429)
- **Gemini timeout** 30s — tránh request treo vô hạn
- **Chia tin nhắn dài** thành nhiều phần (> 2000 ký tự)
- **Helmet + CORS** — bảo mật Express headers
- **Winston logger** — log file xoay vòng 14 ngày + error log 30 ngày
- **PM2 ready** — auto restart, memory limit 256MB
- **Graceful shutdown** cleanup sessions + database
- **Stats API** — analytics realtime tại `/stats`
- **Admin API** — quản lý knowledge files + đơn hàng qua HTTP

## 📁 Cấu trúc project

```
zalo-oa-bot/
├── index.js                  # Entry point + Express server + Admin API
├── ecosystem.config.js       # PM2 config
├── package.json              # Dependencies & scripts
├── .env                      # Secrets (git ignored)
├── .env.example              # Template biến môi trường
├── src/
│   ├── config.js             # Load biến môi trường, validate bắt buộc
│   ├── constants.js          # ⭐ Text/cấu hình/sản phẩm/ship/cache tập trung
│   ├── logger.js             # Winston logger (console + daily rotate file)
│   ├── database.js           # SQLite (chat_history + orders + stats)
│   ├── queue.js              # Request queue (max 3 concurrent)
│   ├── cache.js              # FAQ cache — trả lời tức thì không cần AI
│   ├── gemini.js             # Gemini AI + function calling + chat sessions
│   ├── order.js              # Đặt hàng: parse, pending, confirm, ship calc
│   ├── messageHandler.js     # Xử lý tin nhắn: text, image, sticker
│   ├── zaloBot.js            # 9 Zalo API functions
│   ├── webhookHandler.js     # Webhook mode handler
│   └── polling.js            # Polling mode (getUpdates loop)
├── data/
│   ├── knowledge.txt         # ⭐ Tài liệu kiến thức cho bot
│   ├── google-apps-script.js # Script cho Google Sheets
│   └── bot.db                # SQLite database (auto-generated)
├── logs/                     # Log files (auto-generated)
└── public/images/            # ⭐ Ảnh sản phẩm
```

### ⭐ Khi cần sửa nội dung, chỉ cần sửa 3 nơi:

| Muốn sửa | Sửa ở đâu |
|-----------|----------|
| Sản phẩm, giá, FAQ, ship | `data/*.txt` (tạo nhiều file tùy ý) |
| Từ khóa, caption, cache, phí ship | `src/constants.js` |
| Ảnh sản phẩm | Đổi file trong `public/images/` |

## 🚚 Chính sách giao hàng & phí ship

Shop tại **Bình Long, Bình Phước** — phí ship được shop bù một phần (giá thực tế GHTK/GHN cao hơn):

| Khu vực | Phí ship (thu khách) | Thời gian | Ghi chú |
|---------|---------------------|-----------|---------|
| **Bình Long** | **Miễn phí** | Trong ngày | Shop tự giao |
| **Bình Phước** (nội tỉnh) | **15.000đ** | 1-2 ngày | Qua GHTK/GHN |
| **Miền Nam** (HCM, Đông Nam Bộ...) | **20.000đ** | 2-3 ngày | Qua GHTK/GHN |
| **Miền Trung & Bắc** | **30.000đ** | 3-5 ngày | Qua GHTK/GHN |
| **Đơn từ 300k** | **Miễn phí** | — | Free ship toàn quốc |

**Cách hoạt động:**
1. Khách đặt hàng → nhập địa chỉ
2. `calculateShipping()` tự nhận diện khu vực từ địa chỉ (keyword matching)
3. Phí ship hiển thị trong đơn xác nhận, cộng vào tổng thanh toán
4. Đơn ≥ 300.000đ → tự động miễn phí ship

**Cấu hình trong `constants.js`:**
- `SHIPPING_ZONES` — danh sách khu vực, phí, keywords
- `FREE_SHIP_THRESHOLD` — ngưỡng miễn phí ship (mặc định 300.000đ)
- `calculateShipping(address, totalProductPrice)` — hàm tính phí ship

## 🛒 Luồng đặt hàng

```
Khách nhắn "Đặt hàng"
      │
      ├── Có đủ info? ──YES──▶ tryParseOrder() → createPendingOrder()
      │                                              │
      └── Thiếu info? ──NO──▶ Gemini hỏi thêm       │
                              └── Đủ rồi → create_order() function call
                                              │
                                              ▼
                                    ┌─────────────────────┐
                                    │  XÁC NHẬN ĐƠN HÀNG  │
                                    │  Sản phẩm: ...       │
                                    │  Tiền hàng: ...      │
                                    │  Phí ship: ...       │
                                    │  Tổng thanh toán: ...│
                                    │  "OK" · "Hủy" · "Sửa"│
                                    └─────────────────────┘
                                              │
                            ┌─────────────────┼─────────────────┐
                            ▼                 ▼                 ▼
                        "OK"              "Hủy"             "Sửa"
                    confirmOrder()     cancelOrder()     Yêu cầu nhập lại
                    → saveOrder()
                    → Google Sheets
                    → ✅ Đơn #ID
```

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
npm run dev     # Development (tự reload khi sửa code)
npm start       # Production (node)
npm run pm2     # Production (PM2 — auto restart)
```

### 5a. Webhook Mode (mặc định, cần ngrok)

```bash
ngrok http 3000
```

Đặt `WEBHOOK_URL` trong `.env`:
```env
WEBHOOK_URL=https://xxxx.ngrok-free.app
```

Bot tự đăng ký webhook khi khởi động.

### 5b. Polling Mode (không cần ngrok)

```env
BOT_MODE=polling
```

### 6. Test

Mở Zalo → tìm Bot → gửi tin nhắn! 🎉

## 📊 Chi tiết từng module

### `index.js` — Entry point + Express server

- Khởi tạo Express app với Helmet + CORS + body limit 1MB
- Mount webhook endpoint, static files, health check
- Admin middleware (`requireAdmin`) bảo vệ `/stats` + `/admin/*`
- Knowledge API: CRUD file `.txt` trong `data/`
- Orders API: xem + cập nhật trạng thái đơn hàng
- Graceful shutdown: cleanup sessions, đóng DB

### `src/config.js` — Biến môi trường

- Load `.env` bằng dotenv
- Validate bắt buộc: `BOT_TOKEN`, `GEMINI_API_KEY`
- Export tất cả config với giá trị mặc định

### `src/constants.js` — Cấu hình tập trung ⭐

Tất cả text/config có thể tùy chỉnh đều nằm ở đây:

| Biến | Mô tả |
|------|-------|
| `SYSTEM_PROMPT` | Prompt cho Gemini AI (phong cách, quy tắc) |
| `SESSION_TTL` | Thời gian session hết hạn (1 giờ) |
| `MAX_MESSAGE_LENGTH` | Giới hạn ký tự Zalo (2000) |
| `FREE_SHIP_THRESHOLD` | Ngưỡng free ship (300.000đ) |
| `SHIPPING_ZONES` | Khu vực ship: tên, phí, keywords |
| `PRODUCTS` | Danh sách sản phẩm (id, name, price, aliases) |
| `PRODUCT_IMAGES` | Đường dẫn ảnh (webhook mode) |
| `PRODUCT_IMAGES_PLACEHOLDER` | URL placeholder (polling mode) |
| `KEYWORDS` | Từ khóa trigger gửi ảnh |
| `PHOTO_CAPTIONS` | Caption đi kèm ảnh |
| `REPLIES` | Tin nhắn mẫu (image, sticker, error...) |
| `ORDER_KEYWORDS` | Từ khóa xác nhận/hủy/sửa đơn |
| `ORDER_REPLIES` | Tin nhắn đơn hàng |
| `CACHE_ENTRIES` | FAQ cache (12 chủ đề, trả lời không cần Gemini) |
| `calculateShipping()` | Hàm tính phí ship từ địa chỉ |
| `getWelcomeMessage()` | Welcome message cá nhân hóa theo tên |
| `matchKeywords()` | Helper matching từ khóa |

### `src/cache.js` — FAQ cache

- Duyệt `CACHE_ENTRIES` tìm keyword match
- Trả lời tức thì không cần gọi Gemini → tiết kiệm API
- 12 chủ đề: chào, đặt hàng, giá, ship, pha trà, khuyến mãi, bảo quản, trà lài, liên hệ, hình ảnh, thanh toán, cảm ơn

### `src/gemini.js` — Gemini AI engine

- Khởi tạo model với function calling (`create_order`)
- Load knowledge base từ `data/*.txt`
- System instruction: prompt + order guide + menu + shipping policy
- Chat session management (Map, TTL 1 giờ)
- Retry logic cho 429 (5s → 15s → 30s)
- Timeout 30s tránh request treo
- Function call handler: validate sản phẩm → `createPendingOrder()`

### `src/order.js` — Xử lý đơn hàng

- `tryParseOrder(text)` — regex parse đơn không cần AI (detect product, SĐT, quantity, tên, địa chỉ)
- `createPendingOrder()` — tạo đơn chờ xác nhận, tính phí ship, timeout 5 phút
- `confirmPendingOrder()` → `createOrderFromParsed()` → save DB + Google Sheets
- `cancelPendingOrder()` — hủy đơn
- Phí ship tự động tính và hiển thị trong đơn

### `src/messageHandler.js` — Xử lý tin nhắn

Luồng xử lý:
1. Track event + save chat history
2. Rate limit check (10 tin/phút/user)
3. Welcome message nếu session mới
4. Kiểm tra pending order → OK/Hủy/Sửa
5. Try parse đơn trực tiếp (không cần Gemini)
6. FAQ cache (nếu không mention sản phẩm)
7. Gemini AI (function calling)
8. Gửi ảnh sản phẩm theo từ khóa

### `src/zaloBot.js` — Zalo Bot API wrapper

- `splitMessage()` — chia tin nhắn > 2000 ký tự
- `sendMessage()`, `sendPhoto()`, `sendSticker()`, `sendTyping()`
- `registerWebhook()`, `deleteWebhook()`, `getWebhookInfo()`
- `getMe()` — verify bot token

### `src/database.js` — SQLite database

3 tables:
- `chat_history` — lịch sử chat (chat_id, role, message)
- `orders` — đơn hàng (product, quantity, total_price, status)
- `stats` — analytics events (message, photo_sent, order_created, error)

WAL mode cho performance. Indexes cho query optimization.

### `src/queue.js` — Request queue

- Giới hạn 3 request Gemini đồng thời
- Queue FIFO, auto-process khi có slot trống

### `src/logger.js` — Winston logger

- Console: emoji icons per level
- Daily rotate file: `bot-YYYY-MM-DD.log` (14 ngày)
- Error file riêng: `error-YYYY-MM-DD.log` (30 ngày)

### `src/webhookHandler.js` — Webhook mode

- POST `/webhook` endpoint
- Verify `X-Bot-API-Secret-Token` header
- Route events: text → image → sticker → unsupported

### `src/polling.js` — Polling mode

- Long polling loop với `getUpdates` (timeout 30s)
- Auto-reconnect khi lỗi (3s delay)
- Sử dụng placeholder images (không có ngrok URL)

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

| Method | Path | Auth | Mô tả |
|--------|------|------|-------|
| GET | `/` | — | Health check |
| POST | `/webhook` | Secret Token | Nhận events từ Zalo |
| GET | `/stats` | Admin | 📊 Analytics |
| GET | `/admin/knowledge` | Admin | Liệt kê knowledge files |
| POST | `/admin/knowledge` | Admin | Tạo/cập nhật knowledge |
| DELETE | `/admin/knowledge/:filename` | Admin | Xóa knowledge file |
| GET | `/admin/orders` | Admin | Danh sách đơn hàng |
| PATCH | `/admin/orders/:id` | Admin | Cập nhật trạng thái đơn |
| GET | `/public/images/*` | — | Ảnh sản phẩm (static) |

### Ví dụ Admin API

```bash
# Header xác thực
AUTH="Authorization: Bearer YOUR_ADMIN_SECRET"

# Xem stats
curl -H "$AUTH" http://localhost:3000/stats

# Xem đơn hàng mới
curl -H "$AUTH" "http://localhost:3000/admin/orders?status=new"

# Cập nhật đơn → đang giao
curl -X PATCH -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"status":"shipping"}' http://localhost:3000/admin/orders/1

# Thêm knowledge
curl -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"filename":"faq.txt","content":"Hỏi: Trà có ship không?\nĐáp: Có, free ship từ 300k"}' \
  http://localhost:3000/admin/knowledge

# Xóa knowledge
curl -X DELETE -H "$AUTH" http://localhost:3000/admin/knowledge/faq.txt
```

### Ví dụ Stats

```bash
curl -H "Authorization: Bearer YOUR_SECRET" http://localhost:3000/stats
```

```json
{
  "totalMessages": 142,
  "todayMessages": 23,
  "uniqueUsers": 15,
  "todayUsers": 5,
  "totalPhotos": 31,
  "totalErrors": 0,
  "totalOrders": 8,
  "newOrders": 3,
  "daily": [{"day":"2026-03-22","count":119},{"day":"2026-03-23","count":23}],
  "sessions": 3,
  "queue": {"active":1,"waiting":0}
}
```

## 📊 Google Sheets (tùy chọn)

1. Tạo Google Sheet mới
2. Mở **Extensions → Apps Script**
3. Paste nội dung từ `data/google-apps-script.js`
4. Deploy → **Web app** → **Anyone** can access
5. Copy URL → đặt vào `.env`:

```env
GOOGLE_SHEET_URL=https://script.google.com/macros/s/xxx/exec
```

Mỗi đơn hàng tự động ghi vào Sheet: Mã đơn, Ngày đặt, Khách, Sản phẩm, Số lượng, Tổng tiền, Người nhận, SĐT, Địa chỉ, Khu vực ship, Phí ship, Trạng thái.

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
| `WEBHOOK_URL` | — | — | URL public cho webhook (auto-register) |
| `ADMIN_SECRET` | — | — | Secret bảo vệ /stats + /admin/* |
| `GOOGLE_SHEET_URL` | — | — | URL Google Apps Script |
| `LOG_LEVEL` | — | `info` | `debug\|info\|warn\|error` |
| `RATE_LIMIT_MAX` | — | `10` | Tin nhắn tối đa/user/phút |
| `RATE_LIMIT_WINDOW` | — | `60000` | Khoảng thời gian rate limit (ms) |
| `PORT` | — | `3000` | Port Express server |

## 📦 Dependencies

| Package | Version | Mô tả |
|---------|---------|-------|
| `@google/generative-ai` | ^0.24.1 | Gemini AI SDK |
| `axios` | ^1.13.6 | HTTP client (Zalo API, Google Sheets) |
| `better-sqlite3` | ^12.8.0 | SQLite database |
| `cors` | ^2.8.6 | CORS middleware |
| `dotenv` | ^17.3.1 | Load .env |
| `express` | ^5.2.1 | Web server |
| `helmet` | ^8.1.0 | Security headers |
| `winston` | ^3.19.0 | Logger |
| `winston-daily-rotate-file` | ^5.0.0 | Daily log rotation |

## 📄 License

ISC
