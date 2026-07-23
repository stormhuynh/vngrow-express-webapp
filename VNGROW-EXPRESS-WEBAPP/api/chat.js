import Anthropic from "@anthropic-ai/sdk";
import { computeQuote, computeAllQuotes, fmtVND } from "../lib/pricing.js";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_EXPRESS_BUSINESS,
});
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM = `Bạn là trợ lý báo giá của VNGROW - chuyển phát nhanh quốc tế từ Việt Nam đi nước ngoài. Xưng "em", gọi khách "anh/chị", lịch sự, chuyên nghiệp, NGẮN GỌN. Không đùa cợt quá đà.

NHIỆM VỤ: thu thập thông tin rồi báo giá.
Cần để báo giá: nước đến + cân nặng. Nên xin thêm KÍCH THƯỚC KIỆN và kho gửi để tính chính xác. Xin tên + SĐT để lưu hồ sơ, nhân viên hỗ trợ. KHÔNG chủ động xin email; chỉ xin email khi khách không cho SĐT mà muốn nhận báo giá/thông tin qua email. Thiếu gì hỏi nấy, mỗi lượt tối đa 2 ý.

CÁCH HỎI KÍCH THƯỚC (quan trọng): hỏi để tính đúng, KHÔNG hỏi kiểu "có cồng kềnh không". Diễn đạt: "Anh/chị cho em xin kích thước kiện (dài × rộng × cao, cm) để em tính cước chính xác, tránh phát sinh do trọng lượng quy đổi nhé." Nếu khách không có/không rõ, cứ tính theo cân thực và nói rõ giá có thể đổi nhẹ nếu kiện to.

TÍNH GIÁ: LUÔN gọi tool compare_carriers để lấy bảng so sánh các hãng (đừng tự tính). BẮT BUỘC phải đọc lại hội thoại để lấy TẤT CẢ kích thước (L, W, H) khách đã cho. Ví dụ khách nói "2 kiện 50x40x30, tổng 20kg", bạn phải chia đều cân nặng và truyền: packages: [{qty: 2, weight: 10, L: 50, W: 40, H: 30}]. TUYỆT ĐỐI KHÔNG bỏ sót L, W, H nếu khách đã nói. Mặc định origin HCM nếu khách chưa nói. cargo_group suy từ mô tả: quần áo/giày/túi = normal, mỹ phẩm = cosmetics, thực phẩm = food, điện tử = electricity, tài liệu = document, thực vật = plan.
- Sau khi gọi compare_carriers, hệ thống TỰ hiển thị BẢNG giá riêng cho khách. Bạn chỉ viết 1-2 câu dẫn ngắn gọn (vd "Dạ đây là báo giá tạm tính các hãng cho lô 5kg đi Mỹ ạ:"). TUYỆT ĐỐI KHÔNG tự vẽ bảng bằng ký tự "|", KHÔNG liệt kê lại tên hãng/giá trong câu trả lời — bảng đã có sẵn bên dưới.
- Ghi rõ đây là "giá tạm tính".

PHỤ PHÍ: chỉ nhắc phụ phí khi THỰC SỰ liên quan mặt hàng khách nói. Hàng thường (quần áo, giày, túi...) thì KHÔNG nhắc gì về gỗ, hun trùng, FDA. Đừng tự bịa tình huống phát sinh không liên quan.

GIẢI THÍCH SỐ LIỆU (rất quan trọng): mọi con số (cước, phụ phí, VAT, tổng) đều do tool tính ra và là SỐ CHÍNH THỨC — KHÔNG tự tính lại, KHÔNG tự phủ nhận, KHÔNG mâu thuẫn giữa các lượt. Khi khách hỏi "phụ phí gồm gì / vì sao 10 triệu / cước gồm gì", hãy đọc mảng "addons" của hãng đó trong kết quả tool và liệt kê ĐÚNG từng khoản kèm số tiền, ví dụ: "Dạ phụ phí gồm: Phí quá khổ (kiện trên 68kg) 7.000.000đ + Phí kích thước (1 chiều trên 120cm) 700.000đ + Phí xử lý kho HCM 5.000đ ạ." TUYỆT ĐỐI KHÔNG nói "phụ phí = 0" khi tool có phụ phí, KHÔNG bịa "bảo hiểm/hải quan" nếu tool không có. Nếu addons rỗng thì phụ phí đúng bằng 0. Nếu khách hỏi khoản mà bạn không có dữ liệu, nói "để nhân viên xác nhận chi tiết" — đừng chế số.

LƯU HỒ SƠ: khi có tên + SĐT hoặc vừa báo giá, gọi tool save_lead (kể cả khách chưa chốt). Điền ĐẦY ĐỦ các trường đã biết trong hội thoại: tên, SĐT (và email nếu khách cho), mô tả hàng, nước đến, kho gửi (HCM/HN), chiều (xuất/nhập), số kiện, tổng cân, giá tạm tính, và trạng thái phù hợp.

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
    description: "Ghi/cập nhật hồ sơ khách (lead) vào CRM sheet LEAD. Gọi khi có thông tin mới hoặc sau khi báo giá. Điền đầy đủ mọi trường đã biết trong hội thoại.",
    input_schema: {
      type: "object",
      properties: {
        contact_name: { type: "string", description: "Tên khách" },
        contact_phone: { type: "string", description: "SĐT khách" },
        contact_email: { type: "string", description: "Email khách — CHỈ điền khi khách chủ động cung cấp, không tự bịa" },
        cargo_description: { type: "string", description: "Mô tả hàng khách nói, vd 'quần áo', 'mỹ phẩm 5 hộp'" },
        destination_country: { type: "string", description: "Nước đến" },
        cargo_group: { type: "string", enum: ["normal", "cosmetics", "food", "electricity", "document", "plan", "other"] },
        origin_city: { type: "string", enum: ["HCM", "HN"], description: "Kho gửi" },
        direction: { type: "string", enum: ["export", "import"] },
        total_packages: { type: "number", description: "Tổng số kiện" },
        total_gw: { type: "number", description: "Tổng trọng lượng thực (kg)" },
        cargo_value: { type: "number", description: "Giá trị lô hàng nếu khách khai" },
        price_quote: { type: "number", description: "Giá tạm tính đã báo (VND, thường lấy mức thấp nhất)" },
        rfq_status: { type: "string", enum: ["collecting", "quoted", "booking_requested", "need_human"] },
        note: { type: "string", description: "Ghi chú thêm cho nhân viên nếu cần" },
      },
      required: ["rfq_status"],
    },
  },
];

// Bỏ các trường rỗng/null để không ghi đè giá trị AI đã cung cấp khi merge.
function pruneEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && v !== "" && !(typeof v === "number" && isNaN(v))) out[k] = v;
  }
  return out;
}

// Chuẩn hoá input tool + ngữ cảnh lô hàng (ctx) thành payload đúng tên cột sheet LEAD.
function buildLeadPayload(input, ctx, sessionId) {
  const merged = { ...input, ...pruneEmpty(ctx) }; // ctx (số liệu tính từ code) thắng khi có
  return {
    action: "saveLead",
    chat_id: sessionId,
    lead_name: merged.contact_name || "",
    tel: merged.contact_phone || "",
    email: merged.contact_email || "",
    cargo_description: merged.cargo_description || "",
    destination_country: merged.destination_country || "",
    total_packages: merged.total_packages ?? "",
    total_gw: merged.total_gw ?? "",
    total_vw: merged.total_vw ?? "",
    total_cw: merged.total_cw ?? "",
    origin_city: merged.origin_city || "",
    cargo_value: merged.cargo_value ?? "",
    currency: "VND",
    source: "chatbot",
    channel: "web-ai",
    price_quote: merged.price_quote ?? "",
    lead_status: merged.rfq_status || "collecting",
    note: [merged.dimensions ? `Kích thước: ${merged.dimensions}` : "", merged.note || ""].filter(Boolean).join(" - "),
  };
}

async function saveLead(input, ctx, sessionId) {
  const payload = buildLeadPayload(input, ctx, sessionId);
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) return { ok: true, note: "chưa cấu hình CRM webhook - bỏ qua" };
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
    note: [
      served.filter((r) => r.addons && r.addons.length)
        .map((r) => r.service_name + " — phụ phí gồm: " + r.addons.map((a) => a.name + " " + fmtVND(a.amount)).join(", "))
        .join("\n"),
      notServed.length ? ("Cần nhân viên báo giá riêng: " + notServed.join(", ")) : "",
    ].filter(Boolean).join("\n"),
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
    let quoted = false, table = null, leadCtx = {};

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
            const served = rows.filter((r) => r.ok);
            if (served.length) quoted = true;
            // Bắt ngữ cảnh lô hàng từ số liệu tính bằng code (chính xác hơn để AI tự khai).
            const pkgs = Array.isArray(c.input.packages) ? c.input.packages : [];
            const totalGw = pkgs.reduce((a, p) => a + Number(p.weight || 0) * Number(p.qty || 1), 0);
            const totalVw = pkgs.reduce((a, p) => {
              const L = Number(p.L || 0), W = Number(p.W || 0), H = Number(p.H || 0);
              return a + (L && W && H ? (L * W * H / 5000) * Number(p.qty || 1) : 0);
            }, 0);
            const totalPkgs = pkgs.reduce((a, p) => a + Number(p.qty || 1), 0);
            const cw = served.length ? Math.max(...served.map((r) => Number(r.cw) || 0)) : null;
            const best = served.length ? Math.min(...served.map((r) => Number(r.total))) : null;
            leadCtx = {
              destination_country: c.input.destination_country,
              origin_city: c.input.origin_city,
              direction: c.input.direction,
              cargo_group: c.input.cargo_group,
              total_packages: totalPkgs || null,
              total_gw: totalGw ? Math.round(totalGw * 100) / 100 : null,
              total_vw: totalVw ? Math.round(totalVw * 100) / 100 : null,
              total_cw: cw,
              price_quote: best,
              dimensions: pkgs.map(p => (p.L && p.W && p.H) ? `${p.qty||1} kiện ${p.L}x${p.W}x${p.H}cm` : "").filter(Boolean).join(", "),
            };
            out = { rows };
          } else if (c.name === "save_lead") {
            out = await saveLead(c.input, leadCtx, sessionId);
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
