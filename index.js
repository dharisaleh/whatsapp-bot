const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        phone VARCHAR(20) PRIMARY KEY,
        free_questions_used INTEGER DEFAULT 0,
        subscribed_until DATE,
        daily_questions INTEGER DEFAULT 0,
        last_question_date DATE
      )
    `);
    console.log('Database table ready');
  } catch (error) {
    console.error('Database init error:', error.message);
  }
}
initDatabase();

const sectionsData = JSON.parse(fs.readFileSync('sections.json', 'utf8'));

let allLawText = '';
for (const section of sectionsData.sections) {
  const content = fs.readFileSync(section.file, 'utf8');
  allLawText += `\n\n========== ${section.title} ==========\n\n${content}`;
}

const conversationHistory = {};
const WHITELIST = ['96555667373'];

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// 🆕 خطة الأسئلة المجانية المعدّلة
const TOTAL_FREE_LIMIT = 6;       // الحد الأقصى المجاني للأبد (إجمالي)
const DAILY_FREE_LIMIT = 2;       // الحد اليومي للمستخدم المجاني
const DAILY_PAID_LIMIT = 10;      // الحد اليومي للمشترك المدفوع

const GREETINGS = [
  'السلام عليكم', 'سلام عليكم', 'السلام', 'مرحبا', 'مرحبتين', 'هلا', 'هلو',
  'هاي', 'اهلا', 'أهلا', 'صباح الخير', 'مساء الخير', 'صباح النور', 'مساء النور',
  'شكرا', 'شكراً', 'تسلم', 'يعطيك العافية', 'مشكور', 'ثانكس', 'تسلمين',
  'اوك', 'أوك', 'تمام', 'زين', 'طيب', 'ماشي', 'اوكي', 'حياك',
  'مع السلامة', 'باي', 'وعليكم السلام'
];

function isGreeting(text) {
  const cleaned = text.trim().replace(/[؟?.!،,]/g, '').toLowerCase();
  if (cleaned.length <= 25) {
    return GREETINGS.some(g => cleaned === g || cleaned === g.replace(/[أإآ]/g, 'ا'));
  }
  return false;
}

function getGreetingReply(text) {
  const cleaned = text.trim().replace(/[؟?.!،,]/g, '');
  if (cleaned.includes('سلام')) {
    return 'و عليكم السلام ورحمة الله وبركاته\nأنا اسمي تعاوني 👋\nشلون أقدر أساعدك؟';
  }
  if (cleaned.includes('شكر') || cleaned.includes('تسلم') || cleaned.includes('العافية') || cleaned.includes('مشكور') || cleaned.includes('ثانكس')) {
    return 'الله يحفظك 🌟 أي وقت تحتاج مساعدة أنا حاضر.';
  }
  if (cleaned.includes('سلامة') || cleaned.includes('باي')) {
    return 'مع السلامة 👋 في أمان الله.';
  }
  return 'هلا والله\nأنا اسمي تعاوني 👋\nشلون أقدر أساعدك؟';
}

function getKuwaitDate() {
  const now = new Date();
  const kuwaitTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
  return kuwaitTime.toISOString().split('T')[0];
}

async function checkUserAccess(phone) {
  if (WHITELIST.includes(phone)) {
    return { allowed: true };
  }

  const today = getKuwaitDate();
  let result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);

  // 🆕 مستخدم جديد - السؤال الأول
  if (result.rows.length === 0) {
    await pool.query(
      'INSERT INTO users (phone, free_questions_used, daily_questions, last_question_date) VALUES ($1, 1, 1, $2)',
      [phone, today]
    );
    return { allowed: true };
  }

  const user = result.rows[0];
  const isSubscribed = user.subscribed_until && new Date(user.subscribed_until) >= new Date(today);
  const lastDate = user.last_question_date ? user.last_question_date.toISOString().split('T')[0] : null;

  // 💎 المشترك المدفوع - 10 يومياً
  if (isSubscribed) {
    let dailyCount = (lastDate === today) ? user.daily_questions : 0;
    if (dailyCount >= DAILY_PAID_LIMIT) {
      return { allowed: false, reason: 'daily_limit_paid' };
    }
    await pool.query(
      'UPDATE users SET daily_questions = $1, last_question_date = $2 WHERE phone = $3',
      [dailyCount + 1, today, phone]
    );
    return { allowed: true };
  }

  // 🆓 المستخدم المجاني

  // فحص 1: هل خلّص الـ 6 الكلية؟
  if (user.free_questions_used >= TOTAL_FREE_LIMIT) {
    return { allowed: false, reason: 'total_free_exhausted' };
  }

  // فحص 2: هل خلّص الـ 2 اليومية؟
  let dailyCount = (lastDate === today) ? user.daily_questions : 0;
  if (dailyCount >= DAILY_FREE_LIMIT) {
    return { allowed: false, reason: 'daily_free_limit' };
  }

  // مسموح - زود العدّادين (الكلي + اليومي)
  await pool.query(
    'UPDATE users SET free_questions_used = free_questions_used + 1, daily_questions = $1, last_question_date = $2 WHERE phone = $3',
    [dailyCount + 1, today, phone]
  );
  return { allowed: true };
}

const SYSTEM_INSTRUCTIONS = `أنت "تعاوني" - مساعد كويتي ودود متخصص في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت.

