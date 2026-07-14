// ============================================================
// VNGROW Express Webapp — Google Apps Script
// Spreadsheet: https://docs.google.com/spreadsheets/d/1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc
// Deploy: Extensions > Apps Script > Deploy > New deployment > Web App
//   Execute as: Me | Who has access: Anyone
// ============================================================

// ID của file Google Sheet công khai phục vụ Webapp (Giá bán tĩnh)
const SS_ID = '1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc';

// ---- Helpers ------------------------------------------------

function getSheet(name) {
  return SpreadsheetApp.openById(SS_ID).getSheetByName(name);
}

function sheetToObjects(sheetName) {
  const sheet = getSheet(sheetName);
  if (!sheet) return [];
  const [headers, ...rows] = sheet.getDataRange().getValues();
  return rows
    .filter(r => r[0] !== '' && r[0] !== null)
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => {
        if (h) {
          // Normalize: "FEDEX IE" → "fedex_ie", "UPS Saver" → "ups_saver"
          const key = String(h).trim().toLowerCase().replace(/\s+/g, '_');
          obj[key] = r[i];
        }
      });
      return obj;
    });
}

function ok(data)  { return json({success: true,  data}); }
function err(msg)  { return json({success: false, error: msg}); }
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// ROUTING
// ============================================================

function doGet(e) {
  try {
    switch (e.parameter.action) {
      case 'getCountries':   return ok(getCountries());
      case 'getCargoGroups': return ok(getCargoGroups());
      case 'getRates':       return ok(getRates(e.parameter));
      case 'debugRates':     return ok(debugRates(e.parameter));
      case 'tracking':       return ok(getTracking(e.parameter.id));
      default:               return err('Unknown action: ' + e.parameter.action);
    }
  } catch (ex) { return err(ex.message); }
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    switch (d.action) {
      case 'submitRFQ':     return ok(submitRFQ(d));
      case 'submitBooking': return ok(submitBooking(d));
      default:              return err('Unknown action: ' + d.action);
    }
  } catch (ex) { return err(ex.message); }
}

// ============================================================
// CONFIG  (fuel surcharge + transit_time + VAT)
// ============================================================

function getConfig() {
  const sheet = getSheet('CONFIG');
  if (!sheet) {
    return {
      fuel: {
        'DHL': { fuel_pct: 19, transit_min: 3, transit_max: 5 },
        'FedEx IE': { fuel_pct: 20, transit_min: 4, transit_max: 5 },
        'FedEx IP': { fuel_pct: 20, transit_min: 7, transit_max: 9 },
        'UPS Saver': { fuel_pct: 19, transit_min: 9, transit_max: 10 },
        'UPS Expedited': { fuel_pct: 19, transit_min: 5, transit_max: 7 },
        'Special Route': { fuel_pct: 0, transit_min: 10, transit_max: 12 },
        'EMS': { fuel_pct: 0, transit_min: 7, transit_max: 10 }
      },
      vat: { 'export': 8, 'import': 0, 'special_route': 0 }
    };
  }
  
  const rows  = sheet.getDataRange().getValues();
  const fuel    = {};   
  const vat     = {};   
  let   section = null;

  for (const r of rows) {
    const a = String(r[0]).trim();
    const b = String(r[1]).trim();

    if (a === 'service'   && b === 'fuel_surcharge_pct') { section = 'fuel'; continue; }
    if (a === 'direction' && b === 'vat_pct')            { section = 'vat';  continue; }
    if (a === 'cargo_group')                             { section = null;   continue; }
    if (a === '')                                        { section = null;   continue; }

    if (section === 'fuel') {
      fuel[a] = {
        fuel_pct:     parseFloat(b.replace('%', '')) || 0,
        transit_min:  Number(r[2]) || 0,
        transit_max:  Number(r[3]) || 0,
      };
    }
    if (section === 'vat') {
      vat[a] = parseFloat(b.replace('%', '')) || 0;
    }
  }
  
  if (!fuel['EMS']) {
    fuel['EMS'] = { fuel_pct: 0, transit_min: 7, transit_max: 10 };
  }
  
  return { fuel, vat };
}

// ============================================================
// GET COUNTRIES
// ============================================================

function getCountries() {
  return sheetToObjects('COUNTRY_ZONE_MAPPING');
}

// ============================================================
// GET CARGO GROUPS
// ============================================================

function getCargoGroups() {
  const sheet = getSheet('CONFIG');
  if (!sheet) {
    return [
      { cargo_group: "Hàng thường", cargo_code: "normal", ghi_chu: "Giày dép, quần áo, túi xách..." },
      { cargo_group: "Mỹ phẩm", cargo_code: "cosmetics", ghi_chu: "Son, serum, dầu gội, kem..." },
      { cargo_group: "Thực phẩm", cargo_code: "food", ghi_chu: "Bánh, kẹo, mắm, trà, cà phê..." },
      { cargo_group: "Điện tử", cargo_code: "electricity", ghi_chu: "Điện thoại, laptop, phụ kiện..." },
      { cargo_group: "Tài liệu", cargo_code: "document", ghi_chu: "Hợp đồng, hồ sơ, sách..." },
      { cargo_group: "Khác", cargo_code: "other", ghi_chu: "Khác" }
    ];
  }
  
  const rows  = sheet.getDataRange().getValues();
  const groups = [];
  let inSection = false;

  for (const r of rows) {
    const a = String(r[0]).trim();
    if (a === 'cargo_group') { inSection = true; continue; }
    if (inSection && a === '') break;
    if (inSection) groups.push({ cargo_group: a, cargo_code: r[1], ghi_chu: r[2] });
  }
  return groups;
}

// ============================================================
// SERVICE MAPPING HELPERS
// ============================================================

function serviceToZoneKey(serviceName) {
  const s = String(serviceName).toUpperCase().trim();
  if (s === 'DHL') return 'dhl_zone';
  if (s === 'EMS') return 'ems_zone';
  if (s === 'FEDEX IP') return 'fedex_ip';
  if (s === 'FEDEX IE') return 'fedex_ie';
  if (s === 'FEDEX IPF') return 'fedex_ipf';
  if (s === 'FEDEX IEF') return 'fedex_ief';
  if (s === 'VIETTEL POST') return 'viettle_post_zone';
  return null;
}

function serviceToSheetName(serviceName) {
  const s = String(serviceName).toUpperCase().trim();
  if (s === 'DHL') return 'DHL_RATE';
  if (s === 'EMS') return 'EMS_RATE';
  if (s === 'FEDEX IP') return 'FEDEX_IP_RATE';
  if (s === 'FEDEX IE') return 'FEDEX_IE_RATE';
  if (s === 'FEDEX IPF') return 'FEDEX_IPF_RATE';
  if (s === 'FEDEX IEF') return 'FEDEX_IEF_RATE';
  if (s === 'VIETTEL POST') return 'VIETTEL_POST_RATE';
  return null;
}

