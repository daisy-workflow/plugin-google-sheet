// One handler per `operation` value the manifest declares. Each
// handler takes the resolved auth + the node inputs + the ctx signal,
// and returns the operation-specific payload that index.js wraps into
// the standard { ok, operation, status, result, url } envelope.

import { sheetsFetch, spreadsheetUrl, encodeRange } from "./client.js";

// Helpers ──────────────────────────────────────────────────────────────

// Convert a 2D array (rows × cols) with the first row as headers into
// an array of objects. Used for sheet.get when useHeaders is true.
function rowsToObjects(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const headers = (rows[0] || []).map(h => String(h ?? "").trim());
  return rows.slice(1).map(row => {
    const o = {};
    for (let i = 0; i < headers.length; i++) {
      if (headers[i]) o[headers[i]] = row[i] ?? null;
    }
    return o;
  });
}

// Convert an array of objects into a 2D row matrix matching the
// existing header row in the sheet. Unknown keys are dropped; missing
// values come through as empty strings. Used for sheet.append /
// sheet.update when useHeaders is true.
//
// `headers` is the sheet's actual first row, read by the caller (one
// extra Sheets API call). If the caller passes objects without a known
// header row, we derive headers from the union of keys across the
// input array — useful for append-to-empty-sheet.
function objectsToRows(items, knownHeaders) {
  if (!Array.isArray(items) || items.length === 0) return { headers: knownHeaders || [], rows: [] };
  const headers = (knownHeaders && knownHeaders.length)
    ? knownHeaders.slice()
    : Array.from(new Set(items.flatMap(o => Object.keys(o || {}))));
  const rows = items.map(o =>
    headers.map(h => {
      const v = (o || {})[h];
      return v == null ? "" : v;
    }),
  );
  return { headers, rows };
}

async function readHeaders(auth, spreadsheetId, range, timeoutMs, signal) {
  // Trim the range to its first row. If the caller passed "Sheet1" we
  // read "Sheet1!1:1"; if they passed "Sheet1!A2:D" we read
  // "Sheet1!A1:D1". Cheap and avoids dragging in the whole sheet.
  const firstRowRange = oneRowOf(range || "Sheet1");
  const { body } = await sheetsFetch(
    auth,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(firstRowRange)}`,
    { method: "GET" }, timeoutMs, signal,
  );
  return (body?.values?.[0] || []).map(h => String(h ?? "").trim());
}

function oneRowOf(range) {
  // Treats range as A1 notation and reduces it to a 1-row variant.
  // "Sheet1" → "Sheet1!1:1"
  // "Sheet1!A2:D10" → "Sheet1!A1:D1"
  if (!range) return "Sheet1!1:1";
  const m = range.match(/^([^!]+)(?:!(.+))?$/);
  const sheet = m?.[1] || "Sheet1";
  const cell  = m?.[2];
  if (!cell) return `${sheet}!1:1`;
  // Strip row digits to find the column range, then pin to row 1.
  const cols = cell.split(":").map(part => part.replace(/[0-9]+$/, ""));
  if (cols[0] && cols[1]) return `${sheet}!${cols[0]}1:${cols[1]}1`;
  if (cols[0])            return `${sheet}!${cols[0]}1`;
  return `${sheet}!1:1`;
}

// ── sheet.get ──────────────────────────────────────────────────────────
export async function sheetGet(auth, input, signal) {
  const {
    spreadsheetId, range = "Sheet1", useHeaders = false,
    valueRenderOption = "FORMATTED_VALUE",
    majorDimension    = "ROWS",
    timeoutMs = 20000,
  } = input || {};
  if (!spreadsheetId) throw new Error("operation=sheet.get requires spreadsheetId");

  const qs = new URLSearchParams({ valueRenderOption, majorDimension });
  const { status, body } = await sheetsFetch(
    auth,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(range)}?${qs}`,
    { method: "GET" }, timeoutMs, signal,
  );

  const rows = Array.isArray(body?.values) ? body.values : [];
  return {
    status,
    result: useHeaders
      ? { values: rows, rows: rowsToObjects(rows), range: body?.range }
      : { values: rows, range: body?.range },
    url:    spreadsheetUrl(spreadsheetId),
  };
}

