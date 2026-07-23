// ============================================================
// VNGROW Express Webapp — Google Apps Script
// Spreadsheet: https://docs.google.com/spreadsheets/d/1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc
// Deploy: Extensions > Apps Script > Deploy > New deployment > Web App
//   Execute as: Me | Who has access: Anyone
// ============================================================

const SS_ID = '1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc';
const ZALO_WEBHOOK_URL = ''; // Điền URL Webhook của Zalo/Make/Zapier vào đây

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
      case 'tracking':       return ok(getTracking(e.parameter.id));
      case 'getHomepageContent': return ok(getHomepageContent());
      case 'getPage':        return ok(getPage(e.parameter.slug));
      default:               return err('Unknown action: ' + e.parameter.action);
    }
  } catch (ex) { return err(ex.message); }
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    switch (d.action) {
      case 'saveLead':      return ok(saveLead(d));
      case 'submitRFQ':     return ok(submitRFQ(d));
      case 'submitBooking': return ok(submitBooking(d));
      case 'saveNotice':    return ok(saveNotice(d));
      case 'saveSettings':  return ok(saveSettings(d));
      case 'savePage':      return ok(savePage(d));
      case 'uploadImage':   return ok(uploadImage(d));
      default:              return err('Unknown action: ' + d.action);
    }
  } catch (ex) { return err(ex.message); }
}

// ============================================================
// CONFIG  (fuel surcharge + transit_time + VAT)
// ============================================================

function getConfig() {
  const sheet = getSheet('CONFIG');
  const rows  = sheet.getDataRange().getValues();

  const fuel    = {};   // { 'DHL': { fuel_pct, transit_min, transit_max } }
  const vat     = {};   // { 'export': 8, 'import': 0, ... }
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
  return { fuel, vat };
}

// ============================================================
// GET COUNTRIES
// ============================================================

function getCountries() {
  return sheetToObjects('COUNTRY_ZONE_MAPPING');
}

// ============================================================
// GET HOMEPAGE CONTENT (CMS)
// ============================================================

function getHomepageContent() {
  const notices = sheetToObjects('NOTICE_BOARD');
  
  // Lấy danh sách settings nếu có
  let settings = {};
  const settingsSheet = getSheet('SETTINGS');
  if (settingsSheet) {
    const [headers, ...rows] = settingsSheet.getDataRange().getValues();
    rows.forEach(r => {
      if (r[0] && r[1]) {
        settings[String(r[0]).trim()] = String(r[1]).trim();
      }
    });
  }
  
  // Sort notices by date descending (assuming 'date' is a valid date string or object)
  notices.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  return { notices, settings };
}

// ============================================================
// ADMIN CMS POST METHODS
// ============================================================

function saveNotice(d) {
  const sheet = getSheet('NOTICE_BOARD');
  if (!sheet) throw new Error('Sheet NOTICE_BOARD không tồn tại');
  // Expecting d: { date, tag, title, content, link }
  const id = new Date().getTime(); // simple ID
  sheet.appendRow([id, d.date, d.tag, d.title, d.content, d.link || '']);
  return 'Đăng thông báo thành công';
}

function saveSettings(d) {
  const sheet = getSheet('SETTINGS');
  if (!sheet) throw new Error('Sheet SETTINGS không tồn tại');
  
  const data = sheet.getDataRange().getValues();
  const keyRowMap = {};
  for (let i = 1; i < data.length; i++) {
    const k = String(data[i][0]).trim();
    if (k) keyRowMap[k] = i + 1; // +1 for 1-based indexing
  }
  
  d.settings.forEach(s => {
    if (keyRowMap[s.key]) {
      sheet.getRange(keyRowMap[s.key], 2).setValue(s.value);
    } else {
      sheet.appendRow([s.key, s.value]);
      keyRowMap[s.key] = sheet.getLastRow();
    }
  });
  
  return 'Lưu cài đặt thành công';
}

// ============================================================
// GET CARGO GROUPS
// ============================================================

