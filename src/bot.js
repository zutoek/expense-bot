import "dotenv/config";
import http from "node:http";
import { Bot, InlineKeyboard } from "grammy";
import { routeMessage, analyze, CATEGORIES } from "./ai.js";
import { createDashHandler, loadDashFiles } from "./dash.js";
import {
  ensureHeaders, appendExpenses, getRecent, getAll,
  deleteById, updateAmountById, setBudget, getBudgets,
  addRecurring, getRecurring, setRecurringPosted, setRecurringActive,
  withRetry,
} from "./sheets.js";

if (!process.env.TELEGRAM_TOKEN) { console.error("ناقص TELEGRAM_TOKEN في .env"); process.exit(1); }
if (!process.env.GEMINI_API_KEY) { console.error("ناقص GEMINI_API_KEY في .env"); process.exit(1); }
if (!process.env.GOOGLE_SHEET_ID) { console.error("ناقص GOOGLE_SHEET_ID في .env"); process.exit(1); }

const bot = new Bot(process.env.TELEGRAM_TOKEN);
const pending = new Map(); // userId -> { kind, payload }
const history = new Map(); // userId -> [{role, text}] آخر 6 رسائل للسياق

function pushHist(userId, role, text) {
  const h = history.get(userId) || [];
  h.push({ role, text: String(text).slice(0, 300) });
  history.set(userId, h.slice(-6));
}

function fmtItem(e) {
  return `${e.amount} جنيه | ${e.category} | ${e.details} (${e.date})`;
}

function monthKey(d, offset = 0) {
  const dt = new Date(d + "T12:00:00");
  dt.setMonth(dt.getMonth() + offset);
  return dt.toISOString().slice(0, 7); // YYYY-MM
}

function summarize(list) {
  const total = list.reduce((s, e) => s + (e.type === "income" ? -e.amount : e.amount), 0);
  const byCat = {};
  for (const e of list) {
    if (e.type === "income") continue;
    byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  }
  const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  return { total, byCat: sorted };
}

// أكبر العمليات في بند معين (عشان الإجمالي لوحده بينسي)
function topItems(list, category, n = 2) {
  return list
    .filter(e => e.category === category && e.type !== "income")
    .sort((a, b) => b.amount - a.amount)
    .slice(0, n);
}
// كاش الميزانيات 5 دقايق (توفير قراءة شيت + سرعة)
const budgetCache = new Map(); // userId -> { data, ts }
async function getCachedBudgets(userId) {
  const c = budgetCache.get(userId);
  if (c && Date.now() - c.ts < 5 * 60 * 1000) return c.data;
  const data = await getBudgets();
  budgetCache.set(userId, { data, ts: Date.now() });
  return data;
}

function cairoToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

// تصنيف سريع للثوابت بالكلمات (من غير AI = أسرع ومجاني)
function quickCategory(text) {
  const t = String(text);
  if (/إيجار|شقة|سكن|بواب/.test(t)) return "سكن";
  if (/كهرب|ميا|مياه|غاز|نت|تليفون|فاتورة|موبايل|اشتراك نت/.test(t)) return "فواتير";
  if (/مواصلات|مترو|ميكروباص|أوبر|بنزين/.test(t)) return "مواصلات";
  if (/علاج|دوا|دكتور|صيدلية/.test(t)) return "صحة";
  if (/مدرسة|درس|جامعة|كورس/.test(t)) return "تعليم";
  return "أخرى";
}

// البورت أولا عشان الاستضافة تشوفنا حيين حتى لو جوجل واقع لحظيا
const port = Number(process.env.PORT || 3000);
http.createServer(async (req, res) => {
  try {
    if (await dashHandler(req, res)) return;
  } catch {}
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("bot running");
}).listen(port, () => console.log(`healthcheck on ${port}`));

try {
  await withRetry(ensureHeaders, 4);
  console.log("Sheet headers OK");
} catch (e) {
  console.error("headers failed, continuing without them:", e?.message);
}

bot.use(async (ctx, next) => {
  try { console.log("update:", JSON.stringify(ctx.message?.text || ctx.callbackQuery?.data || "?").slice(0, 80)); } catch {}
  await next();
});
bot.catch((err) => console.error("BOT ERROR:", err?.message || err));

