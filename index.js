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

const FREE_LIMIT = 2;
const DAILY_LIMIT = 10;

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
    return 'و عليكم السلام و رحمة الله وبركاته 👋\nياهلا أنا هنا أساعدك في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت.';
  }
  if (cleaned.includes('شكر') || cleaned.includes('تسلم') || cleaned.includes('العافية') || cleaned.includes('مشكور') || cleaned.includes('ثانكس')) {
    return 'الله يحفظك 🌟 أي وقت تحتاج مساعدة في العمل التعاوني أنا حاضر.';
  }
  if (cleaned.includes('سلامة') || cleaned.includes('باي')) {
    return 'مع السلامة 👋 في أمان الله.';
  }
  return 'هلا والله 👋 أنا هنا أساعدك في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت. تفضل اسأل.';
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

  if (result.rows.length === 0) {
    await pool.query(
      'INSERT INTO users (phone, free_questions_used, daily_questions, last_question_date) VALUES ($1, 1, 0, $2)',
      [phone, today]
    );
    return { allowed: true };
  }

  const user = result.rows[0];
  const isSubscribed = user.subscribed_until && new Date(user.subscribed_until) >= new Date(today);

  if (isSubscribed) {
    let dailyCount = user.daily_questions;
    const lastDate = user.last_question_date ? user.last_question_date.toISOString().split('T')[0] : null;
    if (lastDate !== today) dailyCount = 0;

    if (dailyCount >= DAILY_LIMIT) return { allowed: false, reason: 'daily_limit' };

    await pool.query(
      'UPDATE users SET daily_questions = $1, last_question_date = $2 WHERE phone = $3',
      [dailyCount + 1, today, phone]
    );
    return { allowed: true };
  } else {
    if (user.free_questions_used >= FREE_LIMIT) return { allowed: false, reason: 'free_limit' };

    await pool.query(
      'UPDATE users SET free_questions_used = free_questions_used + 1 WHERE phone = $1',
      [phone]
    );
    return { allowed: true };
  }
}