function getCargoGroups() {
  const sheet = getSheet('CONFIG');
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
// RATE LOOKUP HELPERS
// ============================================================

// Normalize zone value: if user entered "5" → "zone_5", "A" → "zone_A", already "zone_5" → "zone_5"
function normalizeZone(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (s === '' || s === '0') return null;
  if (/^zone_/i.test(s)) return s.toLowerCase();
  return 'zone_' + s;
}

// Map cargo_code → cargo_group display name using CONFIG
function cargoCodeToGroup(cargoCode, cargoGroups) {
  const found = cargoGroups.find(g => String(g.cargo_code).trim() === String(cargoCode).trim());
  return found ? String(found.cargo_group).trim() : cargoCode;
}

// Returns the rate value (number) for a given cargo_group display name, CW, and zone column header.
function lookupRate(sheetName, cargoGroupName, cw, zoneHeader) {
  const sheet = getSheet(sheetName);
  if (!sheet) return null;

  const zone = normalizeZone(zoneHeader);
  if (!zone) return null;

  const [headers, ...rows] = sheet.getDataRange().getValues();
  // Try normalized zone (zone_5, zone_A) first, then raw value (country name for Special Route)
  let zoneCol = zone
    ? headers.findIndex(h => String(h).trim().toLowerCase() === zone.toLowerCase())
    : -1;
  if (zoneCol === -1) {
    zoneCol = headers.findIndex(h => String(h).trim().toLowerCase() === String(zoneHeader).trim().toLowerCase());
  }
  if (zoneCol === -1) return null;

  // Match by cargo_group name (case-insensitive, trimmed)
  const brackets = rows
    .filter(r => String(r[0]).trim().toLowerCase() === cargoGroupName.toLowerCase() && !isNaN(parseFloat(r[1])))
    .map(r => ({ weight: parseFloat(r[1]), rate: Number(r[zoneCol]) }))
    .filter(r => r.rate > 0)
    .sort((a, b) => a.weight - b.weight);

  if (brackets.length === 0) return null;

  const match = brackets.find(b => b.weight >= cw) || brackets[brackets.length - 1];
  return match.rate;
}

// ============================================================
// GET RATES  (main endpoint)
// params: country, cargo_code, cw, direction
// ============================================================

function getRates(params) {
  const country    = params.country    || '';
  const cargoCode  = params.cargo_code || 'normal';
  const cw         = parseFloat(params.cw) || 0;
  const direction  = params.direction  || 'export';

  if (!country) return { error: 'Thiếu tên quốc gia' };
  if (cw <= 0)  return { error: 'CW phải > 0' };

  // Zone mapping
  const countries  = sheetToObjects('COUNTRY_ZONE_MAPPING');
  const countryRow = countries.find(r => r.country_name === country);
  if (!countryRow) return { error: 'Không tìm thấy quốc gia: ' + country };

  const cfg        = getConfig();
  const cargoGroups = getCargoGroups();
  const cargoGroupName = cargoCodeToGroup(cargoCode, cargoGroups); // "normal" → "Hàng thường"
  const vatPct = cfg.vat[direction] !== undefined ? cfg.vat[direction] : (direction === 'export' ? 8 : 0);

  // Standard services
  const SERVICES = [
    { name: 'DHL',           sheet: 'DHL_RATE',           zone: countryRow.dhl           },
    { name: 'FedEx IE',      sheet: 'FEDEX_IE_RATE',      zone: countryRow.fedex_ie      },
    { name: 'FedEx IP',      sheet: 'FEDEX_IP_RATE',      zone: countryRow.fedex_ip      },
    { name: 'UPS Saver',     sheet: 'UPS_SAVER_RATE',     zone: countryRow.ups_saver     },
    { name: 'UPS Expedited', sheet: 'UPS_EXPEDITED_RATE', zone: countryRow.ups_expedited },
  ];

  const results = [];

  for (const svc of SERVICES) {
    if (!svc.zone || svc.zone === '') continue;

    const ratePerKg = lookupRate(svc.sheet, cargoGroupName, cw, svc.zone);
    if (ratePerKg === null) continue;

    const fcfg     = cfg.fuel[svc.name] || { fuel_pct: 0, transit_min: 0, transit_max: 0 };
    const freight  = ratePerKg * cw;
    const fuel     = freight * (fcfg.fuel_pct / 100);
    const subtotal = freight + fuel;
    const vat      = subtotal * (vatPct / 100);
    const total    = subtotal + vat;

    results.push({
      service:            svc.name,
      zone:               svc.zone,
      rate_per_kg:        ratePerKg,
      chargeable_weight:  cw,
      freight:            Math.round(freight),
      fuel_surcharge:     Math.round(fuel),
      fuel_pct:           fcfg.fuel_pct,
      vat:                Math.round(vat),
      vat_pct:            vatPct,
      total:              Math.round(total),
      transit_min:        fcfg.transit_min,
      transit_max:        fcfg.transit_max,
    });
  }

  // Special Route (column header = country name)
  const srRate = lookupRate('SPECIAL_ROUTE_RATE', cargoGroupName, cw, country);
  if (srRate !== null) {
    const fcfg    = cfg.fuel['Special Route'] || { fuel_pct: 0, transit_min: 10, transit_max: 12 };
    const freight = srRate * cw;
    const fuel    = freight * (fcfg.fuel_pct / 100);
    const total   = freight + fuel; // Special Route: VAT = 0%
    results.push({
      service:           'Special Route',
      zone:              country,
      rate_per_kg:       srRate,
      chargeable_weight: cw,
      freight:           Math.round(freight),
      fuel_surcharge:    Math.round(fuel),
      fuel_pct:          fcfg.fuel_pct,
      vat:               0,
      vat_pct:           0,
      total:             Math.round(total),
      transit_min:       fcfg.transit_min,
      transit_max:       fcfg.transit_max,
    });
  }

  // Check oversize per piece (warning only — surcharge amount filled in later)
  const oversizeWarnings = checkOversize(params, results.map(r => r.service));

  results.sort((a, b) => a.total - b.total);
  return { rates: results, oversize_warnings: oversizeWarnings };
}

// ============================================================
// OVERSIZE CHECK  (returns warning list, not exact fee)
// params may include piece_l, piece_w, piece_h, piece_gw (cm / kg)
// ============================================================

function checkOversize(params, activeServices) {
  const l  = parseFloat(params.piece_l)  || 0;
  const w  = parseFloat(params.piece_w)  || 0;
  const h  = parseFloat(params.piece_h)  || 0;
  const gw = parseFloat(params.piece_gw) || 0;
  if (l === 0 && w === 0 && h === 0) return [];

  const dims    = [l, w, h].sort((a, b) => b - a);
  const longest = dims[0];
  const girth   = (dims[1] + dims[2]) * 2;
  const lgSum   = longest + girth;

  const rules = sheetToObjects('SURCHARGE_OVERSIZE');
  const warnings = [];

  for (const rule of rules) {
    if (!activeServices.includes(rule.service)) continue;
    const threshold = parseFloat(rule.threshold_value) || 0;
    let triggered = false;

    if (rule.condition === 'cạnh dài nhất'    && longest > threshold) triggered = true;
    if (rule.condition === 'length + girth'   && lgSum   > threshold) triggered = true;
    if (rule.condition === 'trọng lượng/kiện' && gw      > threshold) triggered = true;

    if (triggered) {
      warnings.push({
        service:        rule.service,
        surcharge_type: rule.surcharge_type,
        condition:      rule.condition,
        threshold:      threshold,
        unit:           rule.unit,
      });
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
// SUBMIT RFQ
// ============================================================

function submitRFQ(d) {
  const sheet = getSheet('RFQ');
  const id    = 'RFQ-' + Date.now();
  const now   = new Date();

  sheet.appendRow([
    id, now,
    d.contact_name || '', d.contact_phone || '', d.contact_email || '', d.contact_company || '',
    d.direction || 'export', d.origin_country || 'Việt Nam', d.destination_country || '',
    d.cargo_group || '', d.cargo_description || '',
    d.total_packages || 0, d.total_gw || 0,
    d.special_requirements || '',
    '',           // file_attachments
    '',           // assigned_to
    '',           // price_confirmed
    '',           // internal_notes
    'Chưa tiếp nhận',
  ]);

  // Gửi thông báo
  const msg = `🔔 CÓ YÊU CẦU BÁO GIÁ MỚI\n- ID: ${id}\n- Khách hàng: ${d.contact_name} (${d.contact_phone})\n- Tuyến: ${d.origin_country || 'VN'} -> ${d.destination_country}\n- GW: ${d.total_gw} kg`;
  sendNotification(msg);

  return { id };
}

// ============================================================
// SUBMIT BOOKING
// ============================================================

function submitBooking(d) {
  const sheet = getSheet('BOOKING');
  const id    = 'BK-' + Date.now();
  const now   = new Date();

  sheet.appendRow([
    id, now,
    d.service || '', d.direction || 'export',
    d.origin_country || 'Việt Nam', d.destination_country || '',
    d.creator_name || '', d.creator_phone || '', d.creator_email || '', d.creator_company || '',
    d.sender_name || '', d.sender_phone || '', d.sender_address || '',
    d.receiver_name || '', d.receiver_phone || '', d.receiver_address || '', d.receiver_country || '',
    d.total_packages || 0, d.total_gw || 0, d.total_cw || 0,
    JSON.stringify(d.package_details || []),
    '',           // assigned_to
    '',           // price_confirmed
    '',           // internal_notes
    'Chưa tiếp nhận',
    '',           // id_shipment
  ]);

  // Gửi thông báo
  const msg = `📦 CÓ ĐƠN BOOKING MỚI\n- ID: ${id}\n- Khách hàng: ${d.creator_name} (${d.creator_phone})\n- Hãng: ${d.service}\n- Đi đích: ${d.receiver_country}\n- GW: ${d.total_gw} kg`;
  sendNotification(msg);

  return { id };
}

// ============================================================
// ETA CALCULATOR  (call from SHIPMENT sheet trigger)
// Adds business days (Mon–Fri) to a start date.
// ============================================================

function addBusinessDays(startDate, days) {
  const d = new Date(startDate);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

// Triggered when SHIPMENT_TIMELINE is updated.
// If new status = "Đã nhận được hàng", calculate & write eta_date to SHIPMENT.
function onTimelineEdit(e) {
  const sheet = e.source.getActiveSheet();
  if (sheet.getName() !== 'SHIPMENT_TIMELINE') return;

  const row     = e.range.getRow();
  if (row < 2) return;

  const values  = sheet.getRange(row, 1, 1, 7).getValues()[0];
  const status  = String(values[2]).trim();   // column C: status
  if (status !== 'Đã nhận được hàng') return;

  const shipmentId = String(values[1]).trim(); // column B: id_shipment
  const timestamp  = values[5];                // column F: timestamp

  // Find the service for this shipment
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
// NOTIFICATION UTILS
// ============================================================

function sendNotification(message) {
  if (!ZALO_WEBHOOK_URL) return;
  
  try {
    const payload = {
      message: message
    };
    
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    
    UrlFetchApp.fetch(ZALO_WEBHOOK_URL, options);
  } catch (e) {
    console.error("Lỗi gửi thông báo: " + e.message);
  }
}

function getPage(slug) {
  if (!slug) throw new Error("Thiếu đường dẫn (slug)");
  const pages = sheetToObjects('PAGES');
  const page = pages.find(p => String(p.slug).trim() === String(slug).trim());
  if (!page) throw new Error("Không tìm thấy trang");
  return page;
}

function savePage(d) {
  const sheet = getSheet('PAGES');
  if (!sheet) throw new Error('Sheet PAGES không tồn tại');
  // Expecting d: { slug, title, content }
  if (!d.slug || !d.title || !d.content) throw new Error("Vui lòng điền đủ Tiêu đề, Link và Nội dung");
  
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    // Cột B (index 1) là slug
    if (String(data[i][1]).trim() === d.slug.trim()) {
      rowIndex = i + 1;
      break;
    }
  }
  
  const dateStr = new Date().toISOString();
  // Structure: id, slug, title, content, updated_at
  
  if (rowIndex > -1) {
    sheet.getRange(rowIndex, 2, 1, 4).setValues([[d.slug.trim(), d.title, d.content, dateStr]]);
  } else {
    const id = new Date().getTime();
    sheet.appendRow([id, d.slug.trim(), d.title, d.content, dateStr]);
  }
  return 'Lưu bài viết thành công';
}

// ============================================================
// IMAGE UPLOAD
// ============================================================

function uploadImage(d) {
  if (!d.base64) throw new Error("Không có dữ liệu ảnh");
  
  let folders = DriveApp.getFoldersByName("VNGROW_IMAGES");
  let folder;
  if (folders.hasNext()) {
    folder = folders.next();
  } else {
    folder = DriveApp.createFolder("VNGROW_IMAGES");
    // Cài đặt quyền chia sẻ cho thư mục
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }
  
  let base64Data = d.base64;
  if (base64Data.indexOf("base64,") !== -1) {
    base64Data = base64Data.split("base64,")[1];
  }
  
  let mime = d.mimeType || 'image/png';
  let name = d.name || ('img_' + new Date().getTime() + '.png');
  
  let blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mime, name);
  let file = folder.createFile(blob);
  
  // Đảm bảo file có quyền xem công khai
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  
  let url = "https://drive.google.com/uc?export=view&id=" + file.getId();
  return { location: url }; // TinyMCE expects { location: '...' } by default in some setups, but we handle it manually. Returning object.
}


// ============================================================
// VNGROW Express Webapp ΓÇö Google Apps Script
// Spreadsheet: https://docs.google.com/spreadsheets/d/1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc
// Deploy: Extensions > Apps Script > Deploy > New deployment > Web App
//   Execute as: Me | Who has access: Anyone
// ============================================================

const SS_ID = '1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc';
// Spreadsheet CRM (chß╗⌐a c├íc tab LEAD, DEAL, RFQ, BOOKING, SHIPMENT...) ΓÇö KH├üC spreadsheet pricing ß╗ƒ tr├¬n.
const CRM_SS_ID = '1nBUJhnwWpFGgFhgrbrSfbG-Znife_5JXSSyLLSsmHVA';

// ---- Helpers ------------------------------------------------

function getSheet(name) {
  return SpreadsheetApp.openById(SS_ID).getSheetByName(name);
}

function getCrmSheet(name) {
  return SpreadsheetApp.openById(CRM_SS_ID).getSheetByName(name);
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
          // Normalize: "FEDEX IE" ΓåÆ "fedex_ie", "UPS Saver" ΓåÆ "ups_saver"
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
      case 'tracking':       return ok(getTracking(e.parameter.id));
      default:               return err('Unknown action: ' + e.parameter.action);
    }
  } catch (ex) { return err(ex.message); }
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    switch (d.action) {
      case 'saveLead':      return ok(saveLead(d));
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
  const rows  = sheet.getDataRange().getValues();

  const fuel    = {};   // { 'DHL': { fuel_pct, transit_min, transit_max } }
  const vat     = {};   // { 'export': 8, 'import': 0, ... }
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
// RATE LOOKUP HELPERS
// ============================================================

// Normalize zone value: if user entered "5" ΓåÆ "zone_5", "A" ΓåÆ "zone_A", already "zone_5" ΓåÆ "zone_5"
function normalizeZone(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (s === '' || s === '0') return null;
  if (/^zone_/i.test(s)) return s.toLowerCase();
  return 'zone_' + s;
}

// Map cargo_code ΓåÆ cargo_group display name using CONFIG
function cargoCodeToGroup(cargoCode, cargoGroups) {
  const found = cargoGroups.find(g => String(g.cargo_code).trim() === String(cargoCode).trim());
  return found ? String(found.cargo_group).trim() : cargoCode;
}

// Returns the rate value (number) for a given cargo_group display name, CW, and zone column header.
function lookupRate(sheetName, cargoGroupName, cw, zoneHeader) {
  const sheet = getSheet(sheetName);
  if (!sheet) return null;

  const zone = normalizeZone(zoneHeader);
  if (!zone) return null;

  const [headers, ...rows] = sheet.getDataRange().getValues();
  // Try normalized zone (zone_5, zone_A) first, then raw value (country name for Special Route)
  let zoneCol = zone
    ? headers.findIndex(h => String(h).trim().toLowerCase() === zone.toLowerCase())
    : -1;
  if (zoneCol === -1) {
    zoneCol = headers.findIndex(h => String(h).trim().toLowerCase() === String(zoneHeader).trim().toLowerCase());
  }
  if (zoneCol === -1) return null;

  // Match by cargo_group name (case-insensitive, trimmed)
  const brackets = rows
    .filter(r => String(r[0]).trim().toLowerCase() === cargoGroupName.toLowerCase() && !isNaN(parseFloat(r[1])))
    .map(r => ({ weight: parseFloat(r[1]), rate: Number(r[zoneCol]) }))
    .filter(r => r.rate > 0)
    .sort((a, b) => a.weight - b.weight);

  if (brackets.length === 0) return null;

  const match = brackets.find(b => b.weight >= cw) || brackets[brackets.length - 1];
  return match.rate;
}

// ============================================================
// GET RATES  (main endpoint)
// params: country, cargo_code, cw, direction
// ============================================================

function getRates(params) {
  const country    = params.country    || '';
  const cargoCode  = params.cargo_code || 'normal';
  const cw         = parseFloat(params.cw) || 0;
  const direction  = params.direction  || 'export';

  if (!country) return { error: 'Thiß║┐u t├¬n quß╗æc gia' };
  if (cw <= 0)  return { error: 'CW phß║úi > 0' };

  // Zone mapping
  const countries  = sheetToObjects('COUNTRY_ZONE_MAPPING');
  const countryRow = countries.find(r => r.country_name === country);
  if (!countryRow) return { error: 'Kh├┤ng t├¼m thß║Ñy quß╗æc gia: ' + country };

  const cfg        = getConfig();
  const cargoGroups = getCargoGroups();
  const cargoGroupName = cargoCodeToGroup(cargoCode, cargoGroups); // "normal" ΓåÆ "H├áng th╞░ß╗¥ng"
  const vatPct = cfg.vat[direction] !== undefined ? cfg.vat[direction] : (direction === 'export' ? 8 : 0);

  // Standard services
  const SERVICES = [
    { name: 'DHL',           sheet: 'DHL_RATE',           zone: countryRow.dhl           },
    { name: 'FedEx IE',      sheet: 'FEDEX_IE_RATE',      zone: countryRow.fedex_ie      },
    { name: 'FedEx IP',      sheet: 'FEDEX_IP_RATE',      zone: countryRow.fedex_ip      },
    { name: 'UPS Saver',     sheet: 'UPS_SAVER_RATE',     zone: countryRow.ups_saver     },
    { name: 'UPS Expedited', sheet: 'UPS_EXPEDITED_RATE', zone: countryRow.ups_expedited },
  ];

  const results = [];

  for (const svc of SERVICES) {
    if (!svc.zone || svc.zone === '') continue;

    const ratePerKg = lookupRate(svc.sheet, cargoGroupName, cw, svc.zone);
    if (ratePerKg === null) continue;

    const fcfg     = cfg.fuel[svc.name] || { fuel_pct: 0, transit_min: 0, transit_max: 0 };
    const freight  = ratePerKg * cw;
    const fuel     = freight * (fcfg.fuel_pct / 100);
    const subtotal = freight + fuel;
    const vat      = subtotal * (vatPct / 100);
    const total    = subtotal + vat;

    results.push({
      service:            svc.name,
      zone:               svc.zone,
      rate_per_kg:        ratePerKg,
      chargeable_weight:  cw,
      freight:            Math.round(freight),
      fuel_surcharge:     Math.round(fuel),
      fuel_pct:           fcfg.fuel_pct,
      vat:                Math.round(vat),
      vat_pct:            vatPct,
      total:              Math.round(total),
      transit_min:        fcfg.transit_min,
      transit_max:        fcfg.transit_max,
    });
  }

  // Special Route (column header = country name)
  const srRate = lookupRate('SPECIAL_ROUTE_RATE', cargoGroupName, cw, country);
  if (srRate !== null) {
    const fcfg    = cfg.fuel['Special Route'] || { fuel_pct: 0, transit_min: 10, transit_max: 12 };
    const freight = srRate * cw;
    const fuel    = freight * (fcfg.fuel_pct / 100);
    const total   = freight + fuel; // Special Route: VAT = 0%
    results.push({
      service:           'Special Route',
      zone:              country,
      rate_per_kg:       srRate,
      chargeable_weight: cw,
      freight:           Math.round(freight),
      fuel_surcharge:    Math.round(fuel),
      fuel_pct:          fcfg.fuel_pct,
      vat:               0,
      vat_pct:           0,
      total:             Math.round(total),
      transit_min:       fcfg.transit_min,
      transit_max:       fcfg.transit_max,
    });
  }

  // Check oversize per piece (warning only ΓÇö surcharge amount filled in later)
  const oversizeWarnings = checkOversize(params, results.map(r => r.service));

  results.sort((a, b) => a.total - b.total);
  return { rates: results, oversize_warnings: oversizeWarnings };
}

// ============================================================
// OVERSIZE CHECK  (returns warning list, not exact fee)
// params may include piece_l, piece_w, piece_h, piece_gw (cm / kg)
// ============================================================

function checkOversize(params, activeServices) {
  const l  = parseFloat(params.piece_l)  || 0;
  const w  = parseFloat(params.piece_w)  || 0;
  const h  = parseFloat(params.piece_h)  || 0;
  const gw = parseFloat(params.piece_gw) || 0;
  if (l === 0 && w === 0 && h === 0) return [];

  const dims    = [l, w, h].sort((a, b) => b - a);
  const longest = dims[0];
  const girth   = (dims[1] + dims[2]) * 2;
  const lgSum   = longest + girth;

  const rules = sheetToObjects('SURCHARGE_OVERSIZE');
  const warnings = [];

  for (const rule of rules) {
    if (!activeServices.includes(rule.service)) continue;
    const threshold = parseFloat(rule.threshold_value) || 0;
    let triggered = false;

    if (rule.condition === 'cß║ính d├ái nhß║Ñt'    && longest > threshold) triggered = true;
    if (rule.condition === 'length + girth'   && lgSum   > threshold) triggered = true;
    if (rule.condition === 'trß╗ìng l╞░ß╗úng/kiß╗çn' && gw      > threshold) triggered = true;

    if (triggered) {
      warnings.push({
        service:        rule.service,
        surcharge_type: rule.surcharge_type,
        condition:      rule.condition,
        threshold:      threshold,
        unit:           rule.unit,
      });
    }
  }
  return warnings;
}

// ============================================================
// TRACKING
// ============================================================

function getTracking(id) {
  if (!id) return { error: 'Thiß║┐u m├ú vß║¡n ─æ╞ín' };

  const shipments = sheetToObjects('SHIPMENT');
  const shipment  = shipments.find(s =>
    String(s.id_shipment) === String(id) || String(s.booking_id) === String(id)
  );
  if (!shipment) return { error: 'Kh├┤ng t├¼m thß║Ñy l├┤ h├áng: ' + id };

  const timeline = sheetToObjects('SHIPMENT_TIMELINE')
    .filter(t => String(t.id_shipment) === String(shipment.id_shipment))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return { shipment, timeline };
}

// ============================================================
// SAVE LEAD  (tß╗½ chatbot AI ΓåÆ tab LEAD cß╗ºa spreadsheet CRM)
// Thß╗⌐ tß╗▒ cß╗Öt phß║úi KHß╗ÜP CH├ìNH X├üC header tab LEAD:
// id_deal | assigned_to | lead_status | id_lead | lead_name | tel | email |
// cargo_description | destination_country | total_packages | total_gw | total_vw |
// total_cw | origin_city | cargo_value | currency | source | channel |
// created_at | note | price_quote | chat_id
// ============================================================

function saveLead(d) {
  const sheet = getCrmSheet('LEAD');
  if (!sheet) return { error: 'Kh├┤ng t├¼m thß║Ñy tab LEAD trong spreadsheet CRM' };

  const id  = 'LEAD-' + Date.now();
  const now = new Date();

  sheet.appendRow([
    '',                              // id_deal        (nß╗Öi bß╗Ö CRM, ─æß╗â trß╗æng)
    '',                              // assigned_to    (nß╗Öi bß╗Ö, ─æß╗â trß╗æng)
    d.lead_status || 'collecting',   // lead_status
    id,                              // id_lead
    d.lead_name || '',               // lead_name
    d.tel || '',                     // tel
    d.email || '',                   // email
    d.cargo_description || '',       // cargo_description
    d.destination_country || '',     // destination_country
    d.total_packages || '',          // total_packages
    d.total_gw || '',                // total_gw
    d.total_vw || '',                // total_vw
    d.total_cw || '',                // total_cw
    d.origin_city || '',             // origin_city
    d.cargo_value || '',             // cargo_value
    d.currency || 'VND',             // currency
    d.source || 'chatbot',           // source
    d.channel || 'web-ai',           // channel
    now,                             // created_at
    d.note || '',                    // note
    d.price_quote || '',             // price_quote
    d.chat_id || '',                 // chat_id
  ]);

  notifyNewLead_({ id, ...d });
  return { id };
}

// ============================================================
// VNGROW Express Webapp ΓÇö Google Apps Script
// Spreadsheet: https://docs.google.com/spreadsheets/d/1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc
// Deploy: Extensions > Apps Script > Deploy > New deployment > Web App
//   Execute as: Me | Who has access: Anyone
// ============================================================

const SS_ID = '1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc';
// Spreadsheet CRM (chß╗⌐a c├íc tab LEAD, DEAL, RFQ, BOOKING, SHIPMENT...) ΓÇö KH├üC spreadsheet pricing ß╗ƒ tr├¬n.
const CRM_SS_ID = '1nBUJhnwWpFGgFhgrbrSfbG-Znife_5JXSSyLLSsmHVA';

// ---- Helpers ------------------------------------------------

function getSheet(name) {
  return SpreadsheetApp.openById(SS_ID).getSheetByName(name);
}

function getCrmSheet(name) {
  return SpreadsheetApp.openById(CRM_SS_ID).getSheetByName(name);
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
          // Normalize: "FEDEX IE" ΓåÆ "fedex_ie", "UPS Saver" ΓåÆ "ups_saver"
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
      case 'tracking':       return ok(getTracking(e.parameter.id));
      default:               return err('Unknown action: ' + e.parameter.action);
    }
  } catch (ex) { return err(ex.message); }
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    switch (d.action) {
      case 'saveLead':      return ok(saveLead(d));
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
  const rows  = sheet.getDataRange().getValues();

  const fuel    = {};   // { 'DHL': { fuel_pct, transit_min, transit_max } }
  const vat     = {};   // { 'export': 8, 'import': 0, ... }
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
// RATE LOOKUP HELPERS
// ============================================================

// Normalize zone value: if user entered "5" ΓåÆ "zone_5", "A" ΓåÆ "zone_A", already "zone_5" ΓåÆ "zone_5"
function normalizeZone(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (s === '' || s === '0') return null;
  if (/^zone_/i.test(s)) return s.toLowerCase();
  return 'zone_' + s;
}

// Map cargo_code ΓåÆ cargo_group display name using CONFIG
function cargoCodeToGroup(cargoCode, cargoGroups) {
  const found = cargoGroups.find(g => String(g.cargo_code).trim() === String(cargoCode).trim());
  return found ? String(found.cargo_group).trim() : cargoCode;
}

// Returns the rate value (number) for a given cargo_group display name, CW, and zone column header.
function lookupRate(sheetName, cargoGroupName, cw, zoneHeader) {
  const sheet = getSheet(sheetName);
  if (!sheet) return null;

  const zone = normalizeZone(zoneHeader);
  if (!zone) return null;

  const [headers, ...rows] = sheet.getDataRange().getValues();
  // Try normalized zone (zone_5, zone_A) first, then raw value (country name for Special Route)
  let zoneCol = zone
    ? headers.findIndex(h => String(h).trim().toLowerCase() === zone.toLowerCase())
    : -1;
  if (zoneCol === -1) {
    zoneCol = headers.findIndex(h => String(h).trim().toLowerCase() === String(zoneHeader).trim().toLowerCase());
  }
  if (zoneCol === -1) return null;

  // Match by cargo_group name (case-insensitive, trimmed)
  const brackets = rows
    .filter(r => String(r[0]).trim().toLowerCase() === cargoGroupName.toLowerCase() && !isNaN(parseFloat(r[1])))
    .map(r => ({ weight: parseFloat(r[1]), rate: Number(r[zoneCol]) }))
    .filter(r => r.rate > 0)
    .sort((a, b) => a.weight - b.weight);

  if (brackets.length === 0) return null;

  const match = brackets.find(b => b.weight >= cw) || brackets[brackets.length - 1];
  return match.rate;
}

// ============================================================
// GET RATES  (main endpoint)
// params: country, cargo_code, cw, direction
// ============================================================

function getRates(params) {
  const country    = params.country    || '';
  const cargoCode  = params.cargo_code || 'normal';
  const cw         = parseFloat(params.cw) || 0;
  const direction  = params.direction  || 'export';

  if (!country) return { error: 'Thiß║┐u t├¬n quß╗æc gia' };
  if (cw <= 0)  return { error: 'CW phß║úi > 0' };

  // Zone mapping
  const countries  = sheetToObjects('COUNTRY_ZONE_MAPPING');
  const countryRow = countries.find(r => r.country_name === country);
  if (!countryRow) return { error: 'Kh├┤ng t├¼m thß║Ñy quß╗æc gia: ' + country };

  const cfg        = getConfig();
  const cargoGroups = getCargoGroups();
  const cargoGroupName = cargoCodeToGroup(cargoCode, cargoGroups); // "normal" ΓåÆ "H├áng th╞░ß╗¥ng"
  const vatPct = cfg.vat[direction] !== undefined ? cfg.vat[direction] : (direction === 'export' ? 8 : 0);

  // Standard services
  const SERVICES = [
    { name: 'DHL',           sheet: 'DHL_RATE',           zone: countryRow.dhl           },
    { name: 'FedEx IE',      sheet: 'FEDEX_IE_RATE',      zone: countryRow.fedex_ie      },
    { name: 'FedEx IP',      sheet: 'FEDEX_IP_RATE',      zone: countryRow.fedex_ip      },
    { name: 'UPS Saver',     sheet: 'UPS_SAVER_RATE',     zone: countryRow.ups_saver     },
    { name: 'UPS Expedited', sheet: 'UPS_EXPEDITED_RATE', zone: countryRow.ups_expedited },
  ];

  const results = [];

  for (const svc of SERVICES) {
    if (!svc.zone || svc.zone === '') continue;

    const ratePerKg = lookupRate(svc.sheet, cargoGroupName, cw, svc.zone);
    if (ratePerKg === null) continue;

    const fcfg     = cfg.fuel[svc.name] || { fuel_pct: 0, transit_min: 0, transit_max: 0 };
    const freight  = ratePerKg * cw;
    const fuel     = freight * (fcfg.fuel_pct / 100);
    const subtotal = freight + fuel;
    const vat      = subtotal * (vatPct / 100);
    const total    = subtotal + vat;

    results.push({
      service:            svc.name,
      zone:               svc.zone,
      rate_per_kg:        ratePerKg,
      chargeable_weight:  cw,
      freight:            Math.round(freight),
      fuel_surcharge:     Math.round(fuel),
      fuel_pct:           fcfg.fuel_pct,
      vat:                Math.round(vat),
      vat_pct:            vatPct,
      total:              Math.round(total),
      transit_min:        fcfg.transit_min,
      transit_max:        fcfg.transit_max,
    });
  }

  // Special Route (column header = country name)
  const srRate = lookupRate('SPECIAL_ROUTE_RATE', cargoGroupName, cw, country);
  if (srRate !== null) {
    const fcfg    = cfg.fuel['Special Route'] || { fuel_pct: 0, transit_min: 10, transit_max: 12 };
    const freight = srRate * cw;
    const fuel    = freight * (fcfg.fuel_pct / 100);
    const total   = freight + fuel; // Special Route: VAT = 0%
    results.push({
      service:           'Special Route',
      zone:              country,
      rate_per_kg:       srRate,
      chargeable_weight: cw,
      freight:           Math.round(freight),
      fuel_surcharge:    Math.round(fuel),
      fuel_pct:          fcfg.fuel_pct,
      vat:               0,
      vat_pct:           0,
      total:             Math.round(total),
      transit_min:       fcfg.transit_min,
      transit_max:       fcfg.transit_max,
    });
  }

  // Check oversize per piece (warning only ΓÇö surcharge amount filled in later)
  const oversizeWarnings = checkOversize(params, results.map(r => r.service));

  results.sort((a, b) => a.total - b.total);
  return { rates: results, oversize_warnings: oversizeWarnings };
}

// ============================================================
// OVERSIZE CHECK  (returns warning list, not exact fee)
// params may include piece_l, piece_w, piece_h, piece_gw (cm / kg)
// ============================================================

function checkOversize(params, activeServices) {
  const l  = parseFloat(params.piece_l)  || 0;
  const w  = parseFloat(params.piece_w)  || 0;
  const h  = parseFloat(params.piece_h)  || 0;
  const gw = parseFloat(params.piece_gw) || 0;
  if (l === 0 && w === 0 && h === 0) return [];

  const dims    = [l, w, h].sort((a, b) => b - a);
  const longest = dims[0];
  const girth   = (dims[1] + dims[2]) * 2;
  const lgSum   = longest + girth;

  const rules = sheetToObjects('SURCHARGE_OVERSIZE');
  const warnings = [];

  for (const rule of rules) {
    if (!activeServices.includes(rule.service)) continue;
    const threshold = parseFloat(rule.threshold_value) || 0;
    let triggered = false;

    if (rule.condition === 'cß║ính d├ái nhß║Ñt'    && longest > threshold) triggered = true;
    if (rule.condition === 'length + girth'   && lgSum   > threshold) triggered = true;
    if (rule.condition === 'trß╗ìng l╞░ß╗úng/kiß╗çn' && gw      > threshold) triggered = true;

    if (triggered) {
      warnings.push({
        service:        rule.service,
        surcharge_type: rule.surcharge_type,
        condition:      rule.condition,
        threshold:      threshold,
        unit:           rule.unit,
      });
    }
  }
  return warnings;
}

// ============================================================
// TRACKING
// ============================================================

function getTracking(id) {
  if (!id) return { error: 'Thiß║┐u m├ú vß║¡n ─æ╞ín' };

  const shipments = sheetToObjects('SHIPMENT');
  const shipment  = shipments.find(s =>
    String(s.id_shipment) === String(id) || String(s.booking_id) === String(id)
  );
  if (!shipment) return { error: 'Kh├┤ng t├¼m thß║Ñy l├┤ h├áng: ' + id };

  const timeline = sheetToObjects('SHIPMENT_TIMELINE')
    .filter(t => String(t.id_shipment) === String(shipment.id_shipment))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return { shipment, timeline };
}

// ============================================================
// SAVE LEAD  (tß╗½ chatbot AI ΓåÆ tab LEAD cß╗ºa spreadsheet CRM)
// Thß╗⌐ tß╗▒ cß╗Öt phß║úi KHß╗ÜP CH├ìNH X├üC header tab LEAD:
// id_deal | assigned_to | lead_status | id_lead | lead_name | tel | email |
// cargo_description | destination_country | total_packages | total_gw | total_vw |
// total_cw | origin_city | cargo_value | currency | source | channel |
// created_at | note | price_quote | chat_id
// ============================================================

function saveLead(d) {
  const sheet = getCrmSheet('LEAD');
  if (!sheet) return { error: 'Kh├┤ng t├¼m thß║Ñy tab LEAD trong spreadsheet CRM' };

  const id  = 'LEAD-' + Date.now();
  const now = new Date();

  sheet.appendRow([
    '',                              // id_deal        (nß╗Öi bß╗Ö CRM, ─æß╗â trß╗æng)
    '',                              // assigned_to    (nß╗Öi bß╗Ö, ─æß╗â trß╗æng)
    d.lead_status || 'collecting',   // lead_status
    id,                              // id_lead
    d.lead_name || '',               // lead_name
    d.tel || '',                     // tel
    d.email || '',                   // email
    d.cargo_description || '',       // cargo_description
    d.destination_country || '',     // destination_country
    d.total_packages || '',          // total_packages
    d.total_gw || '',                // total_gw
    d.total_vw || '',                // total_vw
    d.total_cw || '',                // total_cw
    d.origin_city || '',             // origin_city
    d.cargo_value || '',             // cargo_value
    d.currency || 'VND',             // currency
    d.source || 'chatbot',           // source
    d.channel || 'web-ai',           // channel
    now,                             // created_at
    d.note || '',                    // note
    d.price_quote || '',             // price_quote
    d.chat_id || '',                 // chat_id
  ]);

  notifyNewLead_({ id, ...d });
  return { id };
}

// ============================================================
// TELEGRAM NOTIFICATIONS
// Setup 1 lß║ºn: Project Settings > Script Properties, th├¬m 2 key:
//   TELEGRAM_BOT_TOKEN  = token lß║Ñy tß╗½ @BotFather
//   TELEGRAM_CHAT_ID    = id chat/group nhß║¡n th├┤ng b├ío
// C├ích lß║Ñy: xem docs/vngrow-automation-setup.md trong repo webapp.
// ============================================================

function sendTelegram_(text) {
  const props = PropertiesService.getScriptProperties();
  const token  = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return; // ch╞░a cß║Ñu h├¼nh -> bß╗Å qua ├¬m, kh├┤ng lß╗ùi

  try {
    UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      muteHttpExceptions: true,
    });
  } catch (e) { /* kh├┤ng ─æß╗â lß╗ùi Telegram l├ám hß╗Ång luß╗ông l╞░u lead */ }
}

// ============================================================
// VNGROW Express Webapp ΓÇö Google Apps Script
// Spreadsheet: https://docs.google.com/spreadsheets/d/1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc
// Deploy: Extensions > Apps Script > Deploy > New deployment > Web App
//   Execute as: Me | Who has access: Anyone
// ============================================================

const SS_ID = '1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc';
// Spreadsheet CRM (chß╗⌐a c├íc tab LEAD, DEAL, RFQ, BOOKING, SHIPMENT...) ΓÇö KH├üC spreadsheet pricing ß╗ƒ tr├¬n.
const CRM_SS_ID = '1nBUJhnwWpFGgFhgrbrSfbG-Znife_5JXSSyLLSsmHVA';

// ---- Helpers ------------------------------------------------

function getSheet(name) {
  return SpreadsheetApp.openById(SS_ID).getSheetByName(name);
}

function getCrmSheet(name) {
  return SpreadsheetApp.openById(CRM_SS_ID).getSheetByName(name);
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
          // Normalize: "FEDEX IE" ΓåÆ "fedex_ie", "UPS Saver" ΓåÆ "ups_saver"
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
      case 'tracking':       return ok(getTracking(e.parameter.id));
      default:               return err('Unknown action: ' + e.parameter.action);
    }
  } catch (ex) { return err(ex.message); }
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    switch (d.action) {
      case 'saveLead':      return ok(saveLead(d));
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
  const rows  = sheet.getDataRange().getValues();

  const fuel    = {};   // { 'DHL': { fuel_pct, transit_min, transit_max } }
  const vat     = {};   // { 'export': 8, 'import': 0, ... }
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
// RATE LOOKUP HELPERS
// ============================================================

// Normalize zone value: if user entered "5" ΓåÆ "zone_5", "A" ΓåÆ "zone_A", already "zone_5" ΓåÆ "zone_5"
function normalizeZone(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (s === '' || s === '0') return null;
  if (/^zone_/i.test(s)) return s.toLowerCase();
  return 'zone_' + s;
}

// Map cargo_code ΓåÆ cargo_group display name using CONFIG
function cargoCodeToGroup(cargoCode, cargoGroups) {
  const found = cargoGroups.find(g => String(g.cargo_code).trim() === String(cargoCode).trim());
  return found ? String(found.cargo_group).trim() : cargoCode;
}

// Returns the rate value (number) for a given cargo_group display name, CW, and zone column header.
function lookupRate(sheetName, cargoGroupName, cw, zoneHeader) {
  const sheet = getSheet(sheetName);
  if (!sheet) return null;

  const zone = normalizeZone(zoneHeader);
  if (!zone) return null;

  const [headers, ...rows] = sheet.getDataRange().getValues();
  // Try normalized zone (zone_5, zone_A) first, then raw value (country name for Special Route)
  let zoneCol = zone
    ? headers.findIndex(h => String(h).trim().toLowerCase() === zone.toLowerCase())
    : -1;
  if (zoneCol === -1) {
    zoneCol = headers.findIndex(h => String(h).trim().toLowerCase() === String(zoneHeader).trim().toLowerCase());
  }
  if (zoneCol === -1) return null;

  // Match by cargo_group name (case-insensitive, trimmed)
  const brackets = rows
    .filter(r => String(r[0]).trim().toLowerCase() === cargoGroupName.toLowerCase() && !isNaN(parseFloat(r[1])))
    .map(r => ({ weight: parseFloat(r[1]), rate: Number(r[zoneCol]) }))
    .filter(r => r.rate > 0)
    .sort((a, b) => a.weight - b.weight);

  if (brackets.length === 0) return null;

  const match = brackets.find(b => b.weight >= cw) || brackets[brackets.length - 1];
  return match.rate;
}

// ============================================================
// GET RATES  (main endpoint)
// params: country, cargo_code, cw, direction
// ============================================================

function getRates(params) {
  const country    = params.country    || '';
  const cargoCode  = params.cargo_code || 'normal';
  const cw         = parseFloat(params.cw) || 0;
  const direction  = params.direction  || 'export';

  if (!country) return { error: 'Thiß║┐u t├¬n quß╗æc gia' };
  if (cw <= 0)  return { error: 'CW phß║úi > 0' };

  // Zone mapping
  const countries  = sheetToObjects('COUNTRY_ZONE_MAPPING');
  const countryRow = countries.find(r => r.country_name === country);
  if (!countryRow) return { error: 'Kh├┤ng t├¼m thß║Ñy quß╗æc gia: ' + country };

  const cfg        = getConfig();
  const cargoGroups = getCargoGroups();
  const cargoGroupName = cargoCodeToGroup(cargoCode, cargoGroups); // "normal" ΓåÆ "H├áng th╞░ß╗¥ng"
  const vatPct = cfg.vat[direction] !== undefined ? cfg.vat[direction] : (direction === 'export' ? 8 : 0);

  // Standard services
  const SERVICES = [
    { name: 'DHL',           sheet: 'DHL_RATE',           zone: countryRow.dhl           },
    { name: 'FedEx IE',      sheet: 'FEDEX_IE_RATE',      zone: countryRow.fedex_ie      },
    { name: 'FedEx IP',      sheet: 'FEDEX_IP_RATE',      zone: countryRow.fedex_ip      },
    { name: 'UPS Saver',     sheet: 'UPS_SAVER_RATE',     zone: countryRow.ups_saver     },
    { name: 'UPS Expedited', sheet: 'UPS_EXPEDITED_RATE', zone: countryRow.ups_expedited },
  ];

  const results = [];

  for (const svc of SERVICES) {
    if (!svc.zone || svc.zone === '') continue;

    const ratePerKg = lookupRate(svc.sheet, cargoGroupName, cw, svc.zone);
    if (ratePerKg === null) continue;

    const fcfg     = cfg.fuel[svc.name] || { fuel_pct: 0, transit_min: 0, transit_max: 0 };
    const freight  = ratePerKg * cw;
    const fuel     = freight * (fcfg.fuel_pct / 100);
    const subtotal = freight + fuel;
    const vat      = subtotal * (vatPct / 100);
    const total    = subtotal + vat;

    results.push({
      service:            svc.name,
      zone:               svc.zone,
      rate_per_kg:        ratePerKg,
      chargeable_weight:  cw,
      freight:            Math.round(freight),
      fuel_surcharge:     Math.round(fuel),
      fuel_pct:           fcfg.fuel_pct,
      vat:                Math.round(vat),
      vat_pct:            vatPct,
      total:              Math.round(total),
      transit_min:        fcfg.transit_min,
      transit_max:        fcfg.transit_max,
    });
  }

  // Special Route (column header = country name)
  const srRate = lookupRate('SPECIAL_ROUTE_RATE', cargoGroupName, cw, country);
  if (srRate !== null) {
    const fcfg    = cfg.fuel['Special Route'] || { fuel_pct: 0, transit_min: 10, transit_max: 12 };
    const freight = srRate * cw;
    const fuel    = freight * (fcfg.fuel_pct / 100);
    const total   = freight + fuel; // Special Route: VAT = 0%
    results.push({
      service:           'Special Route',
      zone:              country,
      rate_per_kg:       srRate,
      chargeable_weight: cw,
      freight:           Math.round(freight),
      fuel_surcharge:    Math.round(fuel),
      fuel_pct:          fcfg.fuel_pct,
      vat:               0,
      vat_pct:           0,
      total:             Math.round(total),
      transit_min:       fcfg.transit_min,
      transit_max:       fcfg.transit_max,
    });
  }

  // Check oversize per piece (warning only ΓÇö surcharge amount filled in later)
  const oversizeWarnings = checkOversize(params, results.map(r => r.service));

  results.sort((a, b) => a.total - b.total);
  return { rates: results, oversize_warnings: oversizeWarnings };
}

// ============================================================
// OVERSIZE CHECK  (returns warning list, not exact fee)
// params may include piece_l, piece_w, piece_h, piece_gw (cm / kg)
// ============================================================

function checkOversize(params, activeServices) {
  const l  = parseFloat(params.piece_l)  || 0;
  const w  = parseFloat(params.piece_w)  || 0;
  const h  = parseFloat(params.piece_h)  || 0;
  const gw = parseFloat(params.piece_gw) || 0;
  if (l === 0 && w === 0 && h === 0) return [];

  const dims    = [l, w, h].sort((a, b) => b - a);
  const longest = dims[0];
  const girth   = (dims[1] + dims[2]) * 2;
  const lgSum   = longest + girth;

  const rules = sheetToObjects('SURCHARGE_OVERSIZE');
  const warnings = [];

  for (const rule of rules) {
    if (!activeServices.includes(rule.service)) continue;
    const threshold = parseFloat(rule.threshold_value) || 0;
    let triggered = false;

    if (rule.condition === 'cß║ính d├ái nhß║Ñt'    && longest > threshold) triggered = true;
    if (rule.condition === 'length + girth'   && lgSum   > threshold) triggered = true;
    if (rule.condition === 'trß╗ìng l╞░ß╗úng/kiß╗çn' && gw      > threshold) triggered = true;

    if (triggered) {
      warnings.push({
        service:        rule.service,
        surcharge_type: rule.surcharge_type,
        condition:      rule.condition,
        threshold:      threshold,
        unit:           rule.unit,
      });
    }
  }
  return warnings;
}

// ============================================================
// TRACKING
// ============================================================

function getTracking(id) {
  if (!id) return { error: 'Thiß║┐u m├ú vß║¡n ─æ╞ín' };

  const shipments = sheetToObjects('SHIPMENT');
  const shipment  = shipments.find(s =>
    String(s.id_shipment) === String(id) || String(s.booking_id) === String(id)
  );
  if (!shipment) return { error: 'Kh├┤ng t├¼m thß║Ñy l├┤ h├áng: ' + id };

  const timeline = sheetToObjects('SHIPMENT_TIMELINE')
    .filter(t => String(t.id_shipment) === String(shipment.id_shipment))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return { shipment, timeline };
}

// ============================================================
// SAVE LEAD  (tß╗½ chatbot AI ΓåÆ tab LEAD cß╗ºa spreadsheet CRM)
// Thß╗⌐ tß╗▒ cß╗Öt phß║úi KHß╗ÜP CH├ìNH X├üC header tab LEAD:
// id_deal | assigned_to | lead_status | id_lead | lead_name | tel | email |
// cargo_description | destination_country | total_packages | total_gw | total_vw |
// total_cw | origin_city | cargo_value | currency | source | channel |
// created_at | note | price_quote | chat_id
// ============================================================

function saveLead(d) {
  const sheet = getCrmSheet('LEAD');
  if (!sheet) return { error: 'Kh├┤ng t├¼m thß║Ñy tab LEAD trong spreadsheet CRM' };

  const id  = 'LEAD-' + Date.now();
  const now = new Date();

  sheet.appendRow([
    '',                              // id_deal        (nß╗Öi bß╗Ö CRM, ─æß╗â trß╗æng)
    '',                              // assigned_to    (nß╗Öi bß╗Ö, ─æß╗â trß╗æng)
    d.lead_status || 'collecting',   // lead_status
    id,                              // id_lead
    d.lead_name || '',               // lead_name
    d.tel || '',                     // tel
    d.email || '',                   // email
    d.cargo_description || '',       // cargo_description
    d.destination_country || '',     // destination_country
    d.total_packages || '',          // total_packages
    d.total_gw || '',                // total_gw
    d.total_vw || '',                // total_vw
    d.total_cw || '',                // total_cw
    d.origin_city || '',             // origin_city
    d.cargo_value || '',             // cargo_value
    d.currency || 'VND',             // currency
    d.source || 'chatbot',           // source
    d.channel || 'web-ai',           // channel
    now,                             // created_at
    d.note || '',                    // note
    d.price_quote || '',             // price_quote
    d.chat_id || '',                 // chat_id
  ]);

  notifyNewLead_({ id, ...d });
  return { id };
}

// ============================================================
// TELEGRAM NOTIFICATIONS
// Setup 1 lß║ºn: Project Settings > Script Properties, th├¬m 2 key:
//   TELEGRAM_BOT_TOKEN  = token lß║Ñy tß╗½ @BotFather
//   TELEGRAM_CHAT_ID    = id chat/group nhß║¡n th├┤ng b├ío
// C├ích lß║Ñy: xem docs/vngrow-automation-setup.md trong repo webapp.
// ============================================================

function sendTelegram_(text) {
  const props = PropertiesService.getScriptProperties();
  const token  = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return; // ch╞░a cß║Ñu h├¼nh -> bß╗Å qua ├¬m, kh├┤ng lß╗ùi

  try {
    UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      muteHttpExceptions: true,
    });
  } catch (e) { /* kh├┤ng ─æß╗â lß╗ùi Telegram l├ám hß╗Ång luß╗ông l╞░u lead */ }
}

