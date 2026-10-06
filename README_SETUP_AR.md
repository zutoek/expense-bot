# إعداد بوت المصاريف (كله مجاني)

## 1) توكن تليجرام (دقيقتين)
1. افتح تليجرام وابحث عن `BotFather`
2. ابعت `/newbot` واختار اسم ويوزرنيم
3. انسخ التوكن اللي شكله `123456:ABC...` -> ده `TELEGRAM_TOKEN`

## 2) مفتاح Gemini المجاني
1. ادخل على Google AI Studio
2. اعمل Create API Key مجاني
3. انسخه -> ده `GEMINI_API_KEY`
4. الموديل الافتراضي `gemini-1.5-flash` (مجاني بحد سخي)

## 3) جوجل شيت + حساب الخدمة
1. اعمل Google Sheet جديد وانسخ الـ ID من اللينك:
   `docs.google.com/spreadsheets/d/XXXX/edit` -> الـ XXXX هو `GOOGLE_SHEET_ID`
2. روح Google Cloud Console -> اعمل مشروع -> فعّل Google Sheets API
3. اعمل Service Account + Key بصيغة JSON وحمله
4. افتح ملف الـ JSON وخد الإيميل اللي جواه (شكله `xxx@xxx.iam.gserviceaccount.com`)
5. روح على الشيت واعمله Share مع الإيميل ده بصلاحية Editor
6. البوت هيعمل تبويبين لوحده أول تشغيل: `expenses` و `budgets`

## 4) التشغيل لوكال
```
cd expense_bot
cp .env.example .env
# املا .env
npm.cmd install
npm.cmd start
```
ملحوظة ويندوز: استخدم `npm.cmd` مش `npm` بسبب ExecutionPolicy.

طريقتين لملف الخدمة:
- الأسهل على السيرفر: حط محتوى ملف JSON كله في متغير `GOOGLE_SERVICE_ACCOUNT_JSON` سطر واحد
- لوكال: حط الملف جنب المشروع باسم `service-account.json` وظبط `GOOGLE_SERVICE_ACCOUNT_FILE`

## 5) الرفع على سيرفر مجاني دائم (Render Free)
1. ارفع فولدر `expense_bot` على GitHub
2. اعمل حساب Render مجاني -> New -> Blueprint واختار الريبو (ملف `render.yaml` جاهز)
3. دخل المتغيرات الأربعة في Environment:
   `TELEGRAM_TOKEN`, `GEMINI_API_KEY`, `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`
4. Deploy. البوت شغال polling + سيرفر healthcheck على `PORT`.

ملاحظة: الخطة المجانية بتنام بعد 15 دقيقة خمول وأول رسالة ممكن تتأخر ~50 ثانية وبعدين يصحى. لو عايزه 24/7 بدون نوم استخدم UptimeRobot يعمل ping للينك كل 5 دقايق (مجاني).

## 6) الاستخدام
- أي رسالة عادية = مصروف (مثال: `اشتريت بيض ورز ب 30 ودفعت 500 كهربا`)
- البوت يسألك للتأكيد قبل الحفظ
- `شيل الفاكهة من الحسبة` = مسح باختيار من المرشحين + تأكيد
- `/يومي` `/شهري` `/ميزانية أكل وشرب 3000` `/undo` `/اسأل صرفت كام على الأكل؟`
