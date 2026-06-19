// ============================================================
// VNGROW Express Webapp — Google Apps Script
// Spreadsheet: https://docs.google.com/spreadsheets/d/1lY0wWpwfuuV9GLiQq0ha7UwfQWhYdrf2o205-yLJQGc
// Deploy: Extensions > Apps Script > Deploy > New deployment > Web App
//   Execute as: Me | Who has access: Anyone
// ============================================================

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
      headers.forEach((h, i) => { if (h) obj[h] = r[i]; });
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
