import { google } from "googleapis";
import fs from "node:fs";

const SHEET_ID = () => process.env.GOOGLE_SHEET_ID;
const EXPENSES_TAB = "expenses";
const BUDGETS_TAB = "budgets";

function getAuth() {
  const jsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let creds = null;
  if (jsonStr) {
    creds = JSON.parse(jsonStr);
  } else {
    const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "./service-account.json";
    creds = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function sheets() {
  const auth = getAuth();
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

function uid() {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

/** يتأكد أن أول صف عناوين موجود، ولو الشيت فاضي يكتبه */
export async function ensureHeaders() {
  const s = await sheets();
  const meta = await s.spreadsheets.get({ spreadsheetId: SHEET_ID() }).catch(() => null);
  const titles = meta?.data?.sheets?.map(x => x.properties.title) || [];

  if (!titles.includes(EXPENSES_TAB)) {
    await s.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: EXPENSES_TAB } } }] },
    });
  }
  if (!titles.includes(BUDGETS_TAB)) {
    await s.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: { requests: [{ addSheet: { properties: { title: BUDGETS_TAB } } }] },
    });
  }
  const exp = await s.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(), range: `${EXPENSES_TAB}!A1:H1`,
  }).catch(() => null);
  if (!exp?.data?.values?.length) {
    await s.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(), range: `${EXPENSES_TAB}!A1:H1`,
      valueInputOption: "RAW",
      requestBody: { values: [["id", "date", "user_id", "raw_text", "amount", "category", "details", "type"]] },
    });
  }
  const bud = await s.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(), range: `${BUDGETS_TAB}!A1:C1`,
  }).catch(() => null);
  if (!bud?.data?.values?.length) {
    await s.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(), range: `${BUDGETS_TAB}!A1:C1`,
      valueInputOption: "RAW",
      requestBody: { values: [["category", "monthly_limit", "updated_at"]] },
    });
  }
}

export async function appendExpenses(userId, rawText, items) {
  const s = await sheets();
  const rows = items.map(it => [
    uid(), it.date, String(userId), rawText,
    Number(it.amount), it.category, it.details || "", it.type || "expense",
  ]);
  await s.spreadsheets.values.append({
    spreadsheetId: SHEET_ID(), range: `${EXPENSES_TAB}!A:H`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
  return rows.map(r => ({ id: r[0], date: r[1], amount: r[4], category: r[5], details: r[6], type: r[7] }));
}

async function allRows() {
  const s = await sheets();
  const res = await s.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(), range: `${EXPENSES_TAB}!A2:H10000`,
  });
  const vals = res.data.values || [];
  return vals.map((r, i) => ({
    row: i + 2, id: r[0] || "", date: r[1] || "", user_id: r[2] || "",
    raw_text: r[3] || "", amount: Number(r[4] || 0), category: r[5] || "أخرى",
    details: r[6] || "", type: r[7] || "expense",
  }));
}

export async function getRecent(userId, n = 5) {
  const all = await allRows();
  return all.filter(r => !userId || String(r.user_id) === String(userId)).slice(-n);
}

export async function getAll(userId) {
  const all = await allRows();
  return all.filter(r => !userId || String(r.user_id) === String(userId));
}

export async function deleteById(id) {
  const all = await allRows();
  const found = all.find(r => String(r.id) === String(id));
  if (!found) return null;
  const s = await sheets();
  // نمسح الصف: نجيب الصف كامل ونفضيه (أأمن من deleteDimension مع الفلاتر)
  await s.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID(), range: `${EXPENSES_TAB}!A${found.row}:H${found.row}`,
  });
  return found;
}

export async function updateAmountById(id, newAmount) {
  const all = await allRows();
  const found = all.find(r => String(r.id) === String(id));
  if (!found) return null;
  const s = await sheets();
  await s.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(), range: `${EXPENSES_TAB}!E${found.row}`,
    valueInputOption: "RAW", requestBody: { values: [[Number(newAmount)]] },
  });
  found.amount = Number(newAmount);
  return found;
}

export async function setBudget(category, limit) {
  const s = await sheets();
  const res = await s.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(), range: `${BUDGETS_TAB}!A2:C100`,
  });
  const vals = res.data.values || [];
  const idx = vals.findIndex(r => (r[0] || "") === category);
  const today = new Date().toISOString().slice(0, 10);
  if (idx >= 0) {
    await s.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(), range: `${BUDGETS_TAB}!A${idx + 2}:C${idx + 2}`,
      valueInputOption: "RAW", requestBody: { values: [[category, Number(limit), today]] },
    });
  } else {
    await s.spreadsheets.values.append({
      spreadsheetId: SHEET_ID(), range: `${BUDGETS_TAB}!A:C`,
      valueInputOption: "RAW", requestBody: { values: [[category, Number(limit), today]] },
    });
  }
}

export async function getBudgets() {
  const s = await sheets();
  const res = await s.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(), range: `${BUDGETS_TAB}!A2:C100`,
  }).catch(() => ({ data: { values: [] } }));
  return (res.data.values || []).map(r => ({ category: r[0], monthly_limit: Number(r[1] || 0) }));
}