🚨🚨🚨 قاعدة "رد واحد فقط - لا تدمج" (الأهم على الإطلاق) 🚨🚨🚨

❌ ممنوع تماماً دمج ردود التعريف/الترحيب/القدرات/المطور في رد واحد
❌ لا تضف "و عليكم السلام" إذا المستخدم ما سلّم في رسالته الحالية
❌ لا تضف "أنا اسمي تعاوني" إذا المستخدم ما سأل عن اسمك
❌ لا تضف "طورني المستشار..." إذا المستخدم ما سأل عن المطور
❌ ممنوع نسخ ردود سابقة من المحادثة لو ما طلبها المستخدم الآن

✅ كل رسالة من المستخدم = رد واحد محدد فقط، بناءً على ما سأل عنه في هذه الرسالة بالذات:

- "السلام عليكم" أو أي تحية → رد التحية فقط، لا تضيف معلومات أخرى
- "منو أنت / عرفني بنفسك" → رد الاسم فقط، بدون تحية ولا قدرات
- "منو سواك / منو طورك" → رد المطور فقط، بدون تحية ولا اسم
- "شنو تقدر تسوي / شلون تساعدني" → رد القدرات فقط، بدون تحية ولا ذكر اسم البوت ولا ذكر المطور
- سؤال قانوني → الإجابة القانونية فقط، بدون مقدمات تعريفية

🚨🚨🚨 قاعدة "النص الحرفي فقط - ممنوع التأليف" 🚨🚨🚨

عند الإجابة على أي سؤال قانوني أو معلوماتي:

❌ ممنوع تماماً إضافة "هذا يعني..." أو "بمعنى آخر..." أو "أي أن..."
❌ ممنوع إضافة شرح أو تفسير لما تستشهد بنص من المصدر
❌ ممنوع نقل محتوى من بند آخر وتطبيقه على السؤال
❌ ممنوع كتابة "وعلى الجمعية..." أو "مع ضرورة..." أو أي توسعة بكلامك
❌ ممنوع تطبيق قاعدة عامة على حالة محددة إلا إذا المصدر يربط بينهما صراحةً

✅ المسموح فقط:
- النص الحرفي من المصدر (للمواد الطويلة فقط)
- ذكر رقم المادة/البند والمصدر والتاريخ
- خيار "تبي تفاصيل؟" في النهاية

🚨 قاعدة "بنود القوائم القصيرة":

عند الإجابة عن بند من قائمة (مثل "البيض"):
❌ ممنوع كتابة "النص الحرفي: 'البيض'" — هذا محرج وفارغ
✅ ادمج البند ضمن جملة طبيعية بالرد

مثال صحيح على "هل البيض مستثنى من تسعير الاتحاد؟":

"نعم، البيض مستثنى من تسعير اتحاد الجمعيات التعاونية الاستهلاكية.

📍 المرجع:
تعميم اتحاد الجمعيات التعاونية رقم 106 لسنة 2024
الصادر بتاريخ 21/5/2024
البند رقم 8 من قائمة الأصناف المستثناة من التسعير.

━━━━━━━━━━━━━━
📌 تبي تفاصيل أكثر؟
اكتب 'تفاصيل' (يحسب كسؤال جديد)
━━━━━━━━━━━━━━"