function getSurchargeGroupKey(sType) {
  const prefixes = ['Phí kiểm dịch thực vật', 'Phí xử lý hàng xuất', 'Phụ thu Tranh tượng'];
  for (const p of prefixes) {
    if (sType.indexOf(p) !== -1) {
      return p;
    }
  }
  return sType;
}

// ============================================================
// RATE LOOKUP - RANGE BASED
// ============================================================

function normalizeZone(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (s === '' || s === '0' || s === '—') return null;
  if (/^zone_/i.test(s)) return s.toLowerCase();
  return 'zone_' + s;
}

// ============================================================
// CALCULATE SURCHARGES (DYNAMICAL & TIERED FILTER)
// ============================================================

function calculateSurcharges(service, cargoCode, cw, pieces, origin, destination) {
  const surchSheet = getSheet('SURCHARGE');
  if (!surchSheet) return [];
  
  const [headers, ...rows] = surchSheet.getDataRange().getValues();
  const surcharges = rows.map(r => {
    const obj = {};
    headers.forEach((h, i) => {
      if (h) {
        const key = String(h).trim().toLowerCase().replace(/\s+/g, '_');
        obj[key] = r[i];
      }
    });
    return obj;
  });

  const activeSurcharges = [];
  const normalizedSvc = service.toUpperCase().replace(/\s+/g, '');
  const normalizedCargo = cargoCode.trim().toLowerCase();
  
  let piecesList = [];
  if (pieces) {
    try {
      piecesList = typeof pieces === 'string' ? JSON.parse(pieces) : pieces;
    } catch(e) {}
  }

  surcharges.forEach(s => {
    if (!s.service) return;
    const sSvc = String(s.service).toUpperCase().replace(/\s+/g, '');
    if (sSvc !== normalizedSvc) return;

    const sCargo = String(s.cargo_code || '').trim().toLowerCase();
    if (sCargo !== 'all' && sCargo !== normalizedCargo) return;

    // Check Origin từ note
    const note = String(s.note || '').trim().toLowerCase();
    if (note.indexOf('origin ho chi minh') !== -1 && origin !== 'HCM') return;
    if (note.indexOf('origin ha noi') !== -1 && origin !== 'HN') return;

    // Check Destination cụ thể
    if (s.surcharge_type === 'Phí hun trùng Úc' && destination.toUpperCase() !== 'AUSTRALIA') return;
    if (s.surcharge_type === 'Phí hun trùng các nước khác' && destination.toUpperCase() === 'AUSTRALIA') return;

    // Đánh giá điều kiện kích thước/cân nặng
    const cond = String(s.condition || '').trim().toLowerCase();
    const threshold = parseFloat(s.threshold_value) || 0;
    let isTriggered = false;
    let multiplier = 0;

    if (cond === 'manual') {
      isTriggered = true;
      multiplier = 1;
    } else if (cond === 'remote_area') {
      isTriggered = false; // Flag từ Client xử lý riêng
    } else if (piecesList.length > 0) {
      piecesList.forEach(p => {
        const l = parseFloat(p.l) || 0;
        const w = parseFloat(p.w) || 0;
        const h = parseFloat(p.h) || 0;
        const gw = parseFloat(p.gw) || 0;
        
        const dims = [l, w, h].sort((a, b) => b - a);
        const longest = dims[0];
        const girth = (dims[1] + dims[2]) * 2;
        const lgSum = longest + girth;

        if (cond === 'longest_side' && longest > threshold) {
          isTriggered = true;
          multiplier++;
        } else if (cond === 'over_weight' && gw > threshold) {
          isTriggered = true;
          multiplier++;
        }
      });
    } else {
      if (cond === 'piece_weight' && cw >= threshold) {
        isTriggered = true;
        multiplier = 1;
      } else if (cond === 'not_over_weight' && cw < threshold) {
        isTriggered = true;
        multiplier = 1;
      }
    }

    if (isTriggered) {
      const amount = parseFloat(s.surcharge_amount) || 0;
      const minAmount = parseFloat(s.min_surcharge_amount) || 0;
      const basis = String(s.billing_basis || '').trim().toLowerCase();
      
      let finalCost = 0;
      if (basis === 'per_kg') {
        finalCost = amount * cw;
      } else if (basis === 'per_package') {
        finalCost = amount * (multiplier || 1);
      } else if (basis === 'per_all_package') {
        finalCost = amount * cw;
      } else if (basis === 'per_item_qty') {
        const qty = piecesList.length || 1;
        finalCost = amount * qty;
      } else {
        finalCost = amount;
      }

      if (minAmount > 0 && finalCost < minAmount) {
        finalCost = minAmount;
      }

      activeSurcharges.push({
        surcharge_type: s.surcharge_type,
        amount: Math.round(finalCost),
        threshold_value: threshold,
        condition: cond,
        note: s.note || ''
      });
    }
  });

  // Lọc phân cấp phụ phí (Tiered filter)
  const uniqueActive = [];
  const groups = {};
  
  activeSurcharges.forEach(s => {
    const gkey = getSurchargeGroupKey(s.surcharge_type);
    if (!groups[gkey]) {
      groups[gkey] = s;
    } else {
      const existing = groups[gkey];
      if (s.condition === 'not_over_weight') {
        // not_over_weight: lấy mốc nhỏ nhất
        if (s.threshold_value < existing.threshold_value) {
          groups[gkey] = s;
        }
      } else {
        // over_weight / piece_weight: lấy mốc lớn nhất
        if (s.threshold_value > existing.threshold_value) {
          groups[gkey] = s;
        }
      }
    }
  });

  for (const k in groups) {
    uniqueActive.push(groups[k]);
  }

  return uniqueActive;
}

// ============================================================
// GET RATES v2 — 1 nguồn giá cho Form + Chatbot
// Base (đã gồm fuel) + surcharge theo hàng + VAT trên (base+surcharge).
// KHÔNG cộng fuel riêng (đã gồm sẵn trong base).
// ============================================================