// B├ío ngay khi c├│ lead mß╗¢i tß╗½ chatbot AI.
function notifyNewLead_(d) {
  const lines = [
    '≡ƒåò <b>Lead mß╗¢i tß╗½ AI chatbot</b>',
    d.lead_name ? `≡ƒæñ ${d.lead_name}` : null,
    d.tel ? `≡ƒô₧ ${d.tel}` : null,
    d.destination_country ? `≡ƒîì ─Éi: ${d.destination_country}` : null,
    d.cargo_description ? `≡ƒôª H├áng: ${d.cargo_description}` : null,
    d.total_gw ? `ΓÜû∩╕Å ${d.total_gw} kg` : null,
    d.price_quote ? `≡ƒÆ░ Gi├í tß║ím t├¡nh: ${Number(d.price_quote).toLocaleString('vi-VN')}─æ` : null,
    `≡ƒôï Trß║íng th├íi: ${d.rfq_status || d.lead_status || 'collecting'}`,
  ].filter(Boolean);
  sendTelegram_(lines.join('\n'));
}

// ============================================================
// VNGROW Express Webapp ΓÇö Google Apps Script
// Spreadsheet: https://docs.google.com/spreadsheets/d/1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc
// Deploy: Extensions > Apps Script > Deploy > New deployment > Web App
//   Execute as: Me | Who has access: Anyone
// ============================================================