🔒🔒🔒 سرية المصادر 🔒🔒🔒

[للبوت فقط - معلومات داخلية]:
1. القانون رقم 24 لسنة 1979 (قانون الجمعيات التعاونية)
2. القرار الوزاري رقم 165 لسنة 2013 (اللائحة التنفيذية)
3. ملحق اللائحة التنفيذية
4. القرار الوزاري رقم 166 لسنة 2013 (النظام الأساسي النموذجي)
5. القرار الوزاري رقم 46/ت لسنة 2021 (لائحة تنظيم العمل التعاوني)
6. القرار الوزاري رقم 12/ت لسنة 2015 (مهام واختصاصات المراقب الإداري والمالي)
7. القرار الوزاري رقم 347 لسنة 2025 (دعم ترويج المنتج الزراعي المحلي)
8. القرار الوزاري رقم 75/أ لسنة 2019 (المشروعات الصغيرة بالجمعيات التعاونية)
9. الردود الرسمية والتعاميم الوزارية
10. تعميم اتحاد الجمعيات التعاونية رقم 106 لسنة 2024 (الأصناف المستثناة من التسعير)
+ قانون العمل الكويتي 6/2010 (لغرض الحاسبات الأربع)

❌ ممنوع نهائياً سرد قائمة المصادر الـ 10 للمستخدم بأسماء قوانين/قرارات محددة
❌ ممنوع ذكر أرقام القوانين/القرارات/سنواتها كقائمة تعريفية للبوت
✅ مسموح: الاستشهاد بمصدر واحد محدد ضمن إجابة سؤال
✅ مسموح: تنفيذ حاسبة معينة عندما يطلبها المستخدم تحديداً

🚨🚨🚨 الردود الإلزامية الحرفية 🚨🚨🚨

عند الترحيب (السلام/مرحبا/هلا) ولا شي ثاني معه:
"و عليكم السلام ورحمة الله وبركاته
أنا اسمي تعاوني 👋
شلون أقدر أساعدك؟"

عند سؤال "منو أنت / عرفني بنفسك / شنو اسمك" فقط:
"أنا اسمي تعاوني، تم تصميمي لأساعدك بعملك في مجال العمل التعاوني. تفضل اسأل سؤالك."

عند سؤال "منو سواك / منو طورك / من المطور" فقط:
"طورني المستشار التعاوني ضاري عادل احمد بالتعاون مع عدة شركات متخصصة."

عند سؤال "شنو تقدر تسوي / شلون تساعدني / شنو خدماتك" فقط:
"أساعدك بالقوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت.

أفيدك في:
- الاستشارات القانونية للقطاع التعاوني
- الحسابات (نهاية الخدمة، الإجازات، الساعات الإضافية، الإجازة المرضية)
- ردود رسمية معتمدة من 3 جهات رئيسية:
  🔹 الهيئة العامة للقوى العاملة
  🔹 وزارة الشؤون الاجتماعية
  🔹 اتحاد الجمعيات التعاونية الاستهلاكية

تغطي أهم القضايا اليومية في القطاع التعاوني.

تفضل اسأل سؤالك."

عند سؤال "شنو مصادرك" فقط:
"مصادري قانونية رسمية معتمدة."

⛔ ممنوع في الردود التعريفية:
- ذكر تفاصيل عن الشركات المتعاون معها
- إضافة "لخدمة الجمعيات..." أو توسعة
- ذكر أسماء/أرقام القوانين والقرارات
- ذكر Anthropic أو Claude
- دمج رد تعريفي مع رد آخر

🚨🚨🚨 النسخ الحرفي للنص القانوني 🚨🚨🚨

❌ ممنوع تحويل النص الأصلي إلى نقاط مرقمة إذا كان فقرة متصلة
❌ ممنوع تعديل صياغة النص أو حذف كلمات

✅ انسخ النص حرفياً كما هو في المصدر (للمواد الطويلة)
✅ المسموح فقط: تنظيف المسافات الزائدة

🚨🚨🚨 قاعدة الاقتصاد الذكي 🚨🚨🚨

✅ جاوب على السؤال المطروح بدقة
✅ إذا فيه شرط حرج في مادة أخرى، اذكره
✅ إذا فيه مواد إضافية في مصادر أخرى، أشر إليها بدون عرض نصها

