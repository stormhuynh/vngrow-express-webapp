# VNGROW — Đặc tả Website (Website Spec)

> Ghi nhận yêu cầu của chủ doanh nghiệp (Storm). Mọi thiết kế/xây dựng web bám theo đây.

## 1. Mục tiêu website — "TRUNG TÂM VẬN HÀNH", không phải trang tin tức

Website KHÔNG phải blog chia sẻ nội dung chuyên sâu. Nó là nơi khách **thao tác** khi cần:

| Nhu cầu khách | Tính năng web |
|---|---|
| Check cước | Tool tính cước (calculator) |
| Theo dõi lô hàng | Tracking (tra cứu vận đơn) |
| Nhận báo giá | AI chatbot báo giá + form RFQ |
| Hiểu chính sách | Trang Chính sách (vận chuyển, bồi thường) — `/chinh-sach` |
| Thấy hoạt động thật | Showcase hình ảnh + **embed video Facebook/TikTok** |

## 2. Nguyên tắc nội dung

- **KHÔNG** viết blog dài, không nội dung chuyên sâu dạng bài báo/tin tức.
- Nội dung marketing chính sống ở **Facebook/TikTok** → website **embed/liên kết** về đó, đăng đều.
- **Blog nhẹ** (mục "Cập nhật") CHỈ để:
  - Cập nhật **bảng giá**
  - **Thông báo thay đổi phụ phí** / lịch bay / chính sách
  - **Tip trick nhỏ** cho khách gửi hàng
- Các bài này ngắn, đăng qua giao diện admin (không viết code).

## 3. Điểm nhấn bắt buộc

1. **Thanh công cụ hiển thị ngay trên trang chủ** — khách vào là dùng được tool (tính cước / tracking / chat), không phải đi tìm.
2. **Chatbot AI là ĐIỂM NHẤN** — hiển thị rõ ràng, nổi bật, không phải nút nhỏ ẩn góc.
3. Giao diện đã duyệt hướng: hero kể định vị "Gửi hàng gì cũng hỏi VNGROW" + màu xanh–cam VNGROW.

## 4. Kiến trúc kỹ thuật (Hướng A — đã chọn)

- **Static site generator + CMS git-based** để có admin UI đẹp + SEO tốt + miễn phí.
- **Stack đề xuất:** Astro (SSG, xuất HTML tĩnh, SEO tốt, giữ được toàn bộ tool JS hiện có) + Sveltia CMS (bản kế nhiệm Decap CMS, admin `/admin`, đăng nhập GitHub, lưu bài dạng markdown vào repo) → Vercel tự build & deploy khi có bài mới.
- Giữ nguyên backend hiện tại: Google Apps Script + Sheets (giá, tracking, RFQ, LEAD) và serverless `api/chat.js` (AI báo giá).
- Admin đăng bài → commit markdown vào repo → Vercel build → bài lên web (là trang HTML thật, SEO tốt).

## 5. Sơ đồ trang

```
/                → Trang chủ: hero + THANH CÔNG CỤ (tính cước/tracking/chat) + AI nổi bật
                   + 4 lợi thế + hàng khó + showcase social + cập nhật mới nhất + CTA
/tinh-cuoc       → Tool tính cước đầy đủ (giữ từ index.html hiện tại)
/tracking        → Tra cứu vận đơn
/bao-gia         → Form RFQ
/chat            → AI chatbot toàn màn hình (đã có)
/chinh-sach      → Chính sách vận chuyển & bồi thường (đã có)
/cap-nhat        → Blog nhẹ: bảng giá, thông báo phụ phí, tip (quản lý qua CMS)
/cap-nhat/:slug  → Từng bài cập nhật
/gui-hang-di-*   → Landing tuyến (đã có)
/admin           → Sveltia CMS: viết & đăng bài qua giao diện, không cần code
```

## 6. Phạm vi KHÔNG làm (để khỏi phình)

- Không làm blog tin tức/nội dung dài.
- Không làm hệ thống bình luận, tài khoản khách hàng, giỏ hàng.
- Không tự động đăng mạng xã hội (chỉ embed/liên kết).

## 7. Điều kiện triển khai (phụ thuộc)

- Cần push code lên GitHub được (đang chờ Storm qua 2FA) — vì CMS Hướng A đăng nhập qua GitHub và Vercel build từ repo.
- Cần 1 tài khoản GitHub để đăng nhập admin (có thể tạo riêng cho việc đăng bài).
- Sau khi push được: setup GitHub OAuth cho CMS + bật Vercel build cho Astro.