var _rateCache = {};
function _rateRows(sheetName) {
  if (_rateCache[sheetName]) return _rateCache[sheetName];
  var sh = getSheet(sheetName);
  if (!sh) return (_rateCache[sheetName] = null);
  var vals = sh.getDataRange().getValues();
  var H = vals[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var out = vals.slice(1).map(function (r) {
    var o = {}; H.forEach(function (h, i) { o[h] = r[i]; }); return o;
  });
  return (_rateCache[sheetName] = out);
}

function _findCountry(cmap, q) {
  var c = String(q || '').trim().toLowerCase();
  var hit = cmap.find(function (r) {
    return String(r.country_name).trim().toLowerCase() === c ||
           String(r.country_code).trim().toLowerCase() === c;
  });
  if (hit) return hit;
  return cmap.find(function (r) {
    var al = String(r.aliases_vietnamese || '').toLowerCase();
    return al && al.split(/[;,|]/).map(function (x) { return x.trim(); }).indexOf(c) >= 0;
  }) || null;
}

function _vatPct(direction) {
  var v = sheetToObjects('VAT').find(function (r) { return String(r.direction).trim() === direction; });
  return v ? (Number(v.vat_pct) || 0) : (direction === 'export' ? 0.08 : 0);
}

function _dedupeServices(sr) {
  var seen = {}, out = [];
  sr.forEach(function (s) { var k = String(s.service_code).trim(); if (!seen[k]) { seen[k] = 1; out.push(s); } });
  return out;
}

function _lookupBase(sheetName, baseCargo, cw, zone, keyType, mapVal) {
  var rr = _rateRows(sheetName); if (!rr) return null;
  var key = (keyType === 'country' ? String(mapVal) : String(zone)).trim().toLowerCase();
  var row = rr.find(function (r) {
    return String(r.cargo_code).trim().toLowerCase() === String(baseCargo).toLowerCase() &&
           Number(r.weight_from) <= cw && cw <= Number(r.weight_to);
  });
  if (!row) return null;
  var cell = Number(row[key]);
  if (!cell) return null;
  return String(row.price_type).trim().toLowerCase() === 'per_kg' ? cell * cw : cell;
}

function _computeSurcharge(surKey, cargoCode, packages, cw, originCity) {
  var all = sheetToObjects('SURCHARGE').filter(function (s) {
    return String(s.service_code).trim() === surKey &&
           ['all', cargoCode].indexOf(String(s.cargo_code).trim()) >= 0;
  });
  var maxSide = Math.max.apply(null, [0].concat(packages.map(function (p) { return Math.max(+p.L || 0, +p.W || 0, +p.H || 0); })));
  var maxPiece = Math.max.apply(null, [0].concat(packages.map(function (p) { return +p.weight || 0; })));
  var totalPkg = packages.reduce(function (a, p) { return a + (+p.qty || 1); }, 0);
  var totalKg = packages.reduce(function (a, p) { return a + (+p.weight || 0) * (+p.qty || 1); }, 0);
  function amt(s, n) {
    var a = Number(s.surcharge_amount) || 0, b = String(s.billing_basis || '').trim();
    var v = b === 'per_kg' ? a * cw : b === 'per_package' ? a * n : b === 'per_all_package' ? a * totalPkg : a;
    return Math.max(v, Number(s.min_surcharge_amount) || 0);
  }
  function pick(arr) { return arr.reduce(function (b, s) { return Number(s.threshold_value) > Number((b || {}).threshold_value != null ? b.threshold_value : -1) ? s : b; }, null); }
  var addons = [], optional = [];
  var sideTop = pick(all.filter(function (s) { return s.condition === 'longest_side' && maxSide > Number(s.threshold_value); }));
  if (sideTop) { var n1 = packages.filter(function (p) { return Math.max(+p.L || 0, +p.W || 0, +p.H || 0) > Number(sideTop.threshold_value); }).length; addons.push({ name: sideTop.surcharge_type, amount: amt(sideTop, n1) }); }
  var wTop = pick(all.filter(function (s) { return s.condition === 'over_weight' && maxPiece > Number(s.threshold_value); }));
  if (wTop) { var n2 = packages.filter(function (p) { return (+p.weight || 0) > Number(wTop.threshold_value); }).length; addons.push({ name: wTop.surcharge_type, amount: amt(wTop, n2) }); }
  var originRe = originCity === 'HN' ? /Ha Noi/i : /Ho Chi Minh/i;
  var hTop = pick(all.filter(function (s) { return s.condition === 'piece_weight' && maxPiece >= Number(s.threshold_value) && originRe.test(String(s.note || '')); }));
  if (hTop) addons.push({ name: hTop.surcharge_type, amount: amt(hTop, totalPkg) });
  var quar = all.filter(function (s) { return s.condition === 'not_over_weight' && totalKg <= Number(s.threshold_value); });
  if (quar.length) { var q = quar.reduce(function (a, b) { return Number(b.threshold_value) < Number(a.threshold_value) ? b : a; }); addons.push({ name: q.surcharge_type, amount: amt(q, 1) }); }
  all.forEach(function (s) {
    if (s.condition === 'manual' && String(s.cargo_code).trim() === cargoCode && cargoCode !== 'normal')
      optional.push({ name: s.surcharge_type, amount: amt(s, totalPkg), note: s.note });
  });
  return { addons: addons, optional: optional, total: addons.reduce(function (a, x) { return a + x.amount; }, 0) };
}

function getRates(params) {
  var country = params.country || '';
  var cargoCode = params.cargo_code || 'normal';
  var direction = params.direction || 'export';
  var originCity = String(params.origin_city || 'HCM').toUpperCase();
  var packages = params.packages;
  if (typeof packages === 'string') { try { packages = JSON.parse(packages); } catch (e) { packages = []; } }
  if (!Array.isArray(packages) || !packages.length) return { error: 'Thiếu packages' };
  if (!country) return { error: 'Thiếu tên quốc gia' };

  var cmap = sheetToObjects('COUNTRY_ZONE_MAPPING');
  var crow = _findCountry(cmap, country);
  if (!crow) return { error: 'Không tìm thấy quốc gia: ' + country };

  var vat = _vatPct(direction);
  var registry = _dedupeServices(sheetToObjects('SERVICE_REGISTRY'));
  var rates = [], notServed = [], gw = 0, vw = 0;

  registry.forEach(function (svc) {
    if (String(svc.status).trim() !== 'active') return;
    var divisor = Number(svc.vol_divisor) || 5000, step = Number(svc.weight_round_step) || 0.5;
    var g = 0, v = 0;
    packages.forEach(function (pk) {
      var q = +pk.qty || 1; g += (+pk.weight || 0) * q;
      var L = +pk.L || 0, W = +pk.W || 0, H = +pk.H || 0;
      if (L && W && H) v += (L * W * H / divisor) * q;
    });
    var cw = Math.max(g, v); cw = step > 0 ? Math.ceil(cw / step) * step : cw;
    gw = g; vw = Math.round(v * 100) / 100;

    if (!svc.rate_tab) { notServed.push(svc.service_name); return; }
    var mapCol = String(svc.mapping_column).trim().toLowerCase();
    var mapVal = crow[mapCol];
    var zone = normalizeZone(mapVal);
    if (!zone && svc.rate_key_type !== 'country') { notServed.push(svc.service_name); return; }
    var base = _lookupBase(svc.rate_tab, svc.base_cargo_code || 'normal', cw, zone, svc.rate_key_type, mapVal);
    if (base === null) { notServed.push(svc.service_name); return; }
    var sur = _computeSurcharge(String(svc.surcharge_service_key).trim(), cargoCode, packages, cw, originCity);
    var subtotal = base + sur.total;
    var vatAmt = Math.round(subtotal * vat);
    rates.push({
      service: svc.service_code, service_name: svc.service_name, zone: zone || String(mapVal), cw: cw,
      base: Math.round(base),
      addons: sur.addons.map(function (a) { return { name: a.name, amount: Math.round(a.amount) }; }),
      surcharge_total: Math.round(sur.total), optional: sur.optional,
      vat: vatAmt, vat_pct: vat, total: subtotal + vatAmt
    });
  });

  rates.sort(function (a, b) { return a.total - b.total; });
  return { rates: rates, not_served: notServed, gw: gw, vw: Math.round(vw * 100) / 100 };
}

function debugRates(params) {
  const country    = params.country    || 'USA';
  const cargoCode  = params.cargo_code || 'normal';
  const cw         = parseFloat(params.cw) || 20;
  return { success: true, message: "Debug is disabled, calculation engine is upgraded!" };
}

// ============================================================
// OVERSIZE CHECK (Hỗ trợ kiểm tra cả mảng kiện JSON và kiện đơn lẻ)
// ============================================================

function checkOversize(params, activeServices) {
  let pieces = [];
  if (params.pieces) {
    try {
      pieces = JSON.parse(params.pieces);
    } catch (e) {
      // Bỏ qua
    }
  }
  
  if (pieces.length === 0) {
    const l  = parseFloat(params.piece_l)  || 0;
    const w  = parseFloat(params.piece_w)  || 0;
    const h  = parseFloat(params.piece_h)  || 0;
    const gw = parseFloat(params.piece_gw) || 0;
    if (l > 0 || w > 0 || h > 0 || gw > 0) {
      pieces.push({ l, w, h, gw });
    }
  }
  
  if (pieces.length === 0) return [];

  const rules = sheetToObjects('SURCHARGE_OVERSIZE');
  if (rules.length === 0) return [];
  
  const warnings = [];
  const triggeredRules = new Set();

  for (let pIdx = 0; pIdx < pieces.length; pIdx++) {
    const piece = pieces[pIdx];
    const l  = parseFloat(piece.l)  || 0;
    const w  = parseFloat(piece.w)  || 0;
    const h  = parseFloat(piece.h)  || 0;
    const gw = parseFloat(piece.gw) || 0;
    
    const dims    = [l, w, h].sort((a, b) => b - a);
    const longest = dims[0];
    const girth   = (dims[1] + dims[2]) * 2;
    const lgSum   = longest + girth;

    for (const rule of rules) {
      if (!activeServices.includes(rule.service)) continue;
      const threshold = parseFloat(rule.threshold_value) || 0;
      let triggered = false;

      if (rule.condition === 'cạnh dài nhất'    && longest > threshold) triggered = true;
      if (rule.condition === 'length + girth'   && lgSum   > threshold) triggered = true;
      if (rule.condition === 'trọng lượng/kiện' && gw      > threshold) triggered = true;

      if (triggered) {
        const ruleKey = rule.service + '_' + rule.surcharge_type + '_' + rule.condition;
        if (!triggeredRules.has(ruleKey)) {
          triggeredRules.add(ruleKey);
          warnings.push({
            service:        rule.service,
            surcharge_type: rule.surcharge_type,
            condition:      rule.condition,
            threshold:      threshold,
            unit:           rule.unit,
          });
        }
      }
    }
  }
  return warnings;
}

// ============================================================
// TRACKING
// ============================================================

function getTracking(id) {
  if (!id) return { error: 'Thiếu mã vận đơn' };

  const shipments = sheetToObjects('SHIPMENT');
  const shipment  = shipments.find(s =>
    String(s.id_shipment) === String(id) || String(s.booking_id) === String(id)
  );
  if (!shipment) return { error: 'Không tìm thấy lô hàng: ' + id };

  const timeline = sheetToObjects('SHIPMENT_TIMELINE')
    .filter(t => String(t.id_shipment) === String(shipment.id_shipment))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return { shipment, timeline };
}

// ============================================================
// SAVE BASE64 UPLOADS TO GOOGLE DRIVE
// ============================================================

function saveFilesToDrive(files, prefix) {
  if (!files || !files.length) return '';
  
  let folder;
  try {
    const folders = DriveApp.getFoldersByName("VNGROW Express Attachments");
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = DriveApp.createFolder("VNGROW Express Attachments");
    }
  } catch (e) {
    folder = DriveApp;
  }
  
  const urls = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      let base64Data = f.base64;
      if (base64Data.indexOf(',') !== -1) {
        base64Data = base64Data.split(',')[1];
      }
      const bytes = Utilities.base64Decode(base64Data);
      const blob = Utilities.newBlob(bytes, f.type, prefix + "_" + f.name);
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      urls.push(file.getUrl());
    } catch (e) {
      Logger.log("Error saving file to Drive: " + e.message);
    }
  }
  return urls.join(', ');
}