const SS_ID = '1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc';
// Spreadsheet CRM (chß╗⌐a c├íc tab LEAD, DEAL, RFQ, BOOKING, SHIPMENT...) ΓÇö KH├üC spreadsheet pricing ß╗ƒ tr├¬n.
const CRM_SS_ID = '1nBUJhnwWpFGgFhgrbrSfbG-Znife_5JXSSyLLSsmHVA';

// ---- Helpers ------------------------------------------------

function getSheet(name) {
  return SpreadsheetApp.openById(SS_ID).getSheetByName(name);
}

function getCrmSheet(name) {
  return SpreadsheetApp.openById(CRM_SS_ID).getSheetByName(name);
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
          // Normalize: "FEDEX IE" ΓåÆ "fedex_ie", "UPS Saver" ΓåÆ "ups_saver"
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
      case 'tracking':       return ok(getTracking(e.parameter.id));
      default:               return err('Unknown action: ' + e.parameter.action);
    }
  } catch (ex) { return err(ex.message); }
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    switch (d.action) {
      case 'saveLead':      return ok(saveLead(d));
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
  const rows  = sheet.getDataRange().getValues();

  const fuel    = {};   // { 'DHL': { fuel_pct, transit_min, transit_max } }
  const vat     = {};   // { 'export': 8, 'import': 0, ... }
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
// RATE LOOKUP HELPERS
// ============================================================

// Normalize zone value: if user entered "5" ΓåÆ "zone_5", "A" ΓåÆ "zone_A", already "zone_5" ΓåÆ "zone_5"
function normalizeZone(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (s === '' || s === '0') return null;
  if (/^zone_/i.test(s)) return s.toLowerCase();
  return 'zone_' + s;
}

// Map cargo_code ΓåÆ cargo_group display name using CONFIG
function cargoCodeToGroup(cargoCode, cargoGroups) {
  const found = cargoGroups.find(g => String(g.cargo_code).trim() === String(cargoCode).trim());
  return found ? String(found.cargo_group).trim() : cargoCode;
}

// Returns the rate value (number) for a given cargo_group display name, CW, and zone column header.
function lookupRate(sheetName, cargoGroupName, cw, zoneHeader) {
  const sheet = getSheet(sheetName);
  if (!sheet) return null;

  const zone = normalizeZone(zoneHeader);
  if (!zone) return null;

  const [headers, ...rows] = sheet.getDataRange().getValues();
  // Try normalized zone (zone_5, zone_A) first, then raw value (country name for Special Route)
  let zoneCol = zone
    ? headers.findIndex(h => String(h).trim().toLowerCase() === zone.toLowerCase())
    : -1;
  if (zoneCol === -1) {
    zoneCol = headers.findIndex(h => String(h).trim().toLowerCase() === String(zoneHeader).trim().toLowerCase());
  }
  if (zoneCol === -1) return null;

  // Match by cargo_group name (case-insensitive, trimmed)
  const brackets = rows
    .filter(r => String(r[0]).trim().toLowerCase() === cargoGroupName.toLowerCase() && !isNaN(parseFloat(r[1])))
    .map(r => ({ weight: parseFloat(r[1]), rate: Number(r[zoneCol]) }))
    .filter(r => r.rate > 0)
    .sort((a, b) => a.weight - b.weight);

  if (brackets.length === 0) return null;

  const match = brackets.find(b => b.weight >= cw) || brackets[brackets.length - 1];
  return match.rate;
}

// ============================================================
// GET RATES  (main endpoint)
// params: country, cargo_code, cw, direction
// ============================================================

function getRates(params) {
  const country    = params.country    || '';
  const cargoCode  = params.cargo_code || 'normal';
  const cw         = parseFloat(params.cw) || 0;
  const direction  = params.direction  || 'export';

  if (!country) return { error: 'Thiß║┐u t├¬n quß╗æc gia' };
  if (cw <= 0)  return { error: 'CW phß║úi > 0' };

  // Zone mapping
  const countries  = sheetToObjects('COUNTRY_ZONE_MAPPING');
  const countryRow = countries.find(r => r.country_name === country);
  if (!countryRow) return { error: 'Kh├┤ng t├¼m thß║Ñy quß╗æc gia: ' + country };

  const cfg        = getConfig();
  const cargoGroups = getCargoGroups();
  const cargoGroupName = cargoCodeToGroup(cargoCode, cargoGroups); // "normal" ΓåÆ "H├áng th╞░ß╗¥ng"
  const vatPct = cfg.vat[direction] !== undefined ? cfg.vat[direction] : (direction === 'export' ? 8 : 0);

  // Standard services
  const SERVICES = [
    { name: 'DHL',           sheet: 'DHL_RATE',           zone: countryRow.dhl           },
    { name: 'FedEx IE',      sheet: 'FEDEX_IE_RATE',      zone: countryRow.fedex_ie      },
    { name: 'FedEx IP',      sheet: 'FEDEX_IP_RATE',      zone: countryRow.fedex_ip      },
    { name: 'UPS Saver',     sheet: 'UPS_SAVER_RATE',     zone: countryRow.ups_saver     },
    { name: 'UPS Expedited', sheet: 'UPS_EXPEDITED_RATE', zone: countryRow.ups_expedited },
  ];

  const results = [];

  for (const svc of SERVICES) {
    if (!svc.zone || svc.zone === '') continue;

    const ratePerKg = lookupRate(svc.sheet, cargoGroupName, cw, svc.zone);
    if (ratePerKg === null) continue;

    const fcfg     = cfg.fuel[svc.name] || { fuel_pct: 0, transit_min: 0, transit_max: 0 };
    const freight  = ratePerKg * cw;
    const fuel     = freight * (fcfg.fuel_pct / 100);
    const subtotal = freight + fuel;
    const vat      = subtotal * (vatPct / 100);
    const total    = subtotal + vat;

    results.push({
      service:            svc.name,
      zone:               svc.zone,
      rate_per_kg:        ratePerKg,
      chargeable_weight:  cw,
      freight:            Math.round(freight),
      fuel_surcharge:     Math.round(fuel),
      fuel_pct:           fcfg.fuel_pct,
      vat:                Math.round(vat),
      vat_pct:            vatPct,
      total:              Math.round(total),
      transit_min:        fcfg.transit_min,
      transit_max:        fcfg.transit_max,
    });
  }

  // Special Route (column header = country name)
  const srRate = lookupRate('SPECIAL_ROUTE_RATE', cargoGroupName, cw, country);
  if (srRate !== null) {
    const fcfg    = cfg.fuel['Special Route'] || { fuel_pct: 0, transit_min: 10, transit_max: 12 };
    const freight = srRate * cw;
    const fuel    = freight * (fcfg.fuel_pct / 100);
    const total   = freight + fuel; // Special Route: VAT = 0%
    results.push({
      service:           'Special Route',
      zone:              country,
      rate_per_kg:       srRate,
      chargeable_weight: cw,
      freight:           Math.round(freight),
      fuel_surcharge:    Math.round(fuel),
      fuel_pct:          fcfg.fuel_pct,
      vat:               0,
      vat_pct:           0,
      total:             Math.round(total),
      transit_min:       fcfg.transit_min,
      transit_max:       fcfg.transit_max,
    });
  }

  // Check oversize per piece (warning only ΓÇö surcharge amount filled in later)
  const oversizeWarnings = checkOversize(params, results.map(r => r.service));

  results.sort((a, b) => a.total - b.total);
  return { rates: results, oversize_warnings: oversizeWarnings };
}

// ============================================================
// OVERSIZE CHECK  (returns warning list, not exact fee)
// params may include piece_l, piece_w, piece_h, piece_gw (cm / kg)
// ============================================================

function checkOversize(params, activeServices) {
  const l  = parseFloat(params.piece_l)  || 0;
  const w  = parseFloat(params.piece_w)  || 0;
  const h  = parseFloat(params.piece_h)  || 0;
  const gw = parseFloat(params.piece_gw) || 0;
  if (l === 0 && w === 0 && h === 0) return [];

  const dims    = [l, w, h].sort((a, b) => b - a);
  const longest = dims[0];
  const girth   = (dims[1] + dims[2]) * 2;
  const lgSum   = longest + girth;

  const rules = sheetToObjects('SURCHARGE_OVERSIZE');
  const warnings = [];

  for (const rule of rules) {
    if (!activeServices.includes(rule.service)) continue;
    const threshold = parseFloat(rule.threshold_value) || 0;
    let triggered = false;

    if (rule.condition === 'cß║ính d├ái nhß║Ñt'    && longest > threshold) triggered = true;
    if (rule.condition === 'length + girth'   && lgSum   > threshold) triggered = true;
    if (rule.condition === 'trß╗ìng l╞░ß╗úng/kiß╗çn' && gw      > threshold) triggered = true;

    if (triggered) {
      warnings.push({
        service:        rule.service,
        surcharge_type: rule.surcharge_type,
        condition:      rule.condition,
        threshold:      threshold,
        unit:           rule.unit,
      });
    }
  }
  return warnings;
}

// ============================================================
// TRACKING
// ============================================================

function getTracking(id) {
  if (!id) return { error: 'Thiß║┐u m├ú vß║¡n ─æ╞ín' };

  const shipments = sheetToObjects('SHIPMENT');
  const shipment  = shipments.find(s =>
    String(s.id_shipment) === String(id) || String(s.booking_id) === String(id)
  );
  if (!shipment) return { error: 'Kh├┤ng t├¼m thß║Ñy l├┤ h├áng: ' + id };

  const timeline = sheetToObjects('SHIPMENT_TIMELINE')
    .filter(t => String(t.id_shipment) === String(shipment.id_shipment))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return { shipment, timeline };
}

// ============================================================
// SAVE LEAD  (tß╗½ chatbot AI ΓåÆ tab LEAD cß╗ºa spreadsheet CRM)
// Thß╗⌐ tß╗▒ cß╗Öt phß║úi KHß╗ÜP CH├ìNH X├üC header tab LEAD:
// id_deal | assigned_to | lead_status | id_lead | lead_name | tel | email |
// cargo_description | destination_country | total_packages | total_gw | total_vw |
// total_cw | origin_city | cargo_value | currency | source | channel |
// created_at | note | price_quote | chat_id
// ============================================================

function saveLead(d) {
  const sheet = getCrmSheet('LEAD');
  if (!sheet) return { error: 'Kh├┤ng t├¼m thß║Ñy tab LEAD trong spreadsheet CRM' };

  const id  = 'LEAD-' + Date.now();
  const now = new Date();

  sheet.appendRow([
    '',                              // id_deal        (nß╗Öi bß╗Ö CRM, ─æß╗â trß╗æng)
    '',                              // assigned_to    (nß╗Öi bß╗Ö, ─æß╗â trß╗æng)
    d.lead_status || 'collecting',   // lead_status
    id,                              // id_lead
    d.lead_name || '',               // lead_name
    d.tel || '',                     // tel
    d.email || '',                   // email
    d.cargo_description || '',       // cargo_description
    d.destination_country || '',     // destination_country
    d.total_packages || '',          // total_packages
    d.total_gw || '',                // total_gw
    d.total_vw || '',                // total_vw
    d.total_cw || '',                // total_cw
    d.origin_city || '',             // origin_city
    d.cargo_value || '',             // cargo_value
    d.currency || 'VND',             // currency
    d.source || 'chatbot',           // source
    d.channel || 'web-ai',           // channel
    now,                             // created_at
    d.note || '',                    // note
    d.price_quote || '',             // price_quote
    d.chat_id || '',                 // chat_id
  ]);

  notifyNewLead_({ id, ...d });
  return { id };
}

// ============================================================
// TELEGRAM NOTIFICATIONS
// Setup 1 lß║ºn: Project Settings > Script Properties, th├¬m 2 key:
//   TELEGRAM_BOT_TOKEN  = token lß║Ñy tß╗½ @BotFather
//   TELEGRAM_CHAT_ID    = id chat/group nhß║¡n th├┤ng b├ío
// C├ích lß║Ñy: xem docs/vngrow-automation-setup.md trong repo webapp.
// ============================================================

function sendTelegram_(text) {
  const props = PropertiesService.getScriptProperties();
  const token  = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return; // ch╞░a cß║Ñu h├¼nh -> bß╗Å qua ├¬m, kh├┤ng lß╗ùi

  try {
    UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      muteHttpExceptions: true,
    });
  } catch (e) { /* kh├┤ng ─æß╗â lß╗ùi Telegram l├ám hß╗Ång luß╗ông l╞░u lead */ }
}

