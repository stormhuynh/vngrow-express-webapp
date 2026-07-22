# HANDOFF — VNGROW Express Webapp

> Tài liệu bàn giao cho agent/lập trình viên tiếp theo (vd Gemini trên Google Antigravity).
> Toàn bộ bối cảnh chiến lược & spec nằm trong thư mục `docs/`. ĐỌC `docs/` TRƯỚC KHI CODE.

## Trạng thái hiện tại

Repo tĩnh (HTML thuần + Vercel + Google Apps Script/Sheets backend + serverless `api/chat.js` gọi Claude cho AI báo giá). Đã bổ sung (branch `claude/session-eup14w`, 12 commit):

**Code đã xong & hoạt động:**
- `api/chat.js` — AI chatbot báo giá; đã sửa để lưu lead đầy đủ trường vào Google Sheet LEAD (payload có `action:'saveLead'`).
- `Code.gs` — Apps Script: thêm `saveLead()` ghi vào spreadsheet CRM (`CRM_SS_ID = 1nBUJ...`, KHÁC spreadsheet pricing `1lY0...`); thêm Telegram automation (`notifyNewLead_`, `checkStaleLeads`, `checkContentToday`) cấu hình qua Script Properties.
- `analytics.js` — khung GA4 (`G-CW7PRZLP2H` đã điền) + Facebook Pixel (chưa có ID) + helper `vgTrack()`. Include trên mọi trang.
- `chinh-sach.html` — trang chính sách (nháp, số liệu để trống `[CẦN XÁC NHẬN]`).
- `tuyen.html` — template landing 6 tuyến (`/gui-hang-di-my`...), đọc slug từ URL.
- `index.html`, `chat.html` — đã gắn analytics + sự kiện chuyển đổi; `chat.html` đọc `?to=` để mở đúng tuyến.
- `vercel.json` — rewrites cho /chat, /chinh-sach, /gui-hang-di-:slug.

**Chưa làm (việc tiếp theo — xem `docs/vngrow-website-spec.md`):**
Dựng lại website theo **Hướng A**: Astro (SSG) + Sveltia CMS (git-based, admin `/admin`) để có trang chủ mới + blog nhẹ quản lý qua UI. Giữ nguyên toàn bộ tool/tracking/RFQ/chat hiện có.

## Yêu cầu thiết kế đã chốt (QUAN TRỌNG)

- Trang chủ = **trung tâm vận hành**, KHÔNG phải blog tin tức.
- **Thanh công cụ ngay trên trang chủ** (tab Chat AI / Tính cước / Tracking).
- **Chatbot AI là điểm nhấn nổi bật** (tab mặc định).
- Mẫu trang chủ đã duyệt hướng: xem file preview đính kèm bản bàn giao (hero "Gửi hàng gì cũng hỏi VNGROW", màu xanh #1878C8 / cam #F5A200, mô-típ đường bay).
- Menu: Trang chủ · Vì sao VNGROW · Nghiệp vụ · Cập nhật · Chính sách (dropdown: vận chuyển / bồi thường).
- Blog nhẹ (`/cap-nhat`): chỉ bảng giá, thông báo phụ phí, tip nhỏ. Showcase = embed Facebook/TikTok.

## Định vị thương hiệu (bám sát khi viết mọi nội dung)

Xem `docs/vngrow-brand-strategy.md`. Tóm tắt: VNGROW là đại lý F2, KHÔNG cạnh tranh giá. Vũ khí = **minh bạch + chuyên gia hàng khó + đủ hóa đơn + AI một giá 24/7**. Mô hình 2 động cơ: hàng đơn giản (AI tự động) nuôi dòng tiền, hàng khó (chuyên gia) xây uy tín. Giọng "chuyên gia thành thật", không hype, không lùa khách. **LUẬT CỨNG** ở mục 7 — đặc biệt: không nêu giá cụ thể trên content công khai, không dùng dữ liệu/case của doanh nghiệp khác gán thành của VNGROW.

## Bản đồ tài liệu docs/

| File | Nội dung |
|---|---|
| `vngrow-brand-strategy.md` | Định vị, 2 động cơ, 4 lợi thế, luật cứng, content pillars |
| `vngrow-website-spec.md` | Đặc tả website + kiến trúc Hướng A + sơ đồ trang |
| `vngrow-trust-signals.md` | Hệ thống bằng chứng (chỉ dùng dữ liệu thật của VNGROW) |
| `vngrow-content-batch-01.md` | Lịch 4 tuần + 3 bài flagship + 5 hỏi-đáp |
| `vngrow-video-scripts-01.md` | 3 kịch bản video TikTok theo giây |
| `vngrow-marketing-execution-plan.md` | Nhịp thực thi + KPI + vòng lặp GA4 |
| `vngrow-automation-setup.md` | Setup Telegram bot + trigger Apps Script |

## Việc thủ công còn treo (phía chủ doanh nghiệp)

- Set env `LEAD_WEBHOOK_URL` trên Vercel = URL Web App Apps Script; deploy lại Code.gs.
- Điền số vào `chinh-sach.html` + nhờ pháp lý rà.
- Cung cấp Facebook Pixel ID (điền vào `analytics.js`).
- Cung cấp file logo DHL/FedEx/UPS/EMS (được phép dùng) cho khối trust.

## Lưu ý kỹ thuật

- 2 spreadsheet Google KHÁC nhau: pricing (`1lY0...`) và CRM/LEAD (`1nBUJ...`). Đừng nhầm.
- Backend Apps Script + Sheets giữ nguyên khi migrate Astro — chỉ đổi lớp frontend.
- Khi dựng Astro: port tool tính cước/tracking/RFQ (hiện là inline JS trong index.html gọi `CONFIG.APPS_SCRIPT_URL`) sang component, giữ nguyên logic gọi API.