// ---------- أوامر ----------

const START_TEXT =
  "أهلا! ابعت مصروفك بالعربي عادي، مثال:\nاشتريت بيض ورز ب 30 ودفعت 500 كهربا\n\nالأوامر:\n/يومي - صرفت كام النهاردة\n/شهري - ملخص الشهر\n/ميزانية [بند] [مبلغ] - مثال: /ميزانية أكل وشرب 3000\n/undo - تراجع عن آخر تسجيل\n/اسأل [سؤالك] - مثال: /اسأل شيل الفاكهة من حسبة الشهر؟\n/ثابت [وصف] [مبلغ] [يوم] - مثال: /ثابت إيجار 2000 1\n/ثوابت - قايمة الثوابت\n/رسم - رسم بياني للشهر\n/كشف - كل المعاملات بالتفصيل (ممكن: /كشف 9)\n/لوحة - لينك لوحة العرض";

async function dayReport(ctx) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
  const all = await getAll(ctx.from.id);
  const list = all.filter(e => e.date === today);
  if (!list.length) return ctx.reply(`مفيش مصاريف متسجلة النهاردة (${today}).`);
  const { total, byCat } = summarize(list);
  await ctx.reply(`مصروف النهاردة ${today}: ${total} جنيه\n` + byCat.map(([c, v]) => `- ${c}: ${v}`).join("\n"));
}