// B├ío ngay khi c├│ lead mß╗¢i tß╗½ chatbot AI.
function notifyNewLead_(d) {
  const lines = [
    '≡ƒåò <b>Lead mß╗¢i tß╗½ AI chatbot</b>',
    d.lead_name ? `≡ƒæñ ${d.lead_name}` : null,
    d.tel ? `≡ƒô₧ ${d.tel}` : null,
    d.destination_country ? `≡ƒîì ─Éi: ${d.destination_country}` : null,
    d.cargo_description ? `≡ƒôª H├áng: ${d.cargo_description}` : null,
    d.total_gw ? `ΓÜû∩╕Å ${d.total_gw} kg` : null,
    d.price_quote ? `≡ƒÆ░ Gi├í tß║ím t├¡nh: ${Number(d.price_quote).toLocaleString('vi-VN')}─æ` : null,
    `≡ƒôï Trß║íng th├íi: ${d.rfq_status || d.lead_status || 'collecting'}`,
  ].filter(Boolean);
  sendTelegram_(lines.join('\n'));
}

// ============================================================
// NHß║«C LEAD Bß╗è Bß╗Ä QU├èN (chß║íy bß║▒ng Time-driven trigger, vd mß╗ùi 3 tiß║┐ng)
// Nhß║»c c├íc lead vß║½n ß╗ƒ trß║íng th├íi "collecting" qu├í 24h ch╞░a c├│ ai xß╗¡ l├╜.
// ============================================================

