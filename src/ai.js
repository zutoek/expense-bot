import { GoogleGenerativeAI } from "@google/generative-ai";

const MODELS = [...new Set([
  process.env.GEMINI_MODEL || "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-flash-lite-latest",
].filter(Boolean))];
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

/** يجرب الموديلات بالترتيب: لو واحد حصته خلصت (429) ينقل على اللي بعده تلقائيا */
async function generate(prompt) {
  let lastErr = null;
  for (const m of MODELS) {
    let retriedNet = false;
    while (true) {
      try {
        const res = await genAI.getGenerativeModel({ model: m }).generateContent(prompt);
        return res;
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message);
        // عطل شبكة عابر: محاولة واحدة إضافية بعد ثانيتين لنفس الموديل
        const net = /EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|5\d\d|overloaded|fetch failed/i.test(msg + " " + (e?.code || ""));
        if (net && !retriedNet) {
          retriedNet = true;
          console.error(`model ${m} net glitch, retrying...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        const hop = e?.status === 429 || e?.status === 404 || /429|quota|Too Many Requests|not found|no longer available/i.test(msg);
        console.error(`model ${m} failed: ${msg.slice(0, 120)}`);
        if (!hop) throw e; // خطأ حقيقي (مفتاح غلط مثلا): ارميه فورا
        break;
      }
    }
  }
  throw lastErr;
}

export const CATEGORIES = [
  "أكل وشرب", "مواصلات", "فواتير", "سكن",
  "صحة", "تعليم", "ترفيه", "تسوق", "دخل", "أخرى"
];

function cleanJson(text) {
  // يشيل ```json ... ``` لو موجودة
  return String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/,\s*([}\]])/g, "$1") // فواصل زائدة قبل القفل
    .trim();
}

function parseJsonLoose(text, label) {
  const t = cleanJson(text);
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  console.error(`AI PARSE FAIL [${label}]:`, String(text).slice(0, 300));
  throw new Error("AI returned non-JSON");
}

function todayCairo() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" }); // YYYY-MM-DD
}

/**
 * المصنف الرئيسي: يفرق بين مصروف جديد / استفسار / تعديل-مسح / ميزانية
 * context = { history: [{role, text}], recent: [expenses] }
 */
export async function routeMessage(text, context = {}) {
  const { history = [], recent = [] } = context;
  const hist = history.slice(-6).map(h => `${h.role}: ${h.text}`).join("\n") || "لا يوجد";
  const rec = recent.slice(-5).map(r => `id=${r.id} | ${r.date} | ${r.amount} | ${r.category} | ${r.details}`).join("\n") || "لا يوجد";

  const prompt = `أنت مصنف نوايا لبوت مصاريف مصري. التاريخ اليوم ${todayCairo()} بتوقيت القاهرة.
التصنيفات المسموحة: ${CATEGORIES.join("، ")}.

المحادثة الأخيرة:
${hist}

آخر مصاريف مسجلة:
${rec}

رسالة المستخدم الجديدة: "${text}"

حدد intent واحد فقط:
- new_expense: المستخدم بيسجل مصروف أو دخل جديد (مثال: اشتريت بيض ب 30، دفعت 500 كهربا، قبضت 10000)
- query: سؤال عن المصاريف أو تقرير (مثال: صرفت كام النهاردة؟ فين راحت فلوسي؟ اعمل ملخص الشهر)
- edit_delete: تعديل أو مسح مصروف قديم (مثال: شيل الفاكهة من الحسبة، ضيف عليهم 20 عيش، خلي التفاح 60 بدل 50، امسح آخر حاجة)
- budget_set: تحديد ميزانية (مثال: ميزانية الأكل 3000، حط حد للمواصلات 500)
- other: أي كلام آخر (سلام، شكرا، هزار)

لو new_expense استخرج كل المصاريف (قد تكون أكثر من واحدة في نفس الرسالة) مع: amount (رقم فقط)، category (من القائمة)، details (وصف قصير)، date (YYYY-MM-DD، النهاردة = اليوم، امبارح = اليوم -1)، type (expense أو income).
لو edit_delete استخرج: action (delete أو update)، target (وصف الشيء: الفاكهة)، new_amount (لو update)، hint_ids (أرقام id المرشحة من القائمة الأخيرة لو واضحة وإلا []).
لو budget_set استخرج: category، monthly_limit (رقم).
لو query استخرج: question (نص السؤال)، period (today/month/last_month/all حسب السؤال).

رد بـ JSON فقط بدون أي شرح، مثال:
{"intent":"new_expense","items":[{"amount":30,"category":"أكل وشرب","details":"بيض ورز","date":"${todayCairo()}","type":"expense"}]}
{"intent":"query","question":"صرفت كام النهاردة؟","period":"today"}
{"intent":"edit_delete","action":"delete","target":"الفاكهة","new_amount":null,"hint_ids":[]}
{"intent":"budget_set","category":"أكل وشرب","monthly_limit":3000}
{"intent":"other","reply":"تحية عادية"}`;

  const res = await generate(prompt);
  const parsed = parseJsonLoose(res.response.text(), "route");
  if (!parsed.intent) parsed.intent = "other";
  return parsed;
}

/** تحليل حر: سؤال + داتا الشيت + الميزانيات -> إجابة عربية مختصرة */
export async function analyze(question, expenses, budgets = []) {
  const rows = expenses.slice(-200).map(e => `${e.date} | ${e.amount} | ${e.category} | ${e.details} | ${e.type || "expense"}`).join("\n");
  const b = budgets.map(x => `${x.category}: ${x.monthly_limit}`).join("، ") || "لا يوجد";
  const prompt = `أنت محاسب شخصي مصري ذكي. جاوب بالعربية المصرية المختصرة بالأرقام.
سؤال المستخدم: ${question}
الميزانيات: ${b}
المصاريف (date | amount | category | details | type):
${rows || "لا يوجد مصاريف"}

قواعد: اجمع بدقة، اذكر الإجمالي ثم التفصيل حسب البند، لو السؤال عن تعديل (شيل/ضيف) اقترح الرقم الجديد بعد الحذف أو الإضافة بدل ما تجاوب بس. بدون مقدمات طويلة.`;
  const res = await generate(prompt);
  return res.response.text().trim();
}

/** استخراج سريع بدون تصنيف (احتياطي لو Router وقع) */
export async function extractOnly(text) {
  const prompt = `استخرج المصاريف من هذه الرسالة المصرية: "${text}". اليوم ${todayCairo()}.
التصنيفات: ${CATEGORIES.join("، ")}.
رد JSON فقط: {"items":[{"amount":0,"category":"أخرى","details":"","date":"${todayCairo()}","type":"expense"}]}`;
  const res = await generate(prompt);
  return parseJsonLoose(res.response.text(), "extract");
}