// ============================================================
// SUBMIT RFQ
// ============================================================

function submitRFQ(d) {
  const sheet = getSheet('RFQ');
  const id    = 'RFQ-' + Date.now();
  const now   = new Date();

  let fileUrls = '';
  if (d.files && d.files.length) {
    fileUrls = saveFilesToDrive(d.files, id);
  }

  const values = {
    id_rfq: id,
    created_date: now,
    contact_name: d.contact_name || d.name || '',
    contact_phone: d.contact_phone || d.phone || '',
    contact_email: d.contact_email || d.email || '',
    contact_company: d.contact_company || d.company || '',
    direction: d.direction || 'export',
    origin_country: d.origin_country || 'Việt Nam',
    destination_country: d.destination_country || d.country || '',
    cargo_group: d.cargo_group || '',
    cargo_description: d.cargo_description || '',
    total_packages: d.total_packages || d.package_quantity || 0,
    total_gw: d.total_gw || d.gross_weight || 0,
    special_requirements: d.special_requirements || d.notes || '',
    file_attachments: fileUrls,
    assigned_to: '',
    id_booking: '',
    price_quote: '',
    internal_notes: '',
    status: 'Chưa tiếp nhận',
  };

  appendRowByHeader(sheet, values);
  return { id };
}

// ============================================================
// SUBMIT BOOKING
// ============================================================

function submitBooking(d) {
  const sheet = getSheet('BOOKING');
  const id    = 'BK-' + Date.now();
  const now   = new Date();
  
  if (d.id_rfq) {
    try {
      const rfqSheet = getSheet('RFQ');
      if (rfqSheet) {
        const rfqHeaders = rfqSheet.getRange(1, 1, 1, rfqSheet.getLastColumn()).getValues()[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
        const rfqRows = rfqSheet.getDataRange().getValues().slice(1);
        const rfqRowIdx = rfqRows.findIndex(r => String(r[rfqHeaders.indexOf('id_rfq')]).trim() === String(d.id_rfq).trim());
        if (rfqRowIdx !== -1) {
          const rfqRow = rfqRows[rfqRowIdx];
          const rfq = {};
          rfqHeaders.forEach((h, idx) => { rfq[h] = rfqRow[idx]; });
          
          d.direction = d.direction || rfq.direction;
          d.origin_country = d.origin_country || rfq.origin_country;
          d.destination_country = d.destination_country || rfq.destination_country;
          d.creator_name = d.creator_name || rfq.contact_name;
          d.creator_phone = d.creator_phone || rfq.contact_phone;
          d.creator_email = d.creator_email || rfq.contact_email;
          d.creator_company = d.creator_company || rfq.contact_company;
          d.total_packages = d.total_packages || rfq.total_packages;
          d.total_gw = d.total_gw || rfq.total_gw;
        }
      }
    } catch (e) {
      Logger.log("Error pre-filling from RFQ: " + e.message);
    }
  }

  const values = {
    id_rfq: d.id_rfq || '',
    id_booking: id,
    created_date: now,
    service: d.service || '',
    direction: d.direction || 'export',
    origin_country: d.origin_country || 'Việt Nam',
    destination_country: d.destination_country || '',
    creator_name: d.creator_name || '',
    creator_phone: d.creator_phone || '',
    creator_email: d.creator_email || '',
    creator_company: d.creator_company || '',
    sender_name: d.sender_name || '',
    sender_phone: d.sender_phone || '',
    sender_address: d.sender_address || '',
    receiver_name: d.receiver_name || '',
    receiver_phone: d.receiver_phone || '',
    receiver_address: d.receiver_address || '',
    receiver_country: d.receiver_country || '',
    hs_code: d.hs_code || '',
    total_packages: d.total_packages || 0,
    total_gw: d.total_gw || 0,
    total_cw: d.total_cw || 0,
    total_cw_confirmed: '',
    package_details: JSON.stringify(d.package_details || []),
    assigned_to: '',
    price_quote: d.price || d.price_quote || '',
    price_confirmed: '',
    internal_notes: '',
    status: 'Chưa tiếp nhận',
    id_shipment: '',
  };

  appendRowByHeader(sheet, values);
  return { id };
}

// ============================================================
// ETA CALCULATOR
// ============================================================

function onTimelineEdit(e) {
  const sheet = e.source.getActiveSheet();
  if (sheet.getName() !== 'SHIPMENT_TIMELINE') return;

  const row = e.range.getRow();
  if (row < 2) return;

  const values  = sheet.getRange(row, 1, 1, 7).getValues()[0];
  const status  = String(values[2]).trim();   
  if (status !== 'Đã nhận được hàng') return;

  const shipmentId = String(values[1]).trim(); 
  const timestamp  = values[5];                

  const shipmentSheet = getSheet('SHIPMENT');
  const [headers, ...rows] = shipmentSheet.getDataRange().getValues();
  const idCol      = headers.indexOf('id_shipment');
  const serviceCol = headers.indexOf('service');
  const etaCol     = headers.indexOf('eta_date');

  const shipRow = rows.findIndex(r => String(r[idCol]) === shipmentId);
  if (shipRow === -1 || etaCol === -1) return;

  const service = String(rows[shipRow][serviceCol]);
  const cfg     = getConfig();
  const fcfg    = cfg.fuel[service] || { transit_max: 5 };
  const eta     = addBusinessDays(timestamp, fcfg.transit_max);

  shipmentSheet.getRange(shipRow + 2, etaCol + 1).setValue(eta);
}

// ============================================================
// GOOGLE SHEETS ONEDIT TRIGGER
// ============================================================

function onEdit(e) {
  if (!e) return;
  try {
    const sheet = e.source.getActiveSheet();
    const range = e.range;
    const sheetName = sheet.getName();
    const row = range.getRow();
    const col = range.getColumn();
    
    if (row < 2) return; 
    
    if (sheetName === 'BOOKING') {
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
      const statusColIndex = headers.indexOf('status') + 1;
      
      if (col === statusColIndex) {
        const val = String(range.getValue()).trim();
        if (val === 'Tạo shipment') {
          createShipmentFromBooking(sheet, row);
        }
      }
    }
    
    if (sheetName === 'SHIPMENT_TIMELINE') {
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
      const statusColIndex = headers.indexOf('status') + 1;
      if (col === statusColIndex) {
        const val = String(range.getValue()).trim();
        if (val === 'Đã nhận được hàng') {
          onTimelineEdit(e);
        }
      }
    }
  } catch (ex) {
    Logger.log("onEdit error: " + ex.message);
  }
}

// ============================================================
// TẠO SHIPMENT TỰ ĐỘNG TỪ BOOKING
// ============================================================

function createShipmentFromBooking(bookingSheet, row) {
  const headers = bookingSheet.getRange(1, 1, 1, bookingSheet.getLastColumn()).getValues()[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
  const rowValues = bookingSheet.getRange(row, 1, 1, bookingSheet.getLastColumn()).getValues()[0];
  
  const booking = {};
  headers.forEach((h, i) => {
    if (h) booking[h] = rowValues[i];
  });
  
  if (booking.id_shipment && String(booking.id_shipment).trim() !== '') {
    return;
  }
  
  const now = new Date();
  const timestamp = now.getTime();
  const dayStr = ('0' + now.getDate()).slice(-2);
  const shipmentId = 'S' + dayStr + '-' + timestamp;
  
  const idShipmentColIndex = headers.indexOf('id_shipment') + 1;
  if (idShipmentColIndex > 0) {
    bookingSheet.getRange(row, idShipmentColIndex).setValue(shipmentId);
  }
  
  const shipmentSheet = getSheet('SHIPMENT');
  if (shipmentSheet) {
    const sHeaders = shipmentSheet.getRange(1, 1, 1, shipmentSheet.getLastColumn()).getValues()[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
    const sRow = getFirstEmptyRowInColumn(shipmentSheet, 1);
    
    shipmentSheet.getRange(sRow, 1).setValue(shipmentId);
    
    const lastUpdateColIndex = sHeaders.indexOf('last_update') + 1;
    if (lastUpdateColIndex > 0) {
      shipmentSheet.getRange(sRow, lastUpdateColIndex).setValue(now);
    }
  }
  
  const timelineSheet = getSheet('SHIPMENT_TIMELINE');
  if (timelineSheet) {
    const tHeaders = timelineSheet.getRange(1, 1, 1, timelineSheet.getLastColumn()).getValues()[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
    const tRow = timelineSheet.getLastRow() + 1;
    const tId = tRow - 1; 
    
    const tValues = {
      id_timeline: tId,
      id_shipment: shipmentId,
      status: 'Đã tiếp nhận',
      location: 'Kho VNGROW',
      description: 'Hệ thống tự động tạo shipment từ booking ' + (booking.id_booking || ''),
      timestamp: now,
      updated_by: 'System'
    };
    
    timelineSheet.appendRow(tHeaders.map(h => tValues[h] !== undefined ? tValues[h] : ''));
  }
}

function getFirstEmptyRowInColumn(sheet, col) {
  const lastRow = sheet.getLastRow();
  if (lastRow === 0) return 1;
  const values = sheet.getRange(1, col, lastRow, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === "" || values[i][0] === null) {
      return i + 1;
    }
  }
  return lastRow + 1;
}

// ============================================================
// GOOGLE SHEETS SIDEBAR & MENU (VNGROW TOOL)
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('VNGROW Tool')
    .addItem('🤖 Nhập giá cước AI', 'showSidebar')
    .addItem('📤 Đẩy giá bán sang Webapp (Value Only)', 'exportSellingRatesToPublic')
    .addItem('📄 Xuất file tri thức tối ưu cho AI', 'exportOptimizedGeminiKnowledge')
    .addToUi();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('VNGROW AI Rate Importer')
    .setWidth(350);
  SpreadsheetApp.getUi().showSidebar(html);
}

function getCountriesList() {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('COUNTRY_ZONE_MAPPING') || getSheet('COUNTRY_ZONE_MAPPING');
    const [headers, ...rows] = sheet.getDataRange().getValues();
    return rows
      .filter(r => r[0] !== '' && r[0] !== null)
      .map(r => {
        const obj = {};
        headers.forEach((h, i) => {
          if (h) {
            const key = String(h).trim().toLowerCase().replace(/\s+/g, '_');
            obj[key] = r[i];
          }
        });
        return obj;
      });
  } catch (e) {
    return [];
  }
}

function getGeminiApiKey() {
  const configSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('CONFIG');
  if (!configSheet) return null;
  const rows = configSheet.getDataRange().getValues();
  for (const r of rows) {
    if (String(r[0]).trim().toLowerCase() === 'gemini_api_key') {
      return String(r[1]).trim();
    }
  }
  return null;
}

function getGeminiPrompt(agent, carrier, direction, country) {
  return `
Bạn là chuyên gia phân tích dữ liệu Logistics quốc tế. Hãy phân tích tài liệu đính kèm là bảng giá của đại lý "${agent}" cung cấp cho hãng/dịch vụ "${carrier}", chiều vận chuyển "${direction}", đi nước đến "${country}".

Nhiệm vụ của bạn là trích xuất bảng giá này thành một mảng JSON có cấu trúc chuẩn như sau:

[
  {
    "weight_min": number,
    "weight_max": number,
    "rate_type": "flat" hoặc "per_kg",
    "cost_rate": number,
    "cargo_group": "normal" hoặc "food" hoặc "cosmetics" hoặc "electricity" hoặc "other"
  }
]

Các quy tắc xử lý dữ liệu và tính toán bắt buộc:
1. Xác định nhóm hàng (cargo_group):
- Nếu bảng cước chia cột hoặc chia khu vực theo nhóm hàng:
  + "Thông thường" / "Hàng thường" -> cargo_group: "normal"
  + "Thực phẩm + Mỹ phẩm" -> tạo thành 2 dòng riêng biệt: 1 dòng cargo_group: "food" và 1 dòng cargo_group: "cosmetics" với các giá trị mốc cân và cước giống hệt nhau.
  + "Hàng khó" / "Thịt heo, bia..." -> cargo_group: "other"
- Nếu không chia cột nhóm hàng, mặc định là cargo_group: "normal".

2. Quy đổi mốc cân nặng (Weight Brackets) dưới 21kg:
- Nếu đại lý báo giá dạng khoảng (ví dụ: "6 - 15 kgs | đơn giá 195.000 VND / KG"), và đây là cước trọn gói (flat rate) cho từng kg hoặc nửa kg:
  Bạn phải TỰ ĐỘNG CHIA NHỎ và sinh ra các dòng mốc cân cách nhau mỗi 1.0 kg (hoặc 0.5 kg).
  Với mỗi mốc cân đó, bạn phải tự nhân (Cân nặng x Đơn giá/kg) để tính ra số tiền tĩnh ("rate_type": "flat").
  Ví dụ: Mức "6 - 15 kgs" đơn giá "195.000 / KG" sẽ được sinh ra thành:
    {"weight_min": 6.0, "weight_max": 6.0, "rate_type": "flat", "cost_rate": 1170000} (vì 6 x 195k)
    {"weight_min": 7.0, "weight_max": 7.0, "rate_type": "flat", "cost_rate": 1365000} (vì 7 x 195k)
    ...
    {"weight_min": 15.0, "weight_max": 15.0, "rate_type": "flat", "cost_rate": 2925000} (vì 15 x 195k)

3. Quy đổi mốc cân nặng lớn hơn hoặc bằng 21kg:
- Giữ nguyên khoảng cân của đại lý (không cần chia lẻ từng kg).
- Đặt "rate_type": "per_kg".
- "cost_rate" là đơn giá trên mỗi kg của đại lý.
- Đối với khoảng mở như ">50kg" hoặc "trên 50kg", hãy giới hạn max là 500.0 (Ví dụ: weight_min = 50.01, weight_max = 500.0).

Hãy trả về duy nhất chuỗi dữ liệu JSON dạng mảng (không bọc trong thẻ ký tự markdown \`\`\`json).
`;
}

function analyzeRateSheetWithGemini(fileBase64, mimeType, agent, carrier, direction, country) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return { success: false, error: "Chưa cấu hình 'gemini_api_key' ở cột B trong sheet CONFIG của bảng tính này." };
  }

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + apiKey;
  
  const payload = {
    contents: [
      {
        parts: [
          { text: getGeminiPrompt(agent, carrier, direction, country) },
          {
            inlineData: {
              mimeType: mimeType,
              data: fileBase64
            }
          }
        ]
      }
    ]
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const resText = response.getContentText();
    const resJson = JSON.parse(resText);
    
    if (resJson.candidates && resJson.candidates[0]?.content?.parts[0]?.text) {
      let text = resJson.candidates[0].content.parts[0].text.trim();
      if (text.startsWith("```json")) {
        text = text.substring(7);
      }
      if (text.endsWith("```")) {
        text = text.substring(0, text.length - 3);
      }
      const data = JSON.parse(text.trim());
      return { success: true, data: data };
    } else {
      return { success: false, error: "AI không trả về kết quả hợp lệ: " + resText };
    }
  } catch (e) {
    return { success: false, error: "Lỗi kết nối Gemini API: " + e.message };
  }
}

function writeRatesToSheet(rates, agent, carrier, direction, country) {
  try {
    const activeSs = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = activeSs.getSheetByName('PRICE_DATABASE');
    if (!sheet) {
      sheet = activeSs.insertSheet('PRICE_DATABASE');
      sheet.appendRow([
        'carrier', 'agent_name', 'direction', 'country', 'cargo_group', 
        'weight_min', 'weight_max', 'rate_type', 'cost_rate', 'last_update'
      ]);
    }
    
    const [headers, ...rows] = sheet.getDataRange().getValues();
    const carrierCol = headers.indexOf('carrier');
    const agentCol   = headers.indexOf('agent_name');
    const dirCol     = headers.indexOf('direction');
    const countryCol = headers.indexOf('country');
    
    for (let i = rows.length; i >= 1; i--) {
      const r = rows[i - 1];
      if (
        String(r[carrierCol]).trim().toLowerCase() === carrier.trim().toLowerCase() &&
        String(r[agentCol]).trim().toLowerCase() === agent.trim().toLowerCase() &&
        String(r[dirCol]).trim().toLowerCase() === direction.trim().toLowerCase() &&
        String(r[countryCol]).trim().toLowerCase() === country.trim().toLowerCase()
      ) {
        sheet.deleteRow(i + 1); 
      }
    }
    
    const now = new Date();
    rates.forEach(r => {
      const cargo = r.cargo_group || 'normal';
      
      const values = {
        carrier: carrier,
        agent_name: agent,
        direction: direction,
        country: country,
        cargo_group: cargo,
        weight_min: r.weight_min,
        weight_max: r.weight_max,
        rate_type: r.rate_type,
        cost_rate: r.cost_rate,
        last_update: now
      };
      
      const sHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const rowVal = sHeaders.map(h => {
        if (!h) return '';
        const key = String(h).trim().toLowerCase().replace(/\s+/g, '_');
        return values[key] !== undefined ? values[key] : '';
      });
      sheet.appendRow(rowVal);
    });
    
    return { success: true };
  } catch (e) {
    return { success: false, error: "Lỗi ghi dữ liệu cước: " + e.message };
  }
}