function checkStaleLeads() {
  const sheet = getCrmSheet('LEAD');
  if (!sheet) return;

  const [headers, ...rows] = sheet.getDataRange().getValues();
  const col = name => headers.findIndex(h => String(h).trim().toLowerCase() === name);
  const iStatus = col('lead_status'), iName = col('lead_name'), iTel = col('tel');
  const iCreated = col('created_at'), iAssigned = col('assigned_to'), iSource = col('source');

  const now = new Date();
  const staleList = [];

  rows.forEach(r => {
    if (String(r[iStatus]).trim().toLowerCase() !== 'collecting') return;
    if (iAssigned !== -1 && String(r[iAssigned]).trim() !== '') return; // ─æ├ú c├│ ng╞░ß╗¥i nhß║¡n
    const created = new Date(r[iCreated]);
    if (isNaN(created)) return;
    const hoursSince = (now - created) / 36e5;
    if (hoursSince >= 24) {
      staleList.push(`ΓÇó ${r[iName] || '(ch╞░a c├│ t├¬n)'} - ${r[iTel] || 'no S─ÉT'} (${Math.floor(hoursSince)}h ch╞░a xß╗¡ l├╜)`);
    }
  });

  if (staleList.length) {
    sendTelegram_(`ΓÅ░ <b>${staleList.length} lead ch╞░a xß╗¡ l├╜ >24h</b>\n${staleList.join('\n')}`);
  }
}

