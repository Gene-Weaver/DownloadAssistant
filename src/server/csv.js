/*
 * Minimal RFC-4180 CSV parser — the inverse of gbif-api.js's writeCsv/csvEscape.
 *
 * Writer contract it round-trips: fields joined by ',', records by '\n' with a
 * single trailing '\n'; a field is quoted (wrapped in ") iff it contains a
 * quote, comma, or newline, with internal quotes doubled ("" -> "). Null becomes
 * ''. Pure JS (no fs/electron) so the server layer stays portable.
 *
 * Returns { columns, rows, total } where columns is the header row and each row
 * is an object keyed by header name (missing trailing cells default to '').
 */

function parseCsv(text) {
  const s = String(text == null ? '' : text);
  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => { record.push(field); field = ''; };
  const endRecord = () => { records.push(record); record = []; };

  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue;                          // closing quote
      }
      field += c; i++; continue;                                  // literal (incl , \n \r)
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\n') { endField(); endRecord(); i++; continue; }
    if (c === '\r') { endField(); endRecord(); if (s[i + 1] === '\n') i++; i++; continue; }
    field += c; i++;
  }
  // Flush a trailing record only if it has pending content — this drops the
  // phantom empty record created by the writer's single trailing '\n' while
  // still capturing a final line that lacks a newline.
  if (field.length || record.length) { endField(); endRecord(); }

  if (!records.length) return { columns: [], rows: [], total: 0 };
  const columns = records[0];
  const rows = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    const obj = {};
    for (let c = 0; c < columns.length; c++) obj[columns[c]] = rec[c] != null ? rec[c] : '';
    rows.push(obj);
  }
  return { columns, rows, total: rows.length };
}

module.exports = { parseCsv };