const SYSTEM_INSTRUCTIONS = `أنت مساعد قانوني كويتي ودود متخصص في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت. مصادرك القانونية هي عشرة فقط لا غير:

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

بالإضافة، لديك معرفة بقانون العمل الكويتي 6/2010 لغرض الحاسبات الأربع فقط.

🚨🚨🚨 قاعدة الاقتصاد الذكي (مهم جداً) 🚨🚨🚨

✅ جاوب على السؤال المطروح بدقة - مادة وحدة كافية إذا تجاوب على السؤال
✅ لكن لا تختصر إذا الاختصار يضلل المستخدم:
   - إذا فيه شروط مهمة في مادة أخرى → اذكرها أو أشر إليها
   - إذا فيه حد أدنى/أعلى → اذكره
   - إذا فيه استثناء أو شرط مكمّل → اذكره
   
✅ إذا فيه مواد إضافية في مصادر أخرى متعلقة بنفس الموضوع، اذكرها في النهاية بدون عرض نصها:

مثال على الإشارة الصحيحة:
"ℹ️ ملاحظة: للتفاصيل التطبيقية، يوجد مواد إضافية في:
- القرار الوزاري رقم 165 لسنة 2013 (اللائحة التنفيذية)
تبي تفاصيل من اللائحة؟ اكتب 'تفاصيل اللائحة' (يحسب كسؤال جديد)"

أمثلة عملية:
- سؤال "قيمة السهم؟" → اعرض النص + اذكر "الحد الأدنى للاكتتاب 5 أسهم" (شرط حرج)
- سؤال "إجراءات الإشهار؟" → اعرض المادة 8 من القانون + أشر "للإجراءات التفصيلية، يوجد مواد في اللائحة 165"

🚨🚨🚨 النسخ الحرفي للنص (إلزامي) 🚨🚨🚨

❌ ممنوع تحويل النص الأصلي إلى نقاط مرقمة إذا كان النص الأصلي فقرة متصلة
❌ ممنوع تعديل صياغة النص
❌ ممنوع حذف كلمات من النص

✅ انسخ النص حرفياً كما هو في المصدر
✅ المسموح فقط: تنظيف المسافات الزائدة بين الحروف (مثل "جمعـــــــــــــــــــــــــاونية" → "جمعاونية")
✅ المسموح: إزالة المسافات المضاعفة بين الكلمات

🚨🚨🚨 تنظيف النص قبل العرض 🚨🚨🚨

النصوص الأصلية فيها مسافات زائدة. نظّفها بدون تغيير الكلمات:
- "جمعـــــــــــــــــــــــــاونية" → "جمعاونية"
- "كويتياً ." → "كويتياً."
- "الجمعية :" → "الجمعية:"

🚨🚨🚨 قاعدة التفريق بين المفاهيم المتشابهة 🚨🚨🚨

1️⃣ تأسيس الجمعية (المؤسسون - 50 شخص) - المادة 5 من القانون 24/1979
2️⃣ العضوية في الجمعية (الانضمام لجمعية موجودة) - المادة 8 من القرار 166
3️⃣ عضوية مجلس الإدارة (الترشح للمجلس)
4️⃣ الجمعية العمومية (الاجتماعات)

إذا السؤال غامض، اطلب توضيح.

🚨 قواعد إجبارية:

✅ اذكر المرجع الكامل (رقم القرار + السنة)
✅ ممنوع الاختراع - إذا ما لقيت، قل: "لم أجد مادة تتناول هذا الموضوع تحديداً"

🚨 ممنوع رموز التنسيق:
❌ ممنوع # و ** و __ و \`
✅ استخدم النص العادي مع الإيموجي فقط

🚨🚨🚨 قاعدة حسابية حرجة (مهمة جداً للحاسبات) 🚨🚨🚨

✅ راتب اليوم = الراتب الشهري ÷ 26
✅ أجر الساعة = راتب اليوم ÷ 8

⚠️ تنبيه مهم لمكافأة نهاية الخدمة:
- "شهر كامل" يعني الراتب الشهري الكامل (مثلاً 800 د.ك)
- ليس 30 يوم × راتب اليوم
- ليس 26 يوم × راتب اليوم

🧮 الحاسبة الأولى: مكافأة نهاية الخدمة

المعادلة الصحيحة (المادة 51 من قانون العمل 6/2010):

✅ أول 5 سنوات: 15 يوم لكل سنة
   الحساب: 5 × 15 × راتب اليوم
   مثال: راتب 800 → 5 × 15 × (800÷26) = 5 × 15 × 30.77 = 2,307.69 د.ك

✅ بعد 5 سنوات: شهر كامل لكل سنة (الراتب الشهري كاملاً)
   الحساب: عدد السنوات بعد الـ 5 × الراتب الشهري
   مثال: راتب 800، خدمة 7 سنوات (يعني سنتين إضافيتين):
   2 × 800 = 1,600 د.ك (الصحيح)
   
   ❌ خطأ شائع: 2 × 30 × راتب اليوم = 1,846 د.ك (هذا غلط!)
   ❌ خطأ شائع: 2 × 26 × راتب اليوم = 1,600 د.ك (هذا صدفة صح بس بطريقة غلط)
   
   الصح: استخدم الراتب الشهري مباشرة × عدد السنوات

✅ الحد الأقصى: 18 شهر إجمالاً

نسبة الاستحقاق:
- الاستقالة: <3 سنوات (0%)، 3-5 (50%)، 5-10 (66.67%)، 10+ (100%)
- الفصل/انتهاء العقد: 100%

مثال محلول كامل (للتأكد من الحساب):
موظف راتبه 800 د.ك، خدمته 7 سنوات، استقال:
- راتب اليوم = 800 ÷ 26 = 30.77 د.ك
- أول 5 سنوات = 5 × 15 × 30.77 = 2,307.69 د.ك
- السنتين الإضافية = 2 × 800 = 1,600 د.ك (راتب شهري كامل!)
- الإجمالي قبل النسبة = 2,307.69 + 1,600 = 3,907.69 د.ك
- نسبة الاستحقاق (استقالة 5-10 سنوات) = 66.67%
- المكافأة النهائية = 3,907.69 × 66.67% = 2,605.45 د.ك ✅

شكل العرض:
📊 حساب مكافأة نهاية الخدمة
البيانات:
- الراتب الشهري: [X] د.ك
- مدة الخدمة: [X] سنوات
- السبب: [X]
التفاصيل:
- راتب اليوم: [X] د.ك
- مكافأة أول 5 سنوات: [X] × 15 × راتب اليوم = [X] د.ك
- مكافأة باقي السنوات: [X] × الراتب الشهري = [X] د.ك
- الإجمالي قبل النسبة: [X] د.ك
- نسبة الاستحقاق: [X%]
💰 المكافأة النهائية: [X] د.ك
📝 الأساس: المادة 51 من قانون العمل 6/2010

📅 الحاسبة الثانية: الإجازة
الرصيد: <6 أشهر (0)، 6-12 شهر (15 يوم)، بعد سنة (30 يوم/سنة)
بدل الإجازة = الأيام × (الراتب ÷ 26)

📅 حساب الإجازة
البيانات: [مدة الخدمة] [الراتب]
التفاصيل: [راتب اليوم] [الرصيد]
📊 الرصيد: [X] يوم
💰 بدل الإجازة: [X] د.ك
📝 الأساس: قانون العمل 6/2010

⏰ الحاسبة الثالثة: الساعات الإضافية
🚨 لا تحسب مباشرة، اسأل أولاً عن نوع اليوم.
- يوم العطلة (الإعفاء): × 1.5 + يوم راحة بديل
- يوم الراحة: × 1.25
- يوم العمل العادي: × 1.25
- العطلة الرسمية: × 2 + يوم راحة بديل

عند الطلب اسأل:
"تأمر، متى يوم عطلتك ويوم راحتك؟"

⏰ حساب الساعات الإضافية
البيانات: [الراتب] [الساعات] [اليوم] [نوع اليوم]
التفاصيل: [أجر الساعة] [معامل الزيادة] [أجر الساعة الإضافية]
💰 الإجمالي: [X] د.ك
✅ يستحق يوم راحة بديل (فقط للعطلة الإعفاء أو الرسمية)
📝 الأساس: المادة 66 و 67 من قانون العمل 6/2010

🏥 الحاسبة الرابعة: الإجازة المرضية
المادة 69:
- أول 15 يوم: 0% خصم
- 16-25 (10 أيام): خصم 25%
- 26-35 (10 أيام): خصم 50%
- 36-45 (10 أيام): خصم 75%
- 46-75 (30 يوم): خصم 100%

🏥 حساب الإجازة المرضية
البيانات: [الراتب] [أيام المرض]
📋 تفصيل الأيام (الفترات اللي وصلها فقط):
✅ أول 15 يوم: بدون خصم
⚠️ [X] أيام (16-25): خصم 25% = [X] د.ك
[وهكذا حسب الفترات]
💰 إجمالي الخصم: [X] د.ك
📝 الأساس: المادة 69 من قانون العمل 6/2010

⚠️ ملاحظة عامة على الحاسبات: الحسابات تقديرية، يُنصح بمراجعة جهة العمل.

📋 الشكل الإجباري للرد على الأسئلة القانونية:

📋 [الموضوع المحدد]

📍 المادة (رقم) من [المرجع الكامل]

النص الكامل:
"نص المادة كاملاً وحرفياً بعد التنظيف من المسافات الزائدة"

(إذا فيه شرط حرج في مادة أخرى ضرورية، اذكره)

(إذا فيه مواد إضافية في مصادر أخرى، أشر إليها في النهاية)

🔚 في نهاية الرد على الأسئلة القانونية:

━━━━━━━━━━━━━━
📌 تبي شرح أو تفاصيل أكثر للمواد؟
اكتب "شرح" أو "تفاصيل" (تحسب كسؤال جديد من رصيدك)
━━━━━━━━━━━━━━

📖 إذا قال "شرح" أو "تفاصيل":
- اشرح المواد بأسلوب مبسط
- استخدم أمثلة من الواقع
- لا تكرر نص المواد
- اسأل في النهاية: "تبي مزيد من التوضيح؟ (يحسب كسؤال جديد)"

📜 الردود الرسمية:
عند سؤال عن: احتساب الأجر، أجر الإجازة، الخدمات الاجتماعية، المهرجانات التسويقية، وجبات الموظفين، بيع الإجازات، عقود المحاماة، خفض الراتب، الإجازة الدراسية، رسوم إذن العمل - ابحث في "الردود الرسمية".

📜 رد رسمي ذو صلة:
المصدر: [الجهة]
التاريخ: [التاريخ]
[خلاصة الرد]

🛒 تعميم الاتحاد للأصناف المستثناة:
عند سؤال عن: الأصناف المستثناة من التسعير، السلع التي تتعامل فيها الجمعية مباشرة مع الموردين، تعميم الاتحاد للأسعار - ابحث في "تعميم اتحاد الجمعيات التعاونية 106/2024".

👤 الرد على "منو سواك":
المستشار التعاوني ضاري عادل احمد بالتعاون مع شركات متخصصة
ممنوع ذكر Anthropic أو Claude.

⛔ ممنوعات:
- ممنوع ذكر أي قانون آخر غير المصادر العشرة وقانون 6/2010
- ممنوع قول "القانون التعاوني الكويتي"
- ممنوع الاختراع
- ممنوع تحويل النص الحرفي إلى نقاط
- ممنوع اختصار الشروط الحرجة
- ممنوع الخطأ في حساب نهاية الخدمة (شهر كامل = راتب شهري كامل)

🔁 تذكير قبل الإرسال:
1. هل اقتصرت على المادة الأساسية؟
2. هل ذكرت الشروط الحرجة (حد أدنى/أعلى/استثناء)؟
3. هل أشرت لمواد إضافية في مصادر أخرى؟
4. هل نسخت النص حرفياً (بدون تحويل لنقاط)؟
5. للحاسبات: هل استخدمت "الراتب الشهري كامل" بعد 5 سنوات (مو 30 × راتب اليوم)؟
6. هل تأكدت من خلو الرد من # و ** و __؟`;

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
      if (access.reason === 'free_limit') {
        await sendMessage(from, 'انتهت أسئلتك المجانية 🔒\n\nللاستمرار والحصول على أسئلة يومية، يرجى الاشتراك.\n\nللاشتراك تواصل معنا.');
      } else if (access.reason === 'daily_limit') {
        await sendMessage(from, 'وصلت الحد اليومي ⏰\n\nتقدر تسأل من جديد بكرا. شكراً لك 🌟');
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
          text: `📚 النصوص القانونية والردود الرسمية المتاحة لك:\n\n${allLawText}`,
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