async function monthReport(ctx) {
  const all = await getAll(ctx.from.id);
  const mk = monthKey(new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" }));
  const prev = monthKey(new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" }), -1);
  const cur = all.filter(e => (e.date || "").startsWith(mk));
  const prv = all.filter(e => (e.date || "").startsWith(prev));
  if (!cur.length) return ctx.reply(`مفيش مصاريف في شهر ${mk}.`);
  const s1 = summarize(cur), s2 = summarize(prv);
  const budgets = await getCachedBudgets(ctx.from.id);
  let msg = `ملخص ${mk}: الإجمالي ${s1.total} جنيه (الشهر اللي فات: ${s2.total})\nالأعلى:\n`;
  msg += s1.byCat.slice(0, 5).map(([c, v]) => {
    const items = topItems(cur, c, 2).map(e => `   • ${e.details || "بدون وصف"}: ${e.amount} (${e.date.slice(5)})`).join("\n");
    return `- ${c}: ${v}` + (items ? `\n${items}` : "");
  }).join("\n");
  if (budgets.length) {
    msg += `\n\nالميزانية:`;
    for (const b of budgets) {
      const spent = cur.filter(e => e.category === b.category).reduce((s, e) => s + e.amount, 0);
      const pct = b.monthly_limit ? Math.round(spent / b.monthly_limit * 100) : 0;
      msg += `\n- ${b.category}: ${spent}/${b.monthly_limit} (${pct}%)` + (pct >= 100 ? " تجاوزت الحد!" : pct >= 80 ? " قربت تخلص" : "");
    }
  }
  await ctx.reply(msg);
  await sendChart(ctx, cur, mk); // صورة الرسم بعد الملخص
}

// رسم بياني دائري للشهر: صورة مجانية، وبديل نصي لو الخدمة وقعت
// رسم بياني دائري للشهر: ألوان فقط على الصورة (العربي يتكسر في Canvas)
// + شرح نصي بالألوان والمبالغ والنسب (تليجرام يعرض العربي صح)
const CHART_COLORS = ["#36A2EB", "#FF9F40", "#FF6384", "#4BC0C0", "#9966FF", "#FFCD56"];
const CHART_EMOJI = ["🟦", "🟧", "🟥", "🟩", "🟪", "🟨"];
async function sendChart(ctx, cur, mk) {
  const top = summarize(cur).byCat.slice(0, 6);
  if (!top.length) return;
  const total = top.reduce((s, [, v]) => s + v, 0) || 1;
  const legend = top.map(([c, v], i) => {
    const items = topItems(cur, c, 2).map(e => `\n   - ${e.details || "بدون وصف"}: ${e.amount}`).join("");
    return `${CHART_EMOJI[i % 6]} ${c}: ${v} جنيه (${Math.round((v / total) * 100)}%)${items}`;
  }).join("\n");
  try {
    const cfg = {
      type: "doughnut",
      data: {
        labels: top.map((_, i) => `part ${i + 1}`),
        datasets: [{ data: top.map(([, v]) => v), backgroundColor: CHART_COLORS }],
      },
      options: {
        plugins: {
          legend: { display: false },
          datalabels: { color: "#fff", anchor: "center", align: "center" },
        },
      },
    };
    const url = "https://quickchart.io/chart?c=" + encodeURIComponent(JSON.stringify(cfg)) + "&w=600&h=380&f=png";
    await ctx.replyWithPhoto(url, { caption: `مصاريف ${mk} (الإجمالي ${summarize(cur).total} جنيه):\n${legend}` });
  } catch {
    await ctx.reply(`مصاريف ${mk}:\n${legend}`);
  }
}

function cairoWeekStart() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = t => Number(parts.find(p => p.type === t).value);
  const d = new Date(Date.UTC(g("year"), g("month") - 1, g("day"), 12));
  const weekday = new Date(d).getUTCDay(); // 0=أحد..6=سبت
  d.setUTCDate(d.getUTCDate() - ((weekday + 1) % 7)); // بداية الأسبوع = السبت
  return d.toISOString().slice(0, 10);
}

// كشف تفصيلي: كل المعاملات بوصفها مرتبة حسب البند ثم التاريخ
async function handleStatement(ctx, arg) {
  await ctx.replyWithChatAction("typing").catch(() => {});
  const all = await getAll(ctx.from.id);
  let mk = cairoToday().slice(0, 7);
  const m = String(arg || "").match(/(\d{4})-(\d{1,2})/) || String(arg || "").match(/(?:شهر\s*)?(\d{1,2})/);
  if (m) {
    if (m[2]) mk = `${m[1]}-${String(m[2]).padStart(2, "0")}`;
    else mk = `${cairoToday().slice(0, 4)}-${String(m[1]).padStart(2, "0")}`;
  }
  const cur = all.filter(e => (e.date || "").startsWith(mk)).sort((a, b) => a.date < b.date ? -1 : 1);
  if (!cur.length) return ctx.reply(`مفيش معاملات في ${mk}.`);
  const cats = {};
  for (const e of cur) { (cats[e.category] = cats[e.category] || []).push(e); }
  let out = [`كشف ${mk} (${cur.length} معاملة):`];
  for (const [c, items] of Object.entries(cats)) {
    const sub = items.reduce((s, e) => s + (e.type === "income" ? -e.amount : e.amount), 0);
    out.push(`\n${c} = ${sub} جنيه`);
    for (const e of items) {
      const sign = e.type === "income" ? "دخل" : "مصروف";
      out.push(`  ${e.date.slice(5)} | ${e.details || "بدون وصف"} | ${e.amount} (${sign})`);
    }
  }
  const expenses = cur.filter(e => e.type !== "income").reduce((s, e) => s + e.amount, 0);
  const income = cur.filter(e => e.type === "income").reduce((s, e) => s + e.amount, 0);
  out.push(`\nإجمالي المصاريف: ${expenses} جنيه`);
  if (income) out.push(`إجمالي الدخل: ${income} جنيه`);
  out.push(`الصافي: ${expenses - income} جنيه`);
  // أسبوعي: من السبت لحد النهاردة (من كل الداتا مش الشهر بس)
  const ws = cairoWeekStart();
  const weekTotal = all.filter(e => e.type !== "income" && (e.date || "") >= ws).reduce((s, e) => s + e.amount, 0);
  out.push(`مصاريف الأسبوع ده (من السبت ${ws.slice(5)}): ${weekTotal} جنيه`);
  // متوسط يومي: عدد الأيام المنقضية لو الشهر الحالي، وإلا أيام الشهر كاملة
  const [yy, mm] = mk.split("-").map(Number);
  const isCur = mk === cairoToday().slice(0, 7);
  const days = isCur ? Number(cairoToday().slice(8, 10)) : new Date(yy, mm, 0).getDate();
  out.push(`المتوسط اليومي: ${Math.round(expenses / Math.max(days, 1))} جنيه/يوم`);
  // قسم الرسالة لو طويلة (حد تليجرام 4096 حرف)
  let chunk = "";
  for (const line of out) {
    if ((chunk + "\n" + line).length > 3500) { await ctx.reply(chunk); chunk = line; }
    else chunk += "\n" + line;
  }
  if (chunk.trim()) await ctx.reply(chunk);
}

async function handleChart(ctx) {  await ctx.replyWithChatAction("typing").catch(() => {});
  const all = await getAll(ctx.from.id);
  const mk = cairoToday().slice(0, 7);
  const cur = all.filter(e => (e.date || "").startsWith(mk));
  if (!cur.length) return ctx.reply(`مفيش مصاريف في شهر ${mk}.`);
  await sendChart(ctx, cur, mk);
}

// ---------- مصاريف ثابتة شهرية ----------

async function handleAddFixed(ctx) {
  // /ثابت إيجار 2000 1  (وصف + مبلغ + يوم 1-28)
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const day = Number(parts.pop());
  const amount = Number(parts.pop());
  const details = parts.join(" ").trim();
  if (!details || !amount || !day || day < 1 || day > 28) {
    return ctx.reply("الصيغة: /ثابت [وصف] [مبلغ] [يوم 1-28]\nمثال: /ثابت إيجار 2000 1");
  }
  const category = quickCategory(details);
  await addRecurring(ctx.from.id, { details, amount, category, day });
  await ctx.reply(`تمام، كل يوم ${day} في الشهر هسجل: ${amount} جنيه | ${category} | ${details}`);
}

async function handleListFixed(ctx) {
  const all = (await getRecurring()).filter(r => String(r.user_id) === String(ctx.from.id) && r.active);
  if (!all.length) return ctx.reply("مفيش مصاريف ثابتة. ضيف بـ: /ثابت إيجار 2000 1");
  await ctx.reply("الثوابت بتاعتك:\n" + all.map((r, i) => `${i + 1}. يوم ${r.day}: ${r.amount} جنيه | ${r.category} | ${r.details}`).join("\n") + "\n\nللحذف: /حذف_ثابت [الرقم]");
}

async function handleDelFixed(ctx) {
  const n = Number(ctx.message.text.split(/\s+/)[1]);
  const all = (await getRecurring()).filter(r => String(r.user_id) === String(ctx.from.id) && r.active);
  const target = all[n - 1];
  if (!target) return ctx.reply("رقم غلط. شوف القايمة بـ /ثوابت");
  await setRecurringActive(target.row, false);
  await ctx.reply(`وقفت: ${target.details} (${target.amount} جنيه يوم ${target.day})`);
}

// يشتغل مع بداية التشغيل + كل 6 ساعات: يسجل أي ثابت معاده جه ومينبه صاحبه
async function checkRecurring() {
  try {
    const today = cairoToday();
    const mk = today.slice(0, 7);
    const day = Number(today.slice(8, 10));
    const all = await getRecurring();
    for (const r of all) {
      if (!r.active || r.last_posted === mk || day < r.day) continue;
      await appendExpenses(r.user_id, `ثابت شهري: ${r.details}`, [
        { amount: r.amount, category: r.category, details: r.details + " (ثابت)", date: today, type: "expense" },
      ]);
      await setRecurringPosted(r.row, mk);
      await bot.api.sendMessage(r.user_id, `اتسجل الثابت الشهري: ${r.amount} جنيه | ${r.category} | ${r.details}`).catch(() => {});
      console.log(`recurring posted: ${r.details} for ${r.user_id}`);
    }
  } catch (e) {
    console.error("recurring check failed:", e?.message);
  }
}

async function handleBudget(ctx) {
  // /ميزانية أكل وشرب 3000
  const parts = ctx.message.text.split(/\s+/).slice(1);
  const limit = Number(parts.pop());
  const cat = parts.join(" ").trim();
  if (!cat || !limit) return ctx.reply("الصيغة: /ميزانية أكل وشرب 3000");
  await setBudget(cat, limit);
  await ctx.reply(`تمام، ميزانية ${cat} = ${limit} شهريا.`);
}
async function undoLast(ctx) {
  const rec = await getRecent(ctx.from.id, 1);
  if (!rec.length) return ctx.reply("مفيش حاجة تتمسح.");
  await deleteById(rec[0].id);
  await ctx.reply(`مسحت آخر حاجة: ${fmtItem(rec[0])}`);
}

async function handlePing(ctx) { await ctx.reply("شغال"); }
async function handleDashLink(ctx) {
  const secret = process.env.DASHBOARD_KEY || "";
  const base = (process.env.DASHBOARD_URL || "").replace(/\/+$/, "");
  if (!secret || !base) return ctx.reply("لوحة العرض مش متفعلة على السيرفر (ناقص DASHBOARD_KEY أو DASHBOARD_URL).");
  await ctx.reply(`لوحة العرض الخاصة بيك:\n${base}/dash?key=${secret}_${ctx.from.id}\n\nافتحها من متصفح الموبايل وثبتها: القائمة ⋮ ← Add to Home screen.\nاللينك خاص بيك، متبعتهوش لحد.`);
}
async function handleAsk(ctx, q) {
  if (!q) return ctx.reply("اكتب سؤالك بعد /اسأل");
  const all = await getAll(ctx.from.id);
  const budgets = await getCachedBudgets(ctx.from.id);
  const ans = await analyze(q, all, budgets);
  pushHist(ctx.from.id, "user", q);
  pushHist(ctx.from.id, "assistant", ans);
  await ctx.reply(ans);
}

// ---------- داشبورد العرض (PWA) ----------

async function apiSummary(userId) {
  const all = await getAll(userId);
  const today = cairoToday();
  const mk = today.slice(0, 7);
  const cur = all.filter(e => (e.date || "").startsWith(mk));
  const monthExp = cur.filter(e => e.type !== "income").reduce((s, e) => s + e.amount, 0);
  const monthIncome = cur.filter(e => e.type === "income").reduce((s, e) => s + e.amount, 0);
  const ws = cairoWeekStart();
  const weekTotal = all.filter(e => e.type !== "income" && (e.date || "") >= ws).reduce((s, e) => s + e.amount, 0);
  const days = Number(today.slice(8, 10));
  const budgets = await getCachedBudgets(userId).catch(() => []);
  return {
    today, mk,
    monthExp, monthIncome, weekTotal,
    dailyAvg: Math.round(monthExp / Math.max(days, 1)),
    top: summarize(cur).byCat.slice(0, 6).map(([c, v]) => ({ c, v })),
    budgets: budgets.map(b => {
      const spent = cur.filter(e => e.category === b.category).reduce((s, e) => s + e.amount, 0);
      return { c: b.category, limit: b.monthly_limit, spent, pct: b.monthly_limit ? Math.round((spent / b.monthly_limit) * 100) : 0 };
    }),
  };
}

async function apiStatement(userId, month) {
  const all = await getAll(userId);
  let mk = cairoToday().slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(month || "")) mk = month;
  const rows = all
    .filter(e => (e.date || "").startsWith(mk))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, 500)
    .map(e => ({ date: e.date, details: e.details, amount: e.amount, category: e.category, type: e.type || "expense" }));
  return { mk, count: rows.length, rows };
}