// ============================================================
// VNGROW Express Webapp ΓÇö Google Apps Script
// Spreadsheet: https://docs.google.com/spreadsheets/d/1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc
// Deploy: Extensions > Apps Script > Deploy > New deployment > Web App
//   Execute as: Me | Who has access: Anyone
// ============================================================

const SS_ID = '1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc';
// Spreadsheet CRM (chß╗⌐a c├íc tab LEAD, DEAL, RFQ, BOOKING, SHIPMENT...) ΓÇö KH├üC spreadsheet pricing ß╗ƒ tr├¬n.
const CRM_SS_ID = '1nBUJhnwWpFGgFhgrbrSfbG-Znife_5JXSSyLLSsmHVA';

// ---- Helpers ------------------------------------------------

function getSheet(name) {
  return SpreadsheetApp.openById(SS_ID).getSheetByName(name);
}

function getCrmSheet(name) {
  return SpreadsheetApp.openById(CRM_SS_ID).getSheetByName(name);
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
          // Normalize: "FEDEX IE" ΓåÆ "fedex_ie", "UPS Saver" ΓåÆ "ups_saver"
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
      case 'tracking':       return ok(getTracking(e.parameter.id));
      default:               return err('Unknown action: ' + e.parameter.action);
    }
  } catch (ex) { return err(ex.message); }
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    switch (d.action) {
      case 'saveLead':      return ok(saveLead(d));
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
  const rows  = sheet.getDataRange().getValues();

  const fuel    = {};   // { 'DHL': { fuel_pct, transit_min, transit_max } }
  const vat     = {};   // { 'export': 8, 'import': 0, ... }
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
// RATE LOOKUP HELPERS
// ============================================================

// Normalize zone value: if user entered "5" ΓåÆ "zone_5", "A" ΓåÆ "zone_A", already "zone_5" ΓåÆ "zone_5"
function normalizeZone(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (s === '' || s === '0') return null;
  if (/^zone_/i.test(s)) return s.toLowerCase();
  return 'zone_' + s;
}

// Map cargo_code ΓåÆ cargo_group display name using CONFIG
function cargoCodeToGroup(cargoCode, cargoGroups) {
  const found = cargoGroups.find(g => String(g.cargo_code).trim() === String(cargoCode).trim());
  return found ? String(found.cargo_group).trim() : cargoCode;
}

// Returns the rate value (number) for a given cargo_group display name, CW, and zone column header.
function lookupRate(sheetName, cargoGroupName, cw, zoneHeader) {
  const sheet = getSheet(sheetName);
  if (!sheet) return null;

  const zone = normalizeZone(zoneHeader);
  if (!zone) return null;

  const [headers, ...rows] = sheet.getDataRange().getValues();
  // Try normalized zone (zone_5, zone_A) first, then raw value (country name for Special Route)
  let zoneCol = zone
    ? headers.findIndex(h => String(h).trim().toLowerCase() === zone.toLowerCase())
    : -1;
  if (zoneCol === -1) {
    zoneCol = headers.findIndex(h => String(h).trim().toLowerCase() === String(zoneHeader).trim().toLowerCase());
  }
  if (zoneCol === -1) return null;

  // Match by cargo_group name (case-insensitive, trimmed)
  const brackets = rows
    .filter(r => String(r[0]).trim().toLowerCase() === cargoGroupName.toLowerCase() && !isNaN(parseFloat(r[1])))
    .map(r => ({ weight: parseFloat(r[1]), rate: Number(r[zoneCol]) }))
    .filter(r => r.rate > 0)
    .sort((a, b) => a.weight - b.weight);

  if (brackets.length === 0) return null;

  const match = brackets.find(b => b.weight >= cw) || brackets[brackets.length - 1];
  return match.rate;
}

// ============================================================
// GET RATES  (main endpoint)
// params: country, cargo_code, cw, direction
// ============================================================

function getRates(params) {
  const country    = params.country    || '';
  const cargoCode  = params.cargo_code || 'normal';
  const cw         = parseFloat(params.cw) || 0;
  const direction  = params.direction  || 'export';

  if (!country) return { error: 'Thiß║┐u t├¬n quß╗æc gia' };
  if (cw <= 0)  return { error: 'CW phß║úi > 0' };

  // Zone mapping
  const countries  = sheetToObjects('COUNTRY_ZONE_MAPPING');
  const countryRow = countries.find(r => r.country_name === country);
  if (!countryRow) return { error: 'Kh├┤ng t├¼m thß║Ñy quß╗æc gia: ' + country };

  const cfg        = getConfig();
  const cargoGroups = getCargoGroups();
  const cargoGroupName = cargoCodeToGroup(cargoCode, cargoGroups); // "normal" ΓåÆ "H├áng th╞░ß╗¥ng"
  const vatPct = cfg.vat[direction] !== undefined ? cfg.vat[direction] : (direction === 'export' ? 8 : 0);

  // Standard services
  const SERVICES = [
    { name: 'DHL',           sheet: 'DHL_RATE',           zone: countryRow.dhl           },
    { name: 'FedEx IE',      sheet: 'FEDEX_IE_RATE',      zone: countryRow.fedex_ie      },
    { name: 'FedEx IP',      sheet: 'FEDEX_IP_RATE',      zone: countryRow.fedex_ip      },
    { name: 'UPS Saver',     sheet: 'UPS_SAVER_RATE',     zone: countryRow.ups_saver     },
    { name: 'UPS Expedited', sheet: 'UPS_EXPEDITED_RATE', zone: countryRow.ups_expedited },
  ];

  const results = [];

  for (const svc of SERVICES) {
    if (!svc.zone || svc.zone === '') continue;

    const ratePerKg = lookupRate(svc.sheet, cargoGroupName, cw, svc.zone);
    if (ratePerKg === null) continue;

    const fcfg     = cfg.fuel[svc.name] || { fuel_pct: 0, transit_min: 0, transit_max: 0 };
    const freight  = ratePerKg * cw;
    const fuel     = freight * (fcfg.fuel_pct / 100);
    const subtotal = freight + fuel;
    const vat      = subtotal * (vatPct / 100);
    const total    = subtotal + vat;

    results.push({
      service:            svc.name,
      zone:               svc.zone,
      rate_per_kg:        ratePerKg,
      chargeable_weight:  cw,
      freight:            Math.round(freight),
      fuel_surcharge:     Math.round(fuel),
      fuel_pct:           fcfg.fuel_pct,
      vat:                Math.round(vat),
      vat_pct:            vatPct,
      total:              Math.round(total),
      transit_min:        fcfg.transit_min,
      transit_max:        fcfg.transit_max,
    });
  }

  // Special Route (column header = country name)
  const srRate = lookupRate('SPECIAL_ROUTE_RATE', cargoGroupName, cw, country);
  if (srRate !== null) {
    const fcfg    = cfg.fuel['Special Route'] || { fuel_pct: 0, transit_min: 10, transit_max: 12 };
    const freight = srRate * cw;
    const fuel    = freight * (fcfg.fuel_pct / 100);
    const total   = freight + fuel; // Special Route: VAT = 0%
    results.push({
      service:           'Special Route',
      zone:              country,
      rate_per_kg:       srRate,
      chargeable_weight: cw,
      freight:           Math.round(freight),
      fuel_surcharge:    Math.round(fuel),
      fuel_pct:          fcfg.fuel_pct,
      vat:               0,
      vat_pct:           0,
      total:             Math.round(total),
      transit_min:       fcfg.transit_min,
      transit_max:       fcfg.transit_max,
    });
  }

  // Check oversize per piece (warning only ΓÇö surcharge amount filled in later)
  const oversizeWarnings = checkOversize(params, results.map(r => r.service));

  results.sort((a, b) => a.total - b.total);
  return { rates: results, oversize_warnings: oversizeWarnings };
}

// ============================================================
// OVERSIZE CHECK  (returns warning list, not exact fee)
// params may include piece_l, piece_w, piece_h, piece_gw (cm / kg)
// ============================================================

function checkOversize(params, activeServices) {
  const l  = parseFloat(params.piece_l)  || 0;
  const w  = parseFloat(params.piece_w)  || 0;
  const h  = parseFloat(params.piece_h)  || 0;
  const gw = parseFloat(params.piece_gw) || 0;
  if (l === 0 && w === 0 && h === 0) return [];

  const dims    = [l, w, h].sort((a, b) => b - a);
  const longest = dims[0];
  const girth   = (dims[1] + dims[2]) * 2;
  const lgSum   = longest + girth;

  const rules = sheetToObjects('SURCHARGE_OVERSIZE');
  const warnings = [];

  for (const rule of rules) {
    if (!activeServices.includes(rule.service)) continue;
    const threshold = parseFloat(rule.threshold_value) || 0;
    let triggered = false;

    if (rule.condition === 'cß║ính d├ái nhß║Ñt'    && longest > threshold) triggered = true;
    if (rule.condition === 'length + girth'   && lgSum   > threshold) triggered = true;
    if (rule.condition === 'trß╗ìng l╞░ß╗úng/kiß╗çn' && gw      > threshold) triggered = true;

    if (triggered) {
      warnings.push({
        service:        rule.service,
        surcharge_type: rule.surcharge_type,
        condition:      rule.condition,
        threshold:      threshold,
        unit:           rule.unit,
      });
    }
  }
  return warnings;
}

// ============================================================
// TRACKING
// ============================================================

function getTracking(id) {
  if (!id) return { error: 'Thiß║┐u m├ú vß║¡n ─æ╞ín' };

  const shipments = sheetToObjects('SHIPMENT');
  const shipment  = shipments.find(s =>
    String(s.id_shipment) === String(id) || String(s.booking_id) === String(id)
  );
  if (!shipment) return { error: 'Kh├┤ng t├¼m thß║Ñy l├┤ h├áng: ' + id };

  const timeline = sheetToObjects('SHIPMENT_TIMELINE')
    .filter(t => String(t.id_shipment) === String(shipment.id_shipment))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return { shipment, timeline };
}

// ============================================================
// SAVE LEAD  (tß╗½ chatbot AI ΓåÆ tab LEAD cß╗ºa spreadsheet CRM)
// Thß╗⌐ tß╗▒ cß╗Öt phß║úi KHß╗ÜP CH├ìNH X├üC header tab LEAD:
// id_deal | assigned_to | lead_status | id_lead | lead_name | tel | email |
// cargo_description | destination_country | total_packages | total_gw | total_vw |
// total_cw | origin_city | cargo_value | currency | source | channel |
// created_at | note | price_quote | chat_id
// ============================================================

function saveLead(d) {
  const sheet = getCrmSheet('LEAD');
  if (!sheet) return { error: 'Kh├┤ng t├¼m thß║Ñy tab LEAD trong spreadsheet CRM' };

  const id  = 'LEAD-' + Date.now();
  const now = new Date();

  sheet.appendRow([
    '',                              // id_deal        (nß╗Öi bß╗Ö CRM, ─æß╗â trß╗æng)
    '',                              // assigned_to    (nß╗Öi bß╗Ö, ─æß╗â trß╗æng)
    d.lead_status || 'collecting',   // lead_status
    id,                              // id_lead
    d.lead_name || '',               // lead_name
    d.tel || '',                     // tel
    d.email || '',                   // email
    d.cargo_description || '',       // cargo_description
    d.destination_country || '',     // destination_country
    d.total_packages || '',          // total_packages
    d.total_gw || '',                // total_gw
    d.total_vw || '',                // total_vw
    d.total_cw || '',                // total_cw
    d.origin_city || '',             // origin_city
    d.cargo_value || '',             // cargo_value
    d.currency || 'VND',             // currency
    d.source || 'chatbot',           // source
    d.channel || 'web-ai',           // channel
    now,                             // created_at
    d.note || '',                    // note
    d.price_quote || '',             // price_quote
    d.chat_id || '',                 // chat_id
  ]);

  notifyNewLead_({ id, ...d });
  return { id };
}

// ============================================================
// TELEGRAM NOTIFICATIONS
// Setup 1 lß║ºn: Project Settings > Script Properties, th├¬m 2 key:
//   TELEGRAM_BOT_TOKEN  = token lß║Ñy tß╗½ @BotFather
//   TELEGRAM_CHAT_ID    = id chat/group nhß║¡n th├┤ng b├ío
// C├ích lß║Ñy: xem docs/vngrow-automation-setup.md trong repo webapp.
// ============================================================

function sendTelegram_(text) {
  const props = PropertiesService.getScriptProperties();
  const token  = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return; // ch╞░a cß║Ñu h├¼nh -> bß╗Å qua ├¬m, kh├┤ng lß╗ùi

  try {
    UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      muteHttpExceptions: true,
    });
  } catch (e) { /* kh├┤ng ─æß╗â lß╗ùi Telegram l├ám hß╗Ång luß╗ông l╞░u lead */ }
}