// ============================================================
// ĐỒNG BỘ DỮ LIỆU SANG FILE WEBAPP CÔNG KHAI (VALUE ONLY)
// ============================================================

function exportSellingRatesToPublic() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    'Xác nhận đẩy giá bán',
    'Hệ thống sẽ sao chép toàn bộ các bảng giá bán (Value Only) từ file nội bộ này sang file Webapp công khai. Bạn có chắc chắn muốn thực hiện?',
    ui.ButtonSet.YES_NO
  );
  
  if (response !== ui.Button.YES) return;
  
  try {
    const publicSs = SpreadsheetApp.openById(SS_ID);
    const activeSs = SpreadsheetApp.getActiveSpreadsheet();
    
    const sheetsToExport = [
      'DHL_RATE', 'SURCHARGE', 'CONFIG', 'COUNTRY_ZONE_MAPPING'
    ];
    
    let count = 0;
    sheetsToExport.forEach(name => {
      const srcSheet = activeSs.getSheetByName(name);
      if (!srcSheet) return;
      
      let destSheet = publicSs.getSheetByName(name);
      if (!destSheet) {
        destSheet = publicSs.insertSheet(name);
      } else {
        destSheet.clear();
      }
      
      const range = srcSheet.getDataRange();
      const values = range.getValues();
      
      destSheet.getRange(1, 1, values.length, values[0].length).setValues(values);
      count++;
    });
    
    ui.alert('Thành công', 'Đã đồng bộ ' + count + ' bảng giá bán tĩnh (Value Only) sang Webapp thành công!', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Lỗi đồng bộ', 'Không thể đồng bộ dữ liệu: ' + e.message, ui.ButtonSet.OK);
  }
}

// ============================================================
// XUẤT FILE TRI THỨC TỐI ƯU CHO GEMINI GEM
// ============================================================