const dashHandler = createDashHandler({
  secret: process.env.DASHBOARD_KEY || "",
  apiSummary, apiStatement,
  files: loadDashFiles(),
});

// تليجرام مبيعترفش بالأوامر العربي كـ commands، فبنستقبلها هنا كنص عادي
async function handleSlashText(ctx, text) {
  const cmd = text.slice(1).split(/\s+/)[0].split("@")[0];
  const arg = text.slice(cmd.length + 2);
  if (["يومي", "يومى", "daily"].includes(cmd)) return dayReport(ctx);
  if (["شهري", "شهرى", "monthly"].includes(cmd)) return monthReport(ctx);
  if (["ميزانية", "ميزانيه"].includes(cmd)) return handleBudget(ctx);
  if (["اسأل", "اسال"].includes(cmd)) return handleAsk(ctx, arg.trim());
  if (["undo", "تراجع"].includes(cmd)) return undoLast(ctx);
  if (["ping"].includes(cmd)) return handlePing(ctx);
  if (["start"].includes(cmd)) return ctx.reply(START_TEXT);
  if (["ثابت", "ثابته"].includes(cmd)) return handleAddFixed(ctx);
  if (["ثوابت", "ثوابتك", "الثوابت"].includes(cmd)) return handleListFixed(ctx);
  if (["حذف_ثابت", "حذف-ثابت", "مسح_ثابت"].includes(cmd)) return handleDelFixed(ctx);
  if (["رسم", "رسم_بياني", "chart"].includes(cmd)) return handleChart(ctx);
  if (["كشف", "كشف_حساب", "كشف-حساب", "statement"].includes(cmd)) return handleStatement(ctx, arg.trim());
  if (["لوحة", "لوحه", "داشبورد", "dashboard"].includes(cmd)) return handleDashLink(ctx);
  return; // أمر غير معروف: تجاهل بصمت
}

// ---------- أي رسالة عادية -> Router ----------

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return handleSlashText(ctx, text); // عربي أو لاتيني
  const userId = ctx.from.id;
  ctx.replyWithChatAction("typing").catch(() => {}); // مؤشر فوري: البوت شغال
  try {
    const recent = await getRecent(userId, 5).catch(() => []); // لو الشيت واقع لحظيا كمل من غير سياق
    const hist = history.get(userId) || [];
    const r = await routeMessage(text, { history: hist, recent });
    pushHist(userId, "user", text);

    if (r.intent === "new_expense" && r.items?.length) {
      pending.set(userId, { kind: "save", items: r.items, raw: text });
      const lines = r.items.map((it, i) => `${i + 1}. ${it.amount} جنيه | ${it.category} | ${it.details || ""}`).join("\n");
      const kb = new InlineKeyboard().text("حفظ", "yes").text("إلغاء", "no");
      const reply = await ctx.reply(`فهمت كده:\n${lines}\nأحفظ؟`, { reply_markup: kb });
      pushHist(userId, "assistant", `اقترح حفظ: ${lines}`);
      pending.get(userId).msgId = reply.message_id;
      return;
    }

    if (r.intent === "budget_set" && r.category && r.monthly_limit) {
      pending.set(userId, { kind: "budget", category: r.category, limit: r.monthly_limit });
      const kb = new InlineKeyboard().text("أيوه", "yes").text("إلغاء", "no");
      await ctx.reply(`أحط ميزانية ${r.category} = ${r.monthly_limit} شهريا؟`, { reply_markup: kb });
      return;
    }

    if (r.intent === "edit_delete") {
      // نلاقي المرشحين من آخر 20 عملية بالاسم
      const all = await getRecent(userId, 20);
      const target = (r.target || "").trim();
      const cands = all.filter(e =>
        target && (e.details.includes(target) || target.includes(e.details) || e.category.includes(target))
      ).slice(-3);
      const pool = cands.length ? cands : all.slice(-3);
      if (!pool.length) return ctx.reply("مش لاقي عملية مناسبة للتعديل. ابعت تفاصيل أكتر.");
      pending.set(userId, { kind: "edit", action: r.action || "delete", target, newAmount: r.new_amount, cands: pool });
      const lines = pool.map((e, i) => `${i + 1}. ${fmtItem(e)}`).join("\n");
      const kb = new InlineKeyboard();
      pool.forEach((e, i) => kb.text(`${i + 1}`, `pick:${i}`).row());
      kb.text("إلغاء", "no");
      await ctx.reply(
        `${r.action === "update" ? `عايز تعدل ${target} لـ ${r.new_amount}؟` : `عايز تمسح ${target || "آخر عملية"}؟`}\nالمرشحين:\n${lines}\nاختار الرقم:`,
        { reply_markup: kb }
      );
      return;
    }

    if (r.intent === "query") {
      const all = await getAll(userId);
      const budgets = await getCachedBudgets(userId);
      const ans = await analyze(r.question || text, all, budgets);
      pushHist(userId, "assistant", ans);
      await ctx.reply(ans);
      return;
    }

    // other أو ثقة منخفضة: اسأل بدل ما يخمن
    const kb = new InlineKeyboard().text("ده مصروف", "ismoney").text("ده سؤال", "isquery").text("إلغاء", "no");
    pending.set(userId, { kind: "clarify", raw: text });
    await ctx.reply("معلش، دي مصروف جديد ولا سؤال عن المصاريف؟", { reply_markup: kb });
  } catch (e) {
    console.error(e);
    const quota = /429|quota|Too Many Requests/i.test(String(e?.message));
    if (quota) {
      await ctx.reply("الحصة المجانية للـ AI خلصت النهاردة (20 طلب لكل موديل). استنى شوية وجرب تاني، وقلل التجارب المتكررة.");
    } else {
      await ctx.reply("حصلت مشكلة مؤقتة في الاتصال، ابعت رسالتك تاني بعد ثواني.");
    }
  }
});