// B├ío ngay khi c├│ lead mß╗¢i tß╗½ chatbot AI.
function notifyNewLead_(d) {
  const lines = [
    '≡ƒåò <b>Lead mß╗¢i tß╗½ AI chatbot</b>',
    d.lead_name ? `≡ƒæñ ${d.lead_name}` : null,
    d.tel ? `≡ƒô₧ ${d.tel}` : null,
    d.destination_country ? `≡ƒîì ─Éi: ${d.destination_country}` : null,
    d.cargo_description ? `≡ƒôª H├áng: ${d.cargo_description}` : null,
    d.total_gw ? `ΓÜû∩╕Å ${d.total_gw} kg` : null,
    d.price_quote ? `≡ƒÆ░ Gi├í tß║ím t├¡nh: ${Number(d.price_quote).toLocaleString('vi-VN')}─æ` : null,
    `≡ƒôï Trß║íng th├íi: ${d.rfq_status || d.lead_status || 'collecting'}`,
  ].filter(Boolean);
  sendTelegram_(lines.join('\n'));
}

// ============================================================
// NHß║«C LEAD Bß╗è Bß╗Ä QU├èN (chß║íy bß║▒ng Time-driven trigger, vd mß╗ùi 3 tiß║┐ng)
// Nhß║»c c├íc lead vß║½n ß╗ƒ trß║íng th├íi "collecting" qu├í 24h ch╞░a c├│ ai xß╗¡ l├╜.
// ============================================================

function checkStaleLeads() {
  const sheet = getCrmSheet('LEAD');
  if (!sheet) return;

  const [headers, ...rows] = sheet.getDataRange().getValues();
  const col = name => headers.findIndex(h => String(h).trim().toLowerCase() === name);
  const iStatus = col('lead_status'), iName = col('lead_name'), iTel = col('tel');
  const iCreated = col('created_at'), iAssigned = col('assigned_to'), iSource = col('source');

  const now = new Date();
  const staleList = [];

  rows.forEach(r => {
    if (String(r[iStatus]).trim().toLowerCase() !== 'collecting') return;
    if (iAssigned !== -1 && String(r[iAssigned]).trim() !== '') return; // ─æ├ú c├│ ng╞░ß╗¥i nhß║¡n
    const created = new Date(r[iCreated]);
    if (isNaN(created)) return;
    const hoursSince = (now - created) / 36e5;
    if (hoursSince >= 24) {
      staleList.push(`ΓÇó ${r[iName] || '(ch╞░a c├│ t├¬n)'} - ${r[iTel] || 'no S─ÉT'} (${Math.floor(hoursSince)}h ch╞░a xß╗¡ l├╜)`);
    }
  });

  if (staleList.length) {
    sendTelegram_(`ΓÅ░ <b>${staleList.length} lead ch╞░a xß╗¡ l├╜ >24h</b>\n${staleList.join('\n')}`);
  }
}

// ============================================================
// NHß║«C Lß╗èCH ─É─éNG CONTENT (chß║íy bß║▒ng Time-driven trigger, mß╗ùi ng├áy ~8h s├íng)
// ─Éß╗ìc tab CONTENT_CALENDAR trong spreadsheet CRM, cß╗Öt:
//   date | pillar | format | title | content | status
// Nß║┐u c├│ d├▓ng ─æ├║ng ng├áy h├┤m nay v├á status != "─É├ú ─æ─âng" -> nhß║»c k├¿m nß╗Öi dung.
// ============================================================

function checkContentToday() {
  const sheet = getCrmSheet('CONTENT_CALENDAR');
  if (!sheet) return; // ch╞░a tß║ío tab -> bß╗Å qua ├¬m

  const [headers, ...rows] = sheet.getDataRange().getValues();
  const col = name => headers.findIndex(h => String(h).trim().toLowerCase() === name);
  const iDate = col('date'), iTitle = col('title'), iContent = col('content'), iStatus = col('status');

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  rows.forEach(r => {
    const d = new Date(r[iDate]);
    if (isNaN(d)) return;
    d.setHours(0, 0, 0, 0);
    if (d.getTime() !== today.getTime()) return;
    if (String(r[iStatus]).trim() === '─É├ú ─æ─âng') return;

    sendTelegram_(`≡ƒôà <b>H├┤m nay cß║ºn ─æ─âng:</b> ${r[iTitle] || ''}\n\n${r[iContent] || '(xem docs/vngrow-content-batch-01.md)'}`);
  });
}