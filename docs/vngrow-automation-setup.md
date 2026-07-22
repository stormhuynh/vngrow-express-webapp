# VNGROW — Setup Workflow Tự động (Telegram + nhắc lịch)

> Làm 1 lần, ~10-15 phút. Sau đó hệ thống tự chạy, không cần đụng vào nữa.

## Kiến trúc

```
Khách chat AI → api/chat.js → Google Sheet LEAD ──┐
                                                    ├─→ saveLead() trong Code.gs
Form web (RFQ/Booking) → Code.gs ──────────────────┘
                                        │
                                        ├─→ [NGAY LẬP TỨC] notifyNewLead_()  → Telegram: "🆕 Lead mới..."
                                        │
                            [MỖI 3H, tự động] checkStaleLeads()  → Telegram: "⏰ Lead chưa xử lý >24h..."
                                        │
                            [MỖI SÁNG 8H, tự động] checkContentToday() → Telegram: "📅 Hôm nay cần đăng..."
```

Không cần n8n/Zapier — toàn bộ chạy bằng **Google Apps Script trigger** (miễn phí, có sẵn trong `Code.gs`).

---

## Bước 1 — Tạo Telegram Bot (2 phút)

1. Mở Telegram, tìm **@BotFather**, nhắn `/newbot`.
2. Đặt tên bot (vd `VNGROW Alert Bot`) và username (vd `vngrow_alert_bot`).
3. BotFather trả về 1 **token** dạng `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` — copy lại, đây là `TELEGRAM_BOT_TOKEN`.
4. Tạo 1 **group Telegram** (vd "VNGROW - Lead & Content"), thêm bot vừa tạo vào group.
5. Lấy `TELEGRAM_CHAT_ID` của group:
   - Gửi thử 1 tin nhắn bất kỳ vào group (có mặt bot).
   - Mở trình duyệt, vào: `https://api.telegram.org/bot<TOKEN>/getUpdates` (thay `<TOKEN>` bằng token ở bước 3).
   - Tìm số `"chat":{"id": -100xxxxxxxxxx, ...}` — số đó (có dấu trừ) là `TELEGRAM_CHAT_ID`.

## Bước 2 — Khai báo token vào Apps Script (2 phút)

1. Mở Google Sheet CRM → **Extensions → Apps Script**.
2. Menu bên trái: **Project Settings** (biểu tượng ⚙️) → mục **Script Properties** → **Add script property**.
3. Thêm 2 dòng:
   | Property | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | token ở Bước 1.3 |
   | `TELEGRAM_CHAT_ID` | id ở Bước 1.5 |
4. Save.

## Bước 3 — Deploy lại Code.gs (1 phút)

Trong Apps Script: **Deploy → Manage deployments → chọn deployment hiện tại → Edit (✏️) → New version → Deploy**.
(Code đã có sẵn 3 hàm mới: `notifyNewLead_`, `checkStaleLeads`, `checkContentToday` — không cần viết gì thêm.)

## Bước 4 — Bật Trigger tự động chạy (3 phút)

Trong Apps Script: menu bên trái **Triggers** (biểu tượng ⏰) → **Add Trigger**, tạo 2 trigger:

**Trigger 1 — nhắc lead bị bỏ quên:**
- Function: `checkStaleLeads`
- Event source: `Time-driven`
- Type: `Hour timer` → Every `3 hours`

**Trigger 2 — nhắc lịch content mỗi sáng:**
- Function: `checkContentToday`
- Event source: `Time-driven`
- Type: `Day timer` → thời gian `8am to 9am`

*(Lead mới báo NGAY thì không cần trigger — nó tự chạy mỗi khi `saveLead()` được gọi.)*

## Bước 5 — Test thử

- Vào `/chat` trên web, giả làm khách, để lại tên + SĐT + tuyến hàng → chờ AI lưu lead → Telegram group phải nhận được tin "🆕 Lead mới từ AI chatbot" trong vài giây.
- Nếu chưa thấy: kiểm tra lại Bước 2 (đúng token/chat_id chưa) và Bước 3 (đã deploy version mới chưa).

---

## Bước 6 (tùy chọn) — Sheet lịch content tự nhắc

Muốn Telegram tự nhắc "hôm nay đăng bài gì" thì tạo thêm 1 tab mới tên **`CONTENT_CALENDAR`** trong spreadsheet CRM, với header dòng 1:

```
date | pillar | format | title | content | status
```

Điền mỗi dòng 1 bài theo lịch trong `vngrow-content-batch-01.md`, ví dụ:

| date | pillar | format | title | content | status |
|---|---|---|---|---|---|
| 2026-07-28 | P5 | fb_post | Mẫu nước thải đi Phần Lan | (dán nguyên bài từ content-batch-01.md) | |

Cột `status` để trống — khi đăng xong, đổi thành `Đã đăng` để hôm sau không bị nhắc lại. Trigger `checkContentToday` sẽ tự đọc và nhắc đúng ngày.

---

## Giới hạn cần biết

- **Không tự động đăng bài lên Facebook/TikTok** — Telegram chỉ nhắc + đưa nội dung sẵn, người vẫn phải tự đăng (do API mạng xã hội yêu cầu xét duyệt phức tạp, không đáng làm ở quy mô hiện tại).
- Google Apps Script trigger có giới hạn miễn phí ~90 phút chạy/ngày — với tần suất trên (mỗi 3h + mỗi sáng) hoàn toàn nằm trong hạn mức, không tốn phí.
- Nếu sau này muốn tự động đăng thật (vd qua Meta Business Suite lịch sẵn có của Facebook), có thể làm — không cần workflow riêng, Facebook đã hỗ trợ lên lịch bài viết sẵn miễn phí.