// ---------- أزرار التأكيد ----------

bot.callbackQuery("yes", async (ctx) => {
  const userId = ctx.from.id;
  const p = pending.get(userId);
  if (!p) return ctx.answerCallbackQuery("مفيش عملية معلقة.");
  if (p.kind === "save") {
    const saved = await appendExpenses(userId, p.raw, p.items);
    pending.delete(userId);
    pushHist(userId, "assistant", `اتحفظ: ${saved.map(fmtItem).join("، ")}`);
    await ctx.editMessageText(`اتحفظ: \n${saved.map(fmtItem).join("\n")}`);
  } else if (p.kind === "budget") {
    await setBudget(p.category, p.limit);
    pending.delete(userId);
    await ctx.editMessageText(`تمام، ميزانية ${p.category} = ${p.limit}.`);
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("no", async (ctx) => {
  pending.delete(ctx.from.id);
  await ctx.editMessageText("اتلغى.");
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("ismoney", async (ctx) => {
  const p = pending.get(ctx.from.id);
  if (!p) return ctx.answerCallbackQuery();
  const { extractOnly } = await import("./ai.js");
  const out = await extractOnly(p.raw);
  pending.set(ctx.from.id, { kind: "save", items: out.items, raw: p.raw });
  const lines = out.items.map((it, i) => `${i + 1}. ${it.amount} جنيه | ${it.category} | ${it.details || ""}`).join("\n");
  const kb = new InlineKeyboard().text("حفظ", "yes").text("إلغاء", "no");
  await ctx.editMessageText(`فهمت كده:\n${lines}\nأحفظ؟`, { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("isquery", async (ctx) => {
  const p = pending.get(ctx.from.id);
  if (!p) return ctx.answerCallbackQuery();
  const all = await getAll(ctx.from.id);
  const budgets = await getCachedBudgets(ctx.from.id);
  const ans = await analyze(p.raw, all, budgets);
  pending.delete(ctx.from.id);
  await ctx.editMessageText(ans);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^pick:/, async (ctx) => {
  const idx = Number(ctx.callbackQuery.data.split(":")[1]);
  const userId = ctx.from.id;
  const p = pending.get(userId);
  if (!p || p.kind !== "edit") return ctx.answerCallbackQuery();
  const chosen = p.cands[idx];
  if (!chosen) return ctx.answerCallbackQuery("اختيار غلط.");
  if (p.action === "update" && p.newAmount) {
    await updateAmountById(chosen.id, p.newAmount);
    pending.delete(userId);
    await ctx.editMessageText(`عدلت ${chosen.details} من ${chosen.amount} لـ ${p.newAmount}.`);
  } else {
    await deleteById(chosen.id);
    pending.delete(userId);
    await ctx.editMessageText(`مسحت: ${fmtItem(chosen)}`);
  }
  await ctx.answerCallbackQuery();
});

bot.start();
console.log("Bot started (polling).");
console.log("Categories:", CATEGORIES.join("، "));

// الثوابت الشهرية: فحص بعد 30 ثانية من التشغيل ثم كل 6 ساعات
setTimeout(checkRecurring, 30 * 1000);
setInterval(checkRecurring, 6 * 3600 * 1000);
