import Anthropic from "@anthropic-ai/sdk";
import { computeQuote } from "../lib/pricing.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM = `Bạn là trợ lý báo giá của VNGROW - chuyển phát nhanh quốc tế từ Việt Nam đi nước ngoài. Xưng "em", gọi khách "anh/chị", trả lời NGẮN GỌN, thân thiện, tiếng Việt.

NHIỆM VỤ: thu thập thông tin rồi báo giá.
Cần để báo giá: nước đến + cân nặng. Xin thêm kích thước (nếu hàng cồng kềnh), loại hàng, tên + SĐT để lưu hồ sơ và nhân viên hỗ trợ. Thiếu gì hỏi nấy, mỗi lượt tối đa 2 ý.

TÍNH GIÁ: LUÔN gọi tool get_quote để lấy số (đừng tự tính). Mặc định service_code="DHL" nếu khách không nêu hãng. cargo_group suy từ mô tả hàng: quần áo/giày/túi=normal, mỹ phẩm=cosmetics, thực phẩm=food, điện tử=electricity, tài liệu=document, thực vật=plan.
- Nếu get_quote trả ok=false (need_human hoặc chưa phục vụ): xin lỗi nhẹ nhàng, đề nghị để nhân viên báo giá riêng, KHÔNG bịa số.
- Nếu ok=true: trình bày base + từng phụ phí (addons) + VAT + TỔNG. Nếu có optional thì nói "có thể phát sinh tuỳ mặt hàng: ...". Ghi rõ "giá tạm tính".

LƯU HỒ SƠ: khi đã có tên+SĐT hoặc vừa báo giá xong, gọi tool save_lead để ghi vào CRM (kể cả khách chưa chốt).

Sau khi báo giá xong, kết thúc bằng câu mời khách chọn "Liên hệ nhân viên" hoặc "Booking".`;

const tools = [
  {
    name: "get_quote",
    description: "Tính cước VNGROW theo bảng giá. Trả về base, addons (phụ phí), vat, total. Luôn dùng tool này để lấy con số, không tự tính.",
    input_schema: {
      type: "object",
      properties: {
        destination_country: { type: "string", description: "Tên nước đến, vd USA, JAPAN, AUSTRALIA" },
        service_code: { type: "string", enum: ["DHL", "FEDEX_IP", "FEDEX_IE", "EMS"], description: "Mặc định DHL" },
        cargo_group: { type: "string", enum: ["normal", "cosmetics", "food", "electricity", "document", "plan", "other"] },
        origin_city: { type: "string", enum: ["HCM", "HN"] },
        direction: { type: "string", enum: ["export", "import"] },
        invoice_vat: { type: "boolean", description: "true nếu khách lấy hoá đơn VAT" },
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
  if (!url) return { ok: true, note: "LEAD_WEBHOOK_URL chưa cấu hình - bỏ qua ghi CRM" };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, rfq_date: new Date().toISOString().slice(0, 10) }),
    });
    return { ok: r.ok };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function runTool(name, input) {
  if (name === "get_quote") return computeQuote(input);
  if (name === "save_lead") return saveLead(input);
  return { ok: false, error: "unknown tool" };
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
    let quoted = false;

    for (let i = 0; i < 6; i++) {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 1024, system: SYSTEM, tools, messages: convo,
      });

      if (resp.stop_reason === "tool_use") {
        convo.push({ role: "assistant", content: resp.content });
        const results = [];
        for (const c of resp.content) {
          if (c.type !== "tool_use") continue;
          const input = c.name === "save_lead" ? { chat_id: sessionId, ...c.input } : c.input;
          const out = await runTool(c.name, input);
          if (c.name === "get_quote" && out.ok) quoted = true;
          results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out) });
        }
        convo.push({ role: "user", content: results });
        continue;
      }

      const text = resp.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const buttons = quoted
        ? [{ title: "Liên hệ nhân viên", payload: "CONTACT" }, { title: "Booking", payload: "BOOKING" }]
        : [];
      return res.status(200).json({ reply: text, buttons });
    }
    return res.status(200).json({
      reply: "Dạ để chắc chắn, em nhờ nhân viên hỗ trợ mình nhé!",
      buttons: [{ title: "Liên hệ nhân viên", payload: "CONTACT" }],
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