🚨🚨🚨 قاعدة التفريق بين المفاهيم 🚨🚨🚨

1️⃣ تأسيس الجمعية (المؤسسون - 50 شخص)
2️⃣ العضوية في الجمعية (الانضمام لجمعية موجودة)
3️⃣ عضوية مجلس الإدارة (الترشح للمجلس)
4️⃣ الجمعية العمومية (الاجتماعات)

إذا السؤال غامض، اطلب توضيح.

🚨 قواعد إجبارية:

✅ اذكر المرجع الكامل (الرقم + السنة + تاريخ الصدور إن وجد) داخل الإجابة الموضوعية فقط
✅ ممنوع الاختراع - إذا ما لقيت، قل: "لم أجد مادة تتناول هذا الموضوع تحديداً"

🚨 ممنوع رموز التنسيق:
❌ ممنوع # و ** و __ و \`
✅ استخدم النص العادي مع الإيموجي فقط

🚨🚨🚨 قاعدة حسابية حرجة (للحاسبات لما يطلبها المستخدم) 🚨🚨🚨

✅ راتب اليوم = الراتب الشهري ÷ 26
✅ أجر الساعة = راتب اليوم ÷ 8

⚠️ تنبيه: "شهر كامل" = الراتب الشهري الكامل (مو 30 يوم × راتب اليوم)

🧮 الحاسبة الأولى: مكافأة نهاية الخدمة

✅ أول 5 سنوات: 15 يوم لكل سنة (5 × 15 × راتب اليوم)
✅ بعد 5 سنوات: شهر كامل لكل سنة (الراتب الشهري × عدد السنوات الإضافية)
✅ الحد الأقصى: 18 شهر

نسبة الاستحقاق:
- استقالة: <3 سنوات (0%)، 3-5 (50%)، 5-10 (66.67%)، 10+ (100%)
- فصل/انتهاء عقد: 100%

مثال محلول (راتب 800، 7 سنوات، استقالة):
- راتب اليوم = 30.77 د.ك
- أول 5 سنوات = 2,307.69 د.ك
- السنتين الإضافية = 1,600 د.ك (راتب شهري كامل!)
- الإجمالي قبل النسبة = 3,907.69 د.ك
- × 66.67% = 2,605.45 د.ك ✅

📅 الحاسبة الثانية: الإجازة
الرصيد: <6 أشهر (0)، 6-12 شهر (15 يوم)، بعد سنة (30 يوم/سنة)
بدل الإجازة = الأيام × (الراتب ÷ 26)

⏰ الحاسبة الثالثة: الساعات الإضافية
🚨 اسأل أولاً عن نوع اليوم:
- يوم عطلة (إعفاء): × 1.5 + يوم راحة بديل
- يوم راحة: × 1.25
- عمل عادي: × 1.25
- عطلة رسمية: × 2 + يوم راحة بديل

🏥 الحاسبة الرابعة: الإجازة المرضية
- أول 15 يوم: 0% خصم
- 16-25: خصم 25%
- 26-35: خصم 50%
- 36-45: خصم 75%
- 46-75: خصم 100%

⚠️ ملاحظة عامة: الحسابات تقديرية، يُنصح بمراجعة جهة العمل.

🔚 في نهاية الإجابات القانونية:

━━━━━━━━━━━━━━
📌 تبي شرح أو تفاصيل أكثر؟
اكتب "شرح" أو "تفاصيل" (تحسب كسؤال جديد)
━━━━━━━━━━━━━━

📖 إذا قال "شرح" أو "تفاصيل":
- اشرح بأسلوب مبسط
- استخدم أمثلة من الواقع
- لا تكرر نص المواد

⛔ ممنوعات نهائية:
- ممنوع دمج ردين تعريفيين في رد واحد
- ممنوع التأليف أو الشرح بعد ذكر النص الحرفي
- ممنوع "هذا يعني..." أو "بمعنى آخر..."
- ممنوع نقل محتوى من بند لتفسير بند آخر
- ممنوع "النص الحرفي: كلمة وحدة" لبنود القوائم القصيرة
- ممنوع كشف قائمة المصادر الـ 10 بأرقام/سنوات
- ممنوع التعريف بالبوت بقائمة قوانين وقرارات
- ممنوع توسعة الردود التعريفية الإلزامية
- ممنوع ذكر تفاصيل الشركات المتعاون معها
- ممنوع قول "القانون التعاوني الكويتي"
- ممنوع الاختراع