// ── sheet.append ───────────────────────────────────────────────────────
export async function sheetAppend(auth, input, signal) {
  const {
    spreadsheetId, range = "Sheet1", values,
    useHeaders = false,
    valueInputOption = "USER_ENTERED",
    timeoutMs = 20000,
  } = input || {};
  if (!spreadsheetId) throw new Error("operation=sheet.append requires spreadsheetId");
  if (values == null) throw new Error("operation=sheet.append requires values (2D array or array of objects)");

  // Normalize `values` into a 2D array.
  let payload;
  if (Array.isArray(values) && values.length && typeof values[0] === "object" && !Array.isArray(values[0])) {
    // Array of objects — map under existing headers (or derive if absent).
    const knownHeaders = useHeaders
      ? await readHeaders(auth, spreadsheetId, range, timeoutMs, signal)
      : null;
    const { rows } = objectsToRows(values, knownHeaders);
    payload = rows;
  } else if (Array.isArray(values) && (!values.length || Array.isArray(values[0]))) {
    payload = values;
  } else {
    throw new Error("`values` must be a 2D array or an array of objects");
  }

  const qs = new URLSearchParams({
    valueInputOption,
    insertDataOption: "INSERT_ROWS",
  });
  const { status, body } = await sheetsFetch(
    auth,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(range)}:append?${qs}`,
    { method: "POST", body: JSON.stringify({ values: payload }) },
    timeoutMs, signal,
  );

  return { status, result: body, url: spreadsheetUrl(spreadsheetId) };
}

// ── sheet.update ───────────────────────────────────────────────────────
export async function sheetUpdate(auth, input, signal) {
  const {
    spreadsheetId, range, values,
    useHeaders = false,
    valueInputOption = "USER_ENTERED",
    timeoutMs = 20000,
  } = input || {};
  if (!spreadsheetId) throw new Error("operation=sheet.update requires spreadsheetId");
  if (!range)         throw new Error("operation=sheet.update requires range");
  if (values == null) throw new Error("operation=sheet.update requires values");

  let payload;
  if (Array.isArray(values) && values.length && typeof values[0] === "object" && !Array.isArray(values[0])) {
    const knownHeaders = useHeaders
      ? await readHeaders(auth, spreadsheetId, range, timeoutMs, signal)
      : null;
    const { rows } = objectsToRows(values, knownHeaders);
    payload = rows;
  } else {
    payload = values;
  }

  const qs = new URLSearchParams({ valueInputOption });
  const { status, body } = await sheetsFetch(
    auth,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(range)}?${qs}`,
    { method: "PUT", body: JSON.stringify({ values: payload }) },
    timeoutMs, signal,
  );

  return { status, result: body, url: spreadsheetUrl(spreadsheetId) };
}

// ── sheet.clear ────────────────────────────────────────────────────────
export async function sheetClear(auth, input, signal) {
  const { spreadsheetId, range, timeoutMs = 15000 } = input || {};
  if (!spreadsheetId) throw new Error("operation=sheet.clear requires spreadsheetId");
  if (!range)         throw new Error("operation=sheet.clear requires range");

  const { status, body } = await sheetsFetch(
    auth,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(range)}:clear`,
    { method: "POST", body: JSON.stringify({}) },
    timeoutMs, signal,
  );
  return { status, result: body, url: spreadsheetUrl(spreadsheetId) };
}

// ── sheet.delete-rows ──────────────────────────────────────────────────
export async function sheetDeleteRows(auth, input, signal) {
  const {
    spreadsheetId, sheetId, startIndex, endIndex,
    timeoutMs = 15000,
  } = input || {};
  if (!spreadsheetId)      throw new Error("operation=sheet.delete-rows requires spreadsheetId");
  if (sheetId == null)     throw new Error("operation=sheet.delete-rows requires sheetId (numeric — see spreadsheet.get)");
  if (startIndex == null)  throw new Error("operation=sheet.delete-rows requires startIndex (0-based)");
  if (endIndex == null)    throw new Error("operation=sheet.delete-rows requires endIndex (0-based, exclusive)");
  if (endIndex <= startIndex) throw new Error("endIndex must be greater than startIndex");

  const reqBody = {
    requests: [{
      deleteDimension: {
        range: {
          sheetId:    Number(sheetId),
          dimension:  "ROWS",
          startIndex: Number(startIndex),
          endIndex:   Number(endIndex),
        },
      },
    }],
  };
  const { status, body } = await sheetsFetch(
    auth,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    { method: "POST", body: JSON.stringify(reqBody) },
    timeoutMs, signal,
  );
  return { status, result: body, url: spreadsheetUrl(spreadsheetId) };
}

// ── spreadsheet.create ─────────────────────────────────────────────────
export async function spreadsheetCreate(auth, input, signal) {
  const { title, sheetTitles, timeoutMs = 20000 } = input || {};
  if (!title) throw new Error("operation=spreadsheet.create requires title");

  const reqBody = {
    properties: { title },
  };
  if (Array.isArray(sheetTitles) && sheetTitles.length) {
    reqBody.sheets = sheetTitles.map(t => ({ properties: { title: String(t) } }));
  }
  const { status, body } = await sheetsFetch(
    auth,
    "/spreadsheets",
    { method: "POST", body: JSON.stringify(reqBody) },
    timeoutMs, signal,
  );
  return {
    status,
    result: body,
    url:    body?.spreadsheetId ? spreadsheetUrl(body.spreadsheetId) : null,
  };
}

// ── spreadsheet.get ────────────────────────────────────────────────────
export async function spreadsheetGet(auth, input, signal) {
  const {
    spreadsheetId, includeGridData = false,
    timeoutMs = 20000,
  } = input || {};
  if (!spreadsheetId) throw new Error("operation=spreadsheet.get requires spreadsheetId");

  const qs = new URLSearchParams({ includeGridData: String(!!includeGridData) });
  const { status, body } = await sheetsFetch(
    auth,
    `/spreadsheets/${encodeURIComponent(spreadsheetId)}?${qs}`,
    { method: "GET" }, timeoutMs, signal,
  );
  return { status, result: body, url: spreadsheetUrl(spreadsheetId) };
}

// Operation → handler map. Single source of truth used by index.js.
export const OPERATIONS = {
  "sheet.get":            sheetGet,
  "sheet.append":         sheetAppend,
  "sheet.update":         sheetUpdate,
  "sheet.clear":          sheetClear,
  "sheet.delete-rows":    sheetDeleteRows,
  "spreadsheet.create":   spreadsheetCreate,
  "spreadsheet.get":      spreadsheetGet,
};
