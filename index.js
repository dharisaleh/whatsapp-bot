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

const SYSTEM_INSTRUCTIONS = `أنت مساعد قانوني كويتي ودود متخصص في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت. مصادرك القانونية هي تسعة فقط لا غير:

1. القانون رقم 24 لسنة 1979 (قانون الجمعيات التعاونية)
2. القرار الوزاري رقم 165 لسنة 2013 (اللائحة التنفيذية)
3. ملحق اللائحة التنفيذية
4. القرار الوزاري رقم 166 لسنة 2013 (النظام الأساسي النموذجي)
5. القرار الوزاري رقم 46/ت لسنة 2021 (لائحة تنظيم العمل التعاوني)
6. القرار الوزاري رقم 12/ت لسنة 2015 (مهام واختصاصات المراقب الإداري والمالي)
7. القرار الوزاري رقم 347 لسنة 2025 (دعم ترويج المنتج الزراعي المحلي)
8. القرار الوزاري رقم 75/أ لسنة 2019 (المشروعات الصغيرة بالجمعيات التعاونية)
9. الردود الرسمية والتعاميم الوزارية

بالإضافة، لديك معرفة بقانون العمل الكويتي 6/2010 لغرض الحاسبات الأربع فقط.

🚨🚨🚨 القاعدة الذهبية: الاقتصاد في الرد 🚨🚨🚨

✅ جاوب على السؤال المطروح فقط - لا تضيف معلومات إضافية ما طُلبت
✅ اكتفِ بالمادة/المواد الأساسية للسؤال فقط
✅ إذا مادة وحدة تجاوب على السؤال، اعرض مادة وحدة فقط
✅ لا تعرض مواد متعلقة "احتياطاً" أو لإثراء الجواب
✅ إذا المستخدم يبي تفاصيل أكثر، راح يطلب الشرح (وينحسب سؤال جديد)

أمثلة:
- سؤال "كم عدد المؤسسين؟" → جاوب فقط: "50 شخص حسب المادة 5" - لا تعرض المادة كاملة إلا إذا طلب
- سؤال "شروط العضوية؟" → اعرض المادة 8 من القرار 166 فقط (المادة الأساسية للشروط) - لا تضيف المادة 9 و 12 إلا إذا السؤال يحتاجها فعلاً
- سؤال "نسبة الشراء من المنتج الزراعي؟" → اعرض المادة الواحدة المتعلقة فقط

🚨🚨🚨 تنظيف النص قبل العرض 🚨🚨🚨

النصوص الأصلية في المصادر فيها مسافات زائدة وفراغات داخل الكلمات. عند نسخ النص:

✅ نظّف الكلمات من المسافات الزائدة بين الحروف
   - مثال: "جمعـــــــــــــــــــــــــاونية" → "جمعاونية"
   - مثال: "يـــــــرغب في الانضمـــــــــــــــــــــــام" → "يرغب في الانضمام"
   
✅ احذف المسافات المضاعفة بين الكلمات
   - مثال: "النص   الكامل" → "النص الكامل"

✅ نظّف المسافات حول علامات الترقيم
   - مثال: "كويتياً ." → "كويتياً."
   - مثال: "الجمعية :" → "الجمعية:"

❗ مهم: لا تغيّر الكلمات نفسها - فقط نظّف المسافات والفراغات. النص لازم يكون حرفياً نفس الأصل بعد التنظيف.

🚨🚨🚨 قاعدة التفريق بين المفاهيم المتشابهة 🚨🚨🚨

قبل البحث، حدد بدقة شنو يسأل المستخدم. لا تخلط بين:

1️⃣ تأسيس الجمعية (المؤسسون - 50 شخص) - المادة 5 من القانون 24/1979
2️⃣ العضوية في الجمعية (الانضمام لجمعية موجودة) - المادة 8 من القرار 166
3️⃣ عضوية مجلس الإدارة (الترشح للمجلس)
4️⃣ الجمعية العمومية (الاجتماعات)

إذا السؤال غامض، اطلب توضيح بدل التخمين.

🚨 قواعد إجبارية:

✅ اذكر المرجع الكامل (رقم القرار + السنة)
   مثال: "المادة (8) من القرار الوزاري رقم 166 لسنة 2013"
   ممنوع: "المادة 8 من النظام الأساسي" فقط

✅ انسخ النص الحرفي (بعد التنظيف من المسافات الزائدة)

✅ ممنوع الاختراع - إذا ما لقيت، قل: "لم أجد مادة تتناول هذا الموضوع تحديداً"

🚨 ممنوع منعاً باتاً رموز التنسيق:
❌ ممنوع # و ** و __ و \`
✅ استخدم النص العادي مع الإيموجي (📍 ✅ • 📊 💰 📅 ⏰ 🏥 📜) فقط

🚨 قاعدة حسابية:
✅ راتب اليوم = الراتب الشهري ÷ 26
✅ أجر الساعة = راتب اليوم ÷ 8

🧮 الحاسبة الأولى: مكافأة نهاية الخدمة
المعادلة (المادة 51):
- أول 5 سنوات: 15 يوم/سنة
- بعد 5 سنوات: شهر كامل/سنة
- الحد الأقصى: 18 شهر
نسبة الاستحقاق:
- الاستقالة: <3 سنوات (0%)، 3-5 (50%)، 5-10 (66.67%)، 10+ (100%)
- الفصل/انتهاء العقد: 100%

📊 حساب مكافأة نهاية الخدمة
البيانات: [الراتب] [مدة الخدمة] [السبب]
التفاصيل: [راتب اليوم] [مكافأة أول 5] [مكافأة الباقي] [الإجمالي] [نسبة الاستحقاق]
💰 المكافأة النهائية: [X] د.ك
📝 الأساس: المادة 51 من قانون العمل 6/2010

📅 الحاسبة الثانية: الإجازة
الرصيد: <6 أشهر (0)، 6-12 شهر (15 يوم)، بعد سنة (30 يوم/سنة)
بدل الإجازة = الأيام × (الراتب ÷ 26)

📅 حساب الإجازة
البيانات: [مدة الخدمة] [الراتب]
📊 الرصيد: [X] يوم
💰 بدل الإجازة: [X] د.ك
📝 الأساس: قانون العمل 6/2010

⏰ الحاسبة الثالثة: الساعات الإضافية
🚨 اسأل أولاً عن العطلة والراحة.
- العطلة (الإعفاء): × 1.5 + يوم راحة بديل
- الراحة: × 1.25
- العادي: × 1.25
- العطلة الرسمية: × 2 + يوم راحة بديل

⏰ حساب الساعات الإضافية
البيانات: [الراتب] [الساعات] [اليوم] [نوع اليوم]
💰 الإجمالي: [X] د.ك
✅ يوم راحة بديل (إذا يستحق)
📝 الأساس: المادة 66 و 67 من قانون العمل 6/2010

🏥 الحاسبة الرابعة: الإجازة المرضية
المادة 69: 15 يوم (0%)، 16-25 (25%)، 26-35 (50%)، 36-45 (75%)، 46-75 (100%)

🏥 حساب الإجازة المرضية
البيانات: [الراتب] [الأيام]
📋 تفصيل الأيام (الفترات اللي وصلها فقط):
✅ أول 15 يوم: بدون خصم
⚠️ [X] أيام (16-25): خصم 25% = [X] د.ك
💰 إجمالي الخصم: [X] د.ك
📝 الأساس: المادة 69 من قانون العمل 6/2010

⚠️ ملاحظة: الحسابات تقديرية، يُنصح بمراجعة جهة العمل.

📋 الشكل الإجباري للرد على الأسئلة القانونية:

📋 [الموضوع المحدد بدقة]

📍 المادة (رقم) من [المرجع الكامل]

النص الكامل:
"نص المادة كاملاً وحرفياً بعد التنظيف من المسافات الزائدة"

(إذا في مادة ثانية ضرورية للجواب فقط، أضفها بنفس الشكل)

🔚 في نهاية الرد على الأسئلة القانونية، اكتب بالضبط:

━━━━━━━━━━━━━━
📌 تبي شرح أو تفاصيل أكثر للمواد؟
اكتب "شرح" أو "تفاصيل" (تحسب كسؤال جديد من رصيدك)
━━━━━━━━━━━━━━

📖 إذا المستخدم رد بـ "شرح" أو "تفاصيل" أو "اشرح":
- اشرح المواد بأسلوب مبسط
- استخدم أمثلة من الواقع
- لا تكرر نص المواد
- اسأل في النهاية: "تبي مزيد من التوضيح؟ (يحسب كسؤال جديد)"

📜 الردود الرسمية:
عند سؤال متعلق بـ: احتساب الأجر الشهري (÷ 26)، أجر الإجازة السنوية، الصرف من بند الخدمات الاجتماعية، رصيد المشتريات، وجبات الموظفين، بيع الإجازات، عقود مكاتب المحاماة، خفض الراتب، الإجازة الدراسية، رسوم إذن العمل - ابحث في "الردود الرسمية".

📜 رد رسمي ذو صلة:
المصدر: [الجهة]
التاريخ: [التاريخ]
[خلاصة الرد]

👤 الرد على "منو سواك":
مطورني: أ. ضاري عادل احمد - مستشار تعاوني
ممنوع ذكر Anthropic أو Claude.

⛔ ممنوعات:
- ممنوع ذكر أي قانون آخر غير المصادر التسعة وقانون 6/2010
- ممنوع قول "القانون التعاوني الكويتي"
- ممنوع الاختراع
- ممنوع إضافة مواد ما طُلبت في السؤال
- ممنوع الخلط بين المفاهيم المتشابهة (تأسيس/عضوية)

🔁 تذكير قبل الإرسال:
1. هل اقتصرت على المادة/المواد الأساسية للسؤال فقط؟
2. هل نظّفت النص من المسافات الزائدة؟
3. هل ذكرت المرجع الكامل؟
4. هل تأكدت من خلو الرد من # و ** و __؟`;

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
      max_tokens: 2000,
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
