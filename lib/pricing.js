// VNGROW pricing engine — tính cước bằng CODE (không để LLM tự tính).
import DB from "../data/pricing-data.js";

const norm = (s) => String(s ?? "").trim();
const upper = (s) => norm(s).toUpperCase();

const SERVICE_NAMES = {
  DHL: "DHL", FEDEX_IP: "FedEx IP", FEDEX_IE: "FedEx IE",
  EMS: "EMS", SPECIAL: "Chuyên tuyến",
};

function serviceReg(code) {
  const rows = DB.SERVICE_REGISTRY.filter((r) => r.service_code === code);
  return rows.find((r) => String(r.price_type).toLowerCase() === "flat") || rows[0] || null;
}

function findCountryRow(country) {
  const c = upper(country);
  return DB.COUNTRY_ZONE_MAPPING.find((r) => {
    if (upper(r.country_name) === c) return true;
    if (upper(r.country_code) === c) return true;
    const al = norm(r.aliases_vietnamese).toLowerCase();
    if (al) return al.split(/[;,|]/).map((x) => x.trim()).includes(country.trim().toLowerCase());
    return false;
  });
}

function chargeable(packages, divisor, step) {
  let gw = 0, vw = 0;
  for (const p of packages) {
    const q = Number(p.qty || 1);
    gw += Number(p.weight || 0) * q;
    const L = Number(p.L || 0), W = Number(p.W || 0), H = Number(p.H || 0);
    if (L && W && H) vw += (L * W * H / divisor) * q;
  }
  let cw = Math.max(gw, vw);
  cw = step > 0 ? Math.ceil(cw / step) * step : cw;
  return { gw: Math.round(gw * 100) / 100, vw: Math.round(vw * 100) / 100, cw };
}

export function computeQuote(input) {
  const {
    destination_country, service_code = "DHL", cargo_group = "normal",
    origin_city = "HCM", packages = [], direction = "export", invoice_vat = false,
  } = input;

  if (!destination_country) return { ok: false, reason: "Thiếu nước đến" };
  if (!packages.length || !packages.some((p) => Number(p.weight) > 0))
    return { ok: false, reason: "Thiếu cân nặng" };

  const reg = serviceReg(service_code);
  if (!reg) return { ok: false, reason: `Không có dịch vụ ${service_code}` };
  if (!reg.rate_tab || !DB.RATES[reg.rate_tab])
    return { ok: false, reason: `Dịch vụ ${service_code} chưa có bảng cước`, need_human: true };

  const divisor = Number(reg.vol_divisor) || 5000;
  const step = Number(reg.weight_round_step) || 0.5;
  const { gw, vw, cw } = chargeable(packages, divisor, step);

  const crow = findCountryRow(destination_country);
  const zone = crow ? norm(crow[reg.mapping_column]) : "";
  if (!zone) return { ok: false, reason: `Tuyến ${destination_country} qua ${SERVICE_NAMES[service_code] || service_code} chưa phục vụ`, need_human: true };

  const rateRows = DB.RATES[reg.rate_tab];
  const band = rateRows.find(
    (r) => Number(r.weight_from) <= cw && cw <= Number(r.weight_to) &&
           String(r.cargo_code || "normal") === "normal"
  );
  if (!band) return { ok: false, reason: `Cân ${cw}kg ngoài bảng cước`, need_human: true };
  const key = reg.rate_key_type === "country" ? destination_country : zone;
  const cell = Number(band[key]);
  if (!cell) return { ok: false, reason: `Chưa có giá tại ${key}/${cw}kg`, need_human: true };
  const base = String(band.price_type).toLowerCase() === "per_kg" ? cell * cw : cell;

  const surKey = reg.surcharge_service_key;
  const maxSide = Math.max(0, ...packages.map((p) => Math.max(+p.L || 0, +p.W || 0, +p.H || 0)));
  const maxPiece = Math.max(0, ...packages.map((p) => +p.weight || 0));
  const totalPkg = packages.reduce((a, p) => a + Number(p.qty || 1), 0);
  const addons = [], optional = [];

  if (surKey) {
    const rel = DB.SURCHARGE.filter(
      (s) => s.service_code === surKey && ["all", cargo_group].includes(s.cargo_code)
    );
    const amt = (s, n) => {
      const a = Number(s.surcharge_amount) || 0;
      const b = norm(s["billing_basis"]);
      let v = b === "per_kg" ? a * cw : b === "per_package" ? a * n
        : b === "per_all_package" ? a * totalPkg : a;
      const mn = Number(s.min_surcharge_amount) || 0;
      return Math.max(v, mn);
    };
    for (const s of rel) {
      const thr = Number(s.threshold_value);
      if (s.condition === "longest_side" && maxSide > thr) {
        const n = packages.filter((p) => Math.max(+p.L || 0, +p.W || 0, +p.H || 0) > thr).length;
        addons.push({ name: s.surcharge_type, amount: amt(s, n) });
      } else if (s.condition === "over_weight" && maxPiece > thr) {
        const n = packages.filter((p) => (+p.weight || 0) > thr).length;
        addons.push({ name: s.surcharge_type, amount: amt(s, n) });
      } else if (s.condition === "piece_weight" && maxPiece >= thr) {
        const note = norm(s.note);
        const ok = (origin_city === "HCM" && /Ho Chi Minh/i.test(note)) ||
                   (origin_city === "HN" && /Ha Noi/i.test(note));
        if (ok) addons.push({ name: s.surcharge_type, amount: amt(s, totalPkg) });
      } else if (s.condition === "manual" && s.cargo_code === cargo_group && cargo_group !== "normal") {
        // CHỈ nhắc phụ phí manual đúng loại hàng cụ thể (mỹ phẩm, thực phẩm...).
        // Bỏ các phụ phí cargo_code 'all' (hun trùng gỗ, FDA...) khỏi hàng thường.
        optional.push({ name: s.surcharge_type, amount: amt(s, totalPkg), note: norm(s.note) });
      }
    }
  }

  const sub = base + addons.reduce((a, x) => a + x.amount, 0);
  const vatPct = invoice_vat
    ? Number((DB.VAT.find((v) => v.direction === direction) || {}).vat_pct) || 0
    : 0;
  const vat = Math.round(sub * vatPct);
  const total = sub + vat;

  return {
    ok: true, service_code, service_name: SERVICE_NAMES[service_code] || service_code,
    destination_country, zone, gw, vw, cw, base, addons, optional, vat, total, currency: "VND",
  };
}

// So sánh tất cả hãng để báo giá dạng bảng.
export function computeAllQuotes(input) {
  const services = ["DHL", "FEDEX_IP", "FEDEX_IE", "EMS", "SPECIAL"];
  return services.map((sc) => {
    const q = computeQuote({ ...input, service_code: sc });
    return {
      service_code: sc,
      service_name: SERVICE_NAMES[sc],
      ok: q.ok,
      total: q.ok ? q.total : null,
      base: q.ok ? q.base : null,
      surcharge: q.ok ? q.addons.reduce((a, x) => a + x.amount, 0) : null,
      vat: q.ok ? q.vat : null,
      cw: q.ok ? q.cw : null,
      reason: q.ok ? null : q.reason,
    };
  });
}

export function fmtVND(n) {
  return Number(n).toLocaleString("vi-VN") + "đ";
}
