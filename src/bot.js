import "dotenv/config";
import http from "node:http";
import { Bot, InlineKeyboard } from "grammy";
import { routeMessage, analyze, CATEGORIES } from "./ai.js";
import {
  ensureHeaders, appendExpenses, getRecent, getAll,
  deleteById, updateAmountById, setBudget, getBudgets,
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

await ensureHeaders();
console.log("Sheet headers OK");

bot.use(async (ctx, next) => {
  try { console.log("update:", JSON.stringify(ctx.message?.text || ctx.callbackQuery?.data || "?").slice(0, 80)); } catch {}
  await next();
});
bot.catch((err) => console.error("BOT ERROR:", err?.message || err));

// ---------- أوامر ----------

const START_TEXT =
  "أهلا! ابعت مصروفك بالعربي عادي، مثال:\nاشتريت بيض ورز ب 30 ودفعت 500 كهربا\n\nالأوامر:\n/يومي - صرفت كام النهاردة\n/شهري - ملخص الشهر\n/ميزانية [بند] [مبلغ] - مثال: /ميزانية أكل وشرب 3000\n/undo - تراجع عن آخر تسجيل\n/اسأل [سؤالك] - مثال: /اسأل شيل الفاكهة من حسبة الشهر؟";

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
  const budgets = await getBudgets();
  let msg = `ملخص ${mk}: الإجمالي ${s1.total} جنيه (الشهر اللي فات: ${s2.total})\nالأعلى:\n`;
  msg += s1.byCat.slice(0, 5).map(([c, v]) => `- ${c}: ${v}`).join("\n");
  if (budgets.length) {
    msg += `\n\nالميزانية:`;
    for (const b of budgets) {
      const spent = cur.filter(e => e.category === b.category).reduce((s, e) => s + e.amount, 0);
      const pct = b.monthly_limit ? Math.round(spent / b.monthly_limit * 100) : 0;
      msg += `\n- ${b.category}: ${spent}/${b.monthly_limit} (${pct}%)` + (pct >= 100 ? " تجاوزت الحد!" : pct >= 80 ? " قربت تخلص" : "");
    }
  }
  await ctx.reply(msg);
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
async function handleAsk(ctx, q) {
  if (!q) return ctx.reply("اكتب سؤالك بعد /اسأل");
  const all = await getAll(ctx.from.id);
  const budgets = await getBudgets();
  const ans = await analyze(q, all, budgets);
  pushHist(ctx.from.id, "user", q);
  pushHist(ctx.from.id, "assistant", ans);
  await ctx.reply(ans);
}

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
  return; // أمر غير معروف: تجاهل بصمت
}

// ---------- أي رسالة عادية -> Router ----------

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return handleSlashText(ctx, text); // عربي أو لاتيني
  const userId = ctx.from.id;
  try {
    const recent = await getRecent(userId, 5);
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
      const budgets = await getBudgets();
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
      await ctx.reply("حصلت مشكلة في الفهم، جرب تبعت بصيغة أبسط: مثلا (بيض 30 جنيه).");
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
  const budgets = await getBudgets();
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

// ---------- سيرفر صغير عشان الاستضافة المجانية (Render) ----------

const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("bot running");
}).listen(port, () => console.log(`healthcheck on ${port}`));

bot.start();
console.log("Bot started (polling).");
console.log("Categories:", CATEGORIES.join("، "));
