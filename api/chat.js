import Anthropic from "@anthropic-ai/sdk";
import { computeQuote, computeAllQuotes, fmtVND } from "../lib/pricing.js";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_EXPRESS_BUSINESS,
});
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM = `Bạn là trợ lý báo giá của VNGROW - chuyển phát nhanh quốc tế từ Việt Nam đi nước ngoài. Xưng "em", gọi khách "anh/chị", lịch sự, chuyên nghiệp, NGẮN GỌN. Không đùa cợt quá đà.

NHIỆM VỤ: thu thập thông tin rồi báo giá.
Cần để báo giá: nước đến + cân nặng. Nên xin thêm KÍCH THƯỚC KIỆN và kho gửi để tính chính xác. Xin tên + SĐT để lưu hồ sơ, nhân viên hỗ trợ. Thiếu gì hỏi nấy, mỗi lượt tối đa 2 ý.

CÁCH HỎI KÍCH THƯỚC (quan trọng): hỏi để tính đúng, KHÔNG hỏi kiểu "có cồng kềnh không". Diễn đạt: "Anh/chị cho em xin kích thước kiện (dài × rộng × cao, cm) để em tính cước chính xác, tránh phát sinh do trọng lượng quy đổi nhé." Nếu khách không có/không rõ, cứ tính theo cân thực và nói rõ giá có thể đổi nhẹ nếu kiện to.

TÍNH GIÁ: LUÔN gọi tool compare_carriers để lấy bảng so sánh các hãng (đừng tự tính). Mặc định origin HCM nếu khách chưa nói. cargo_group suy từ mô tả: quần áo/giày/túi = normal, mỹ phẩm = cosmetics, thực phẩm = food, điện tử = electricity, tài liệu = document, thực vật = plan.
- Sau khi gọi compare_carriers, hệ thống TỰ hiển thị BẢNG giá riêng cho khách. Bạn chỉ viết 1-2 câu dẫn ngắn gọn (vd "Dạ đây là báo giá tạm tính các hãng cho lô 5kg đi Mỹ ạ:"). TUYỆT ĐỐI KHÔNG tự vẽ bảng bằng ký tự "|", KHÔNG liệt kê lại tên hãng/giá trong câu trả lời — bảng đã có sẵn bên dưới.
- Ghi rõ đây là "giá tạm tính".

PHỤ PHÍ: chỉ nhắc phụ phí khi THỰC SỰ liên quan mặt hàng khách nói. Hàng thường (quần áo, giày, túi...) thì KHÔNG nhắc gì về gỗ, hun trùng, FDA. Đừng tự bịa tình huống phát sinh không liên quan.

LƯU HỒ SƠ: khi có tên + SĐT hoặc vừa báo giá, gọi tool save_lead (kể cả khách chưa chốt).

KẾT THÚC lịch sự, không đùa: mời khách theo hướng "Anh/chị muốn liên hệ nhân viên để hỏi thêm không ạ? Hoặc anh/chị để lại số điện thoại, em nhờ nhân viên gọi lại tư vấn kỹ hơn." Rồi để 2 nút bên dưới.`;

const tools = [
  {
    name: "compare_carriers",
    description: "Tính và so sánh cước tất cả hãng (DHL, FedEx IP/IE, EMS, Chuyên tuyến) cho 1 lô hàng. Trả về bảng giá. Luôn dùng để báo giá.",
    input_schema: {
      type: "object",
      properties: {
        destination_country: { type: "string", description: "Tên nước đến, vd USA, JAPAN" },
        cargo_group: { type: "string", enum: ["normal", "cosmetics", "food", "electricity", "document", "plan", "other"] },
        origin_city: { type: "string", enum: ["HCM", "HN"] },
        direction: { type: "string", enum: ["export", "import"] },
        invoice_vat: { type: "boolean" },
        packages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              qty: { type: "number" }, weight: { type: "number" },
              L: { type: "number" }, W: { type: "number" }, H: { type: "number" },
            },
            required: ["weight"],
          },
        },
      },
      required: ["destination_country", "packages"],
    },
  },
  {
    name: "save_lead",
    description: "Ghi/cập nhật hồ sơ khách vào CRM. Gọi khi có thông tin mới hoặc sau khi báo giá.",
    input_schema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        contact_name: { type: "string" },
        contact_phone: { type: "string" },
        destination_country: { type: "string" },
        cargo_group: { type: "string" },
        total_gw: { type: "number" },
        price_quote: { type: "number" },
        rfq_status: { type: "string", enum: ["collecting", "quoted", "booking_requested", "need_human"] },
      },
      required: ["rfq_status"],
    },
  },
];

async function saveLead(input) {
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) return { ok: true, note: "chưa cấu hình CRM webhook - bỏ qua" };
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, rfq_date: new Date().toISOString().slice(0, 10) }),
    });
    return { ok: r.ok };
  } catch (e) { return { ok: false, error: String(e) }; }
}

function buildTable(rows, dest) {
  const served = rows.filter((r) => r.ok);
  const notServed = rows.filter((r) => !r.ok).map((r) => r.service_name);
  return {
    title: "Báo giá tạm tính đi " + dest,
    headers: ["Hãng", "Cước", "Phụ phí", "VAT", "Tổng"],
    rows: served.map((r) => [
      r.service_name, fmtVND(r.base),
      r.surcharge ? fmtVND(r.surcharge) : "—",
      r.vat ? fmtVND(r.vat) : "—",
      fmtVND(r.total),
    ]),
    note: notServed.length ? ("Cần nhân viên báo giá riêng: " + notServed.join(", ")) : "",
  };
}

function stripTable(s) {
  return String(s || "").split("\n").filter((l) => !/^\s*\|/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { messages = [], sessionId = "" } = req.body || {};
    const convo = messages.map((m) => ({ role: m.role, content: m.content }));
    let quoted = false, table = null;

    for (let i = 0; i < 6; i++) {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 1024, system: SYSTEM, tools, messages: convo,
      });

      if (resp.stop_reason === "tool_use") {
        convo.push({ role: "assistant", content: resp.content });
        const results = [];
        for (const c of resp.content) {
          if (c.type !== "tool_use") continue;
          let out;
          if (c.name === "compare_carriers") {
            const rows = computeAllQuotes(c.input);
            table = buildTable(rows, c.input.destination_country);
            if (rows.some((r) => r.ok)) quoted = true;
            out = { rows };
          } else if (c.name === "save_lead") {
            out = await saveLead({ chat_id: sessionId, ...c.input });
          } else { out = { ok: false, error: "unknown tool" }; }
          results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out) });
        }
        convo.push({ role: "user", content: results });
        continue;
      }

      const text = stripTable(resp.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"));
      const buttons = quoted
        ? [{ title: "Liên hệ nhân viên", payload: "CONTACT" }, { title: "Booking", payload: "BOOKING" }]
        : [];
      return res.status(200).json({ reply: text, buttons, table });
    }
    return res.status(200).json({
      reply: "Dạ để chắc chắn, em nhờ nhân viên hỗ trợ mình nhé!",
      buttons: [{ title: "Liên hệ nhân viên", payload: "CONTACT" }], table: null,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