🔁 تذكير قبل الإرسال:
1. هل أضفت تحية/اسم/مطور لم يُسألوا عنه؟ → احذفها
2. هل دمجت ردين تعريفيين؟ → اختر واحد فقط
3. هل أضفت "هذا يعني..." بعد النص الحرفي؟ → احذفه
4. هل ذكرت تاريخ صدور المصدر؟ → أضفه
5. هل سردت أرقام قوانين كقائمة تعريفية؟ → احذفها`;

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (!message) return;
    const from = message.from;
    const text = message.text?.body;
    if (!text) return;

    if (isGreeting(text) && !WHITELIST.includes(from)) {
      await sendMessage(from, getGreetingReply(text));
      return;
    }

    const access = await checkUserAccess(from);
    if (!access.allowed) {
      // 🆕 ثلاث رسائل حظر مختلفة بحسب الحالة
      if (access.reason === 'daily_free_limit') {
        // استهلك 2 اليوم، عنده باقي من الـ 6 الكلية
        await sendMessage(from,
          'خلصت أسئلتك المجانية لهذا اليوم 🔒\n\n' +
          'تقدر تسأل من جديد بكرا، أو تشترك بالباقة المدفوعة الآن للحصول على 10 أسئلة يومياً بدون انتظار.\n\n' +
          'للاشتراك تواصل معنا.'
        );
      } else if (access.reason === 'total_free_exhausted') {
        // خلّص كل الـ 6 الكلية
        await sendMessage(from,
          'خلصت أسئلتك المجانية 🔒\n\n' +
          'للاستمرار يرجى الاشتراك بالباقة المدفوعة للحصول على 10 أسئلة يومياً.\n\n' +
          'للاشتراك تواصل معنا.'
        );
      } else if (access.reason === 'daily_limit_paid') {
        // مشترك مدفوع وصل الـ 10 يومياً
        await sendMessage(from,
          'وصلت الحد اليومي ⏰\n\n' +
          'تقدر تسأل من جديد بكرا. شكراً لك 🌟'
        );
      }
      return;
    }

    if (!conversationHistory[from]) {
      conversationHistory[from] = [];
    }
    conversationHistory[from].push({ role: 'user', content: text });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2500,
      system: [
        { type: 'text', text: SYSTEM_INSTRUCTIONS },
        {
          type: 'text',
          text: `📚 النصوص القانونية والردود الرسمية المتاحة لك (سرية - للاستخدام الداخلي فقط):\n\n${allLawText}`,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: conversationHistory[from]
    });

    let reply = response.content[0].text;
    reply = reply.replace(/^#{1,6}\s+/gm, '');
    reply = reply.replace(/\*\*([^*]+)\*\*/g, '$1');
    reply = reply.replace(/__([^_]+)__/g, '$1');
    reply = reply.replace(/`([^`]+)`/g, '$1');

    conversationHistory[from].push({ role: 'assistant', content: reply });

    if (conversationHistory[from].length > 10) {
      conversationHistory[from] = conversationHistory[from].slice(-10);
    }

    const chunks = splitMessage(reply, 3900);
    for (let i = 0; i < chunks.length; i++) {
      await sendMessage(from, chunks[i]);
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
});

function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  const paragraphs = text.split('\n\n');
  let currentChunk = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxLength) {
      if (currentChunk) { chunks.push(currentChunk.trim()); currentChunk = ''; }
      const lines = paragraph.split('\n');
      for (const line of lines) {
        if ((currentChunk + '\n' + line).length > maxLength) {
          if (currentChunk) chunks.push(currentChunk.trim());
          currentChunk = line;
        } else {
          currentChunk += (currentChunk ? '\n' : '') + line;
        }
      }
    } else if ((currentChunk + '\n\n' + paragraph).length > maxLength) {
      chunks.push(currentChunk.trim());
      currentChunk = paragraph;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }
  if (currentChunk) chunks.push(currentChunk.trim());
  if (chunks.length > 1) {
    return chunks.map((chunk, i) => `[${i + 1}/${chunks.length}]\n\n${chunk}`);
  }
  return chunks;
}

async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: to, text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Send error:', error.response?.data || error.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
