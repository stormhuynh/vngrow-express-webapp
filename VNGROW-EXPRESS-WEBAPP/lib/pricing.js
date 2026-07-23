// VNGROW pricing engine — tính cước bằng CODE (không để LLM tự tính).
import DB from "../data/pricing-data.js";

const norm = (s) => String(s ?? "").trim();
const upper = (s) => norm(s).toUpperCase();
const deaccent = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
const mkey = (s) => deaccent(String(s ?? "")).toUpperCase().trim();

const SERVICE_NAMES = {
  DHL: "DHL", FEDEX_IP: "FedEx IP", FEDEX_IE: "FedEx IE",
  EMS: "EMS", SPECIAL: "Chuyên tuyến",
};

function serviceReg(code) {
  const rows = DB.SERVICE_REGISTRY.filter((r) => r.service_code === code);
  return rows.find((r) => String(r.price_type).toLowerCase() === "flat") || rows[0] || null;
}

const COUNTRY_ALIASES = {
  "US": "UNITED STATES", "USA": "UNITED STATES", "AMERICA": "UNITED STATES", "MY": "UNITED STATES", "HOA KY": "UNITED STATES",
  "UK": "UNITED KINGDOM", "ENGLAND": "UNITED KINGDOM", "BRITAIN": "UNITED KINGDOM", "ANH": "UNITED KINGDOM",
  "KOREA": "KOREA, REP. OF", "SOUTH KOREA": "KOREA, REP. OF", "HAN QUOC": "KOREA, REP. OF", "HAN": "KOREA, REP. OF",
  "UAE": "UNITED ARAB EMIRATES", "DUBAI": "UNITED ARAB EMIRATES",
  "RUSSIA": "RUSSIAN FEDERATION", "NGA": "RUSSIAN FEDERATION",
  "HOLLAND": "NETHERLANDS, THE", "NETHERLANDS": "NETHERLANDS, THE", "HA LAN": "NETHERLANDS, THE",
  "CZECH": "CZECH REP., THE", "HONG KONG": "HONG KONG SAR CHINA", "HONGKONG": "HONG KONG SAR CHINA",
  "MACAU": "MACAU SAR CHINA", "MACAO": "MACAU SAR CHINA", "DAI LOAN": "TAIWAN",
  "CHINA": "CHINA *1", "TRUNG QUOC": "CHINA *1", "NHAT": "JAPAN", "NHAT BAN": "JAPAN",
  "UC": "AUSTRALIA", "DUC": "GERMANY", "PHAP": "FRANCE", "THAI LAN": "THAILAND",
  "CAMPUCHIA": "CAMBODIA", "LAO": "LAOS", "AN DO": "INDIA",
};

function canon(s) {
  return mkey(s).replace(/[.,*]/g, "").replace(/\b(REP OF|REP|THE|DPR|SAR CHINA|1|2)\b/g, " ").replace(/\s+/g, " ").trim();
}

function matchTarget(rows, target) {
  const t = mkey(target), ct = canon(target);
  return rows.find((r) => mkey(r.country_name) === t || mkey(r.country_code) === t || canon(r.country_name) === ct) || null;
}

function findCountryRow(country) {
  const rows = DB.COUNTRY_ZONE_MAPPING;
  const raw = norm(country);
  const c = mkey(raw);
  // 1. khớp chính xác tên / mã ISO
  let hit = rows.find((r) => mkey(r.country_name) === c || mkey(r.country_code) === c);
  if (hit) return hit;
  // 2. cột aliases_vietnamese
  hit = rows.find((r) => {
    const al = norm(r.aliases_vietnamese).toLowerCase();
    return al && al.split(/[;,|]/).map((x) => x.trim()).includes(raw.toLowerCase());
  });
  if (hit) return hit;
  // 3. alias dựng sẵn (khớp mềm theo tên/mã/canon)
  if (COUNTRY_ALIASES[c]) { hit = matchTarget(rows, COUNTRY_ALIASES[c]); if (hit) return hit; }
  // 4. so khớp canonical
  const cc = canon(raw);
  hit = rows.find((r) => canon(r.country_name) === cc);
  if (hit) return hit;
  // 5. tiền tố (KOREA -> KOREA REP OF)
  hit = rows.find((r) => cc.length >= 3 && canon(r.country_name).startsWith(cc));
  return hit || null;
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
    origin_city = "HCM", packages = [], direction = "export",
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
    // Các bậc cùng điều kiện là LOẠI TRỪ NHAU -> chỉ lấy 1 bậc ngưỡng cao nhất.
    const pickHighest = (arr) => arr.reduce((best, s) =>
      (Number(s.threshold_value) > Number((best || {}).threshold_value ?? -1) ? s : best), null);

    const sideTop = pickHighest(rel.filter((s) => s.condition === "longest_side" && maxSide > Number(s.threshold_value)));
    if (sideTop) {
      const n = packages.filter((p) => Math.max(+p.L || 0, +p.W || 0, +p.H || 0) > Number(sideTop.threshold_value)).length;
      addons.push({ name: sideTop.surcharge_type, amount: amt(sideTop, n) });
    }
    const wTop = pickHighest(rel.filter((s) => s.condition === "over_weight" && maxPiece > Number(s.threshold_value)));
    if (wTop) {
      const n = packages.filter((p) => (+p.weight || 0) > Number(wTop.threshold_value)).length;
      addons.push({ name: wTop.surcharge_type, amount: amt(wTop, n) });
    }
    const originRe = origin_city === "HN" ? /Ha Noi/i : /Ho Chi Minh/i;
    const hTop = pickHighest(rel.filter((s) => s.condition === "piece_weight" && maxPiece >= Number(s.threshold_value) && originRe.test(norm(s.note))));
    if (hTop) addons.push({ name: hTop.surcharge_type, amount: amt(hTop, totalPkg) });

    for (const s of rel) {
      if (s.condition === "manual" && s.cargo_code === cargo_group && cargo_group !== "normal") {
        optional.push({ name: s.surcharge_type, amount: amt(s, totalPkg), note: norm(s.note) });
      }
    }
  }

  const sub = base + addons.reduce((a, x) => a + x.amount, 0);
  const vatPct = Number((DB.VAT.find((v) => v.direction === direction) || {}).vat_pct) || 0;
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
      addons: q.ok ? q.addons : [],
      vat: q.ok ? q.vat : null,
      cw: q.ok ? q.cw : null,
      reason: q.ok ? null : q.reason,
    };
  });
}

export function fmtVND(n) {
  return Number(n).toLocaleString("vi-VN") + "đ";
}