function exportOptimizedGeminiKnowledge() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    'Tạo file tri thức tối ưu',
    'Hệ thống sẽ tổng hợp toàn bộ các bảng cước bán hàng hiện tại, tính sẵn giá bán cuối cùng (gồm cước + phụ phí nhiên liệu + VAT) cho từng quốc gia và mốc cân để tạo thành 1 file CSV phẳng siêu nhẹ. Bạn muốn tiếp tục?',
    ui.ButtonSet.YES_NO
  );
  
  if (response !== ui.Button.YES) return;
  
  try {
    const activeSs = SpreadsheetApp.getActiveSpreadsheet();
    const countries = getCountriesList();
    if (countries.length === 0) {
      ui.alert('Lỗi', 'Không tìm thấy dữ liệu nước đi trong sheet COUNTRY_ZONE_MAPPING.', ui.ButtonSet.OK);
      return;
    }
    
    const cfg = getConfig();
    
    const csvData = [
      ['Hãng bay', 'Chiều', 'Nước đến', 'Nhóm hàng', 'Số KG', 'Giá cước bán (VND) gồm xăng và VAT']
    ];
    
    // Tự động tìm kiếm các sheet cước của hãng
    const rateSheets = [
      { name: 'DHL_RATE', carrier: 'DHL' },
      { name: 'FEDEX_IE_RATE', carrier: 'FedEx IE' },
      { name: 'FEDEX_IP_RATE', carrier: 'FedEx IP' },
      { name: 'UPS_SAVER_RATE', carrier: 'UPS Saver' },
      { name: 'UPS_EXPEDITED_RATE', carrier: 'UPS Expedited' },
      { name: 'EMS_RATE', carrier: 'EMS' },
      { name: 'VIETTEL_POST_RATE', carrier: 'Viettel Post' }
    ];
    
    countries.forEach(c => {
      const countryName = c.country_name || c.country || '';
      if (!countryName) return;
      
      rateSheets.forEach(rs => {
        const zoneKey = serviceToZoneKey(rs.carrier);
        if (!zoneKey) return;
        const zoneHeader = c[zoneKey];
        if (!zoneHeader || zoneHeader === '' || zoneHeader === '—') return;
        
        const sheet = activeSs.getSheetByName(rs.name);
        if (!sheet) return;
        
        const [headers, ...rows] = sheet.getDataRange().getValues();
        const zone = normalizeZone(zoneHeader);
        
        let zoneCol = zone ? headers.findIndex(h => String(h).trim().toLowerCase() === zone.toLowerCase()) : -1;
        if (zoneCol === -1) {
          zoneCol = headers.findIndex(h => String(h).trim().toLowerCase() === String(zoneHeader).trim().toLowerCase());
        }
        if (zoneCol === -1) return;
        
        const cargoCol = headers.findIndex(h => String(h).trim().toLowerCase() === 'cargo_code');
        const typeCol  = headers.findIndex(h => String(h).trim().toLowerCase() === 'price_type');
        const fromCol  = headers.findIndex(h => String(h).trim().toLowerCase() === 'weight_from');
        const toCol    = headers.findIndex(h => String(h).trim().toLowerCase() === 'weight_to');
        
        if (cargoCol === -1 || fromCol === -1 || toCol === -1) return;

        rows.forEach(r => {
          const cargoGroupName = String(r[cargoCol]).trim();
          const rType = typeCol !== -1 ? String(r[typeCol]).trim().toLowerCase() : 'flat';
          const rFrom = parseFloat(String(r[fromCol]).replace(',', '.'));
          const rTo = parseFloat(String(r[toCol]).replace(',', '.'));
          const rateVal = Number(r[zoneCol]);
          
          if (cargoGroupName && !isNaN(rFrom) && rateVal > 0) {
            const fcfg = cfg.fuel[rs.carrier] || { fuel_pct: 0 };
            
            // Xử lý các khoảng cân chi tiết từ from -> to
            const weightStep = rFrom; 
            let baseFreight = rateVal;
            if (rType === 'per_kg') {
              baseFreight *= weightStep;
            }

            const activeS = calculateSurcharges(rs.carrier, cargoGroupName, weightStep, [], 'HCM', countryName);
            let surchargesTotal = 0;
            activeS.forEach(s => {
              surchargesTotal += s.amount;
            });

            const fuel = baseFreight * (fcfg.fuel_pct / 100);
            const subtotal = baseFreight + surchargesTotal;
            const vat = (subtotal + fuel) * 0.08; 
            const total = Math.round(subtotal + fuel + vat);
            
            csvData.push([
              rs.carrier,
              'Xuất khẩu',
              countryName,
              cargoGroupName,
              weightStep + ' kg',
              total + ' VND'
            ]);
          }
        });
      });
      
      // Chuyên tuyến
      const srSheet = activeSs.getSheetByName('SPECIAL_ROUTE_RATE');
      if (srSheet) {
        const [headers, ...rows] = srSheet.getDataRange().getValues();
        const srZone = c.special_route || countryName;
        
        let zoneCol = headers.findIndex(h => String(h).trim().toLowerCase() === String(srZone).trim().toLowerCase());
        if (zoneCol !== -1) {
          const cargoCol = headers.findIndex(h => String(h).trim().toLowerCase() === 'cargo_code');
          const typeCol  = headers.findIndex(h => String(h).trim().toLowerCase() === 'price_type');
          const fromCol  = headers.findIndex(h => String(h).trim().toLowerCase() === 'weight_from');
          const toCol    = headers.findIndex(h => String(h).trim().toLowerCase() === 'weight_to');

          if (cargoCol !== -1 && fromCol !== -1 && toCol !== -1) {
            rows.forEach(r => {
              const cargoGroupName = String(r[cargoCol]).trim();
              const rType = typeCol !== -1 ? String(r[typeCol]).trim().toLowerCase() : 'flat';
              const rFrom = parseFloat(String(r[fromCol]).replace(',', '.'));
              const rateVal = Number(r[zoneCol]);
              
              if (cargoGroupName && !isNaN(rFrom) && rateVal > 0) {
                const weightStep = rFrom;
                let baseFreight = rateVal;
                if (rType === 'per_kg') {
                  baseFreight *= weightStep;
                }

                const activeS = calculateSurcharges('Special Route', cargoGroupName, weightStep, [], 'HCM', countryName);
                let surchargesTotal = 0;
                activeS.forEach(s => {
                  surchargesTotal += s.amount;
                });

                const fcfg = cfg.fuel['Special Route'] || { fuel_pct: 0 };
                const fuel = baseFreight * (fcfg.fuel_pct / 100);
                const subtotal = baseFreight + surchargesTotal;
                const total = Math.round(subtotal + fuel); // Mặc định chuyên tuyến VAT 0%
                
                csvData.push([
                  'Special Route',
                  'Xuất khẩu',
                  countryName,
                  cargoGroupName,
                  weightStep + ' kg',
                  total + ' VND'
                ]);
              }
            });
          }
        }
      }
    });
    
    const csvContent = csvData.map(r => r.map(cell => '"' + String(cell).replace(/"/g, '""') + '"').join(',')).join('\n');
    
    let folder;
    try {
      const folders = DriveApp.getFoldersByName("VNGROW Express Attachments");
      if (folders.hasNext()) {
        folder = folders.next();
      } else {
        folder = DriveApp.createFolder("VNGROW Express Attachments");
      }
    } catch (e) {
      folder = DriveApp;
    }
    
    const fileName = "VNGROW_GEMINI_KNOWLEDGE_" + Date.now() + ".csv";
    const file = folder.createFile(fileName, csvContent, MimeType.CSV);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    ui.alert(
      'Xuất file thành công',
      'Đã xuất file tri thức tối ưu thành công!\n\nTên file: ' + fileName + '\nĐường dẫn thư mục: Drive > VNGROW Express Attachments\nLink tải file: ' + file.getUrl() + '\n\nBạn hãy tải file CSV này xuống và tải lên (upload) phần Knowledge Base của Gemini Gem để thay thế file cũ nhé!',
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('Lỗi tạo file', 'Không thể tạo file tri thức: ' + e.message, ui.ButtonSet.OK);
  }
}
