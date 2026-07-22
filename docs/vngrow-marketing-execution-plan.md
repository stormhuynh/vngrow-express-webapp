# VNGROW — Kế hoạch Marketing Chi tiết (Thực thi)

> Đi kèm `vngrow-brand-strategy.md` (định vị), `vngrow-content-batch-01.md` (nội dung), `vngrow-trust-signals.md` (bằng chứng), `vngrow-automation-setup.md` (workflow tự động).

## 1. Mục tiêu 4 tuần đầu

| Mục tiêu | Đo bằng |
|---|---|
| Có traffic thật vào AI báo giá | GA4: sự kiện `chat_open`, `chat_page_view` |
| Ra lead thật (SĐT) | Google Sheet LEAD: số dòng mới/tuần |
| Xây uy tín ban đầu | 1 bài flagship thật (Phần Lan) tiếp cận X người, có tương tác |
| Vận hành không tốn thêm nhân sự | Telegram tự báo lead + nhắc lịch, không ai phải "canh" sheet |

*(Không đặt KPI số cụ thể vì chưa có baseline — sau tuần 1-2 có số liệu GA4 thật, quay lại đặt mục tiêu định lượng.)*

## 2. Nhịp thực thi hàng tuần

| Ngày | Việc | Ai làm | Công cụ |
|---|---|---|---|
| Thứ 2 | Đăng bài P5 (uy tín/case) | Người phụ trách social | Facebook Page + nhóm liên quan |
| Thứ 4 | Đăng bài P4 hoặc P3 | Người phụ trách social | Facebook Page |
| Thứ 7 | Đăng bài P1 (gần gũi) hoặc video | Người phụ trách social | Facebook/TikTok |
| Hàng ngày 8h | Nhận nhắc "hôm nay đăng gì" | Tự động | Telegram |
| Ngay khi có lead | Nhận báo lead mới, liên hệ trong ngày | Sales | Telegram → gọi/Zalo khách |
| Mỗi 3h | Nhận nhắc lead >24h chưa xử lý | Tự động | Telegram |
| Cuối tuần | Xem GA4: bài nào ra traffic/lead nhiều nhất | Storm | GA4 Realtime + Reports |

## 3. Quy trình xử lý 1 lead (từ lúc Telegram báo tới lúc chốt)

1. Telegram báo "🆕 Lead mới" → Sales mở Google Sheet LEAD xem chi tiết đầy đủ.
2. Liên hệ khách qua SĐT/Zalo **trong vòng 1-2h** (càng nhanh, tỉ lệ chốt càng cao).
3. Cập nhật cột `lead_status` trong sheet: `collecting` → `quoted` → `booking_requested` / `need_human`.
4. Nếu quá 24h chưa xử lý, Telegram tự nhắc lại (không sợ bỏ sót).
5. Chốt xong → thực hiện quy trình xin bằng chứng (theo `vngrow-trust-signals.md` mục 5): xin phép khách chia sẻ cảm nhận.

## 4. Vòng lặp cải thiện content (dựa trên số liệu thật)

1. GA4 cho biết bài/landing nào tạo ra nhiều `chat_open` / `rfq_submit` nhất.
2. Bài nào hiệu quả → làm biến thể (đổi hook, đổi hình) đăng lại sau 2-3 tuần.
3. Tuyến nào lên nhiều lead nhất (xem cột `destination_country` trong LEAD) → ưu tiên landing tuyến đó (`/gui-hang-di-...`) khi chạy thêm quảng cáo.
4. Case hàng khó xử lý thành công → luôn biến thành bài P5 tiếp theo (nguồn content bền vững nhất, đúng chất "chuyên gia thành thật").

## 5. Khi nào cân nhắc chạy Ads (trả phí)

Chỉ nên bắt đầu **sau khi**:
- Đã có GA4 dữ liệu 2-4 tuần tự nhiên (organic) để biết bài/landing nào convert tốt.
- Có Facebook Pixel (chưa gắn — báo tôi khi có Pixel ID để tôi điền vào `analytics.js` như đã làm với GA4).
- Có ít nhất 1-2 case thật + có thể vài lời khách thật đầu tiên (bằng chứng, không chạy ads vào trang "trắng" chưa có gì để tin).

Khi đó, dồn ngân sách vào **landing tuyến cụ thể** (`/gui-hang-di-my`, `/gui-hang-di-nhat`...) thay vì trang chủ chung — vì đã có sẵn hạ tầng landing theo tuyến.

## 6. Việc lặp lại mỗi tháng

- Viết batch content mới (như batch 01) dựa trên: case thật phát sinh trong tháng + câu hỏi khách thật gom được qua Zalo/AI chat.
- Rà lại GA4 + Google Sheet LEAD → cập nhật mục 1 (đặt KPI số cụ thể khi đã có baseline).
- Cập nhật `vngrow-trust-signals.md` khi có case/lời khách mới đủ để lên khối "Khách nói gì" trên web.
