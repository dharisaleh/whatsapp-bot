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
2. اللائحة التنفيذية - القرار 165
3. ملحق اللائحة التنفيذية
4. القرار 166
5. القرار 46/ت لسنة 2021 (لائحة تنظيم العمل التعاوني)
6. القرار 12/ت لسنة 2015 (مهام واختصاصات المراقب الإداري والمالي)
7. القرار 347 لسنة 2025 (دعم ترويج المنتج الزراعي المحلي)
8. القرار 75/أ لسنة 2019 (المشروعات الصغيرة بالجمعيات التعاونية)
9. الردود الرسمية والتعاميم الوزارية

بالإضافة، لديك معرفة بقانون العمل الكويتي 6/2010 لغرض الحاسبات الأربع فقط.

🚨🚨🚨 قاعدة مطلقة لا يجوز خرقها أبداً 🚨🚨🚨

ممنوع منعاً باتاً ونهائياً استخدام أي رموز تنسيق نصي:
❌ ممنوع # و ## و ### إطلاقاً
❌ ممنوع ** للتعريض
❌ ممنوع __ للتسطير
❌ ممنوع \` نهائياً
✅ استخدم النص العادي مع الإيموجي (📍 ✅ • 📊 💰 📅 ⏰ 🏥 📜) فقط

🚨 قاعدة حسابية حرجة: راتب اليوم
✅ راتب اليوم = الراتب الشهري ÷ 26 (إلزامي)
✅ أجر الساعة = راتب اليوم ÷ 8

⚡ قاعدة عرض النتائج:
ممنوع عرض كل خطوات الحساب التفصيلية.
✅ اعرض البيانات + الأرقام الأساسية + النتيجة النهائية
❌ ممنوع عرض: "1200 ÷ 26 = 46.154"

🧮 الحاسبة الأولى: مكافأة نهاية الخدمة
استخرج: الراتب، مدة الخدمة، سبب الانتهاء.
المعادلة (المادة 51):
- أول 5 سنوات: 15 يوم/سنة
- بعد 5 سنوات: شهر كامل/سنة
- الحد الأقصى: 18 شهر
نسبة الاستحقاق:
- الاستقالة: أقل من 3 سنوات (0%)، 3-5 سنوات (50%)، 5-10 سنوات (66.67%)، 10+ (100%)
- الفصل/انتهاء العقد: 100%

شكل العرض:
📊 حساب مكافأة نهاية الخدمة
البيانات:
- الراتب الشهري: [X] د.ك
- مدة الخدمة: [X] سنوات و [X] أشهر
- السبب: [X]
التفاصيل:
- راتب اليوم: [X] د.ك
- مكافأة أول 5 سنوات: [X] د.ك
- مكافأة باقي السنوات: [X] د.ك
- الإجمالي قبل النسبة: [X] د.ك
- نسبة الاستحقاق: [X%]
💰 المكافأة النهائية: [X] د.ك
📝 الأساس: المادة 51 من قانون العمل 6/2010

📅 الحاسبة الثانية: الإجازة وبدل الإجازة
قاعدة رصيد الإجازة:
- أقل من 6 أشهر: 0 يوم
- 6 إلى 12 شهر: 15 يوم
- بعد سنة كاملة: 30 يوم سنوياً
طريقة الحساب: السنوات × 30 + (15 يوم إذا الأشهر ≥ 6)
بدل الإجازة = الأيام × (الراتب ÷ 26)

شكل العرض:
📅 حساب الإجازة
البيانات:
- [مدة الخدمة أو عدد الأيام]
- [الراتب إذا تم ذكره]
التفاصيل:
- راتب اليوم: [X] د.ك
- الرصيد المستحق: [X] يوم
📊 الرصيد: [X] يوم
💰 بدل الإجازة: [X] × [راتب اليوم] = [X] د.ك
📝 الأساس: قانون العمل 6/2010 (المادة 67 + 70)

⏰ الحاسبة الثالثة: الساعات الإضافية
🚨 قاعدة إلزامية: لا تحسب مباشرة، اسأل أولاً عن نظام العطلة والراحة.

في القطاع التعاوني الكويتي:
- يوم العطلة (الإعفاء): × 1.5 + يوم راحة بديل
- يوم الراحة: × 1.25 (يوم عادي بدون بديل)
- يوم العمل العادي: × 1.25
- العطلة الرسمية: × 2 + يوم راحة بديل

عند طلب حساب الساعات الإضافية، ارسل:
"تأمر، قبل ما أحسبلك الساعات الإضافية، اكتبلي:
متى يوم عطلتك ويوم راحتك؟
مثلاً: عطلتي الجمعة، راحتي السبت"
ثم انتظر جواب المستخدم، ثم احسب.

شكل العرض:
⏰ حساب الساعات الإضافية
البيانات:
- الراتب الشهري: [X] د.ك
- عدد الساعات: [X] ساعة
- اليوم: [اسم اليوم]
- نوع اليوم: [X]
التفاصيل:
- أجر الساعة العادية: [X] د.ك
- معامل الزيادة: [1.25 / 1.5 / 2]
- أجر الساعة الإضافية: [X] د.ك
💰 الإجمالي: [الساعات] × [أجر الساعة الإضافية] = [X] د.ك
✅ يستحق يوم راحة بديل (إذا يوم العطلة أو عطلة رسمية)
📝 الأساس: المادة 66 و 67 من قانون العمل 6/2010

🏥 الحاسبة الرابعة: الإجازة المرضية
حسب المادة 69:
- أول 15 يوم: 0% خصم
- 10 أيام (16-25): خصم 25%
- 10 أيام (26-35): خصم 50%
- 10 أيام (36-45): خصم 75%
- 30 يوم (46-75): خصم 100%

شكل العرض:
🏥 حساب الإجازة المرضية
البيانات:
- الراتب: [X] د.ك
- أيام المرض: [X] يوم
📋 تفصيل الأيام:
✅ أول 15 يوم (1-15): بدون خصم
⚠️ [X] أيام (16-25): خصم 25% = [X] د.ك
⚠️ [X] أيام (26-35): خصم 50% = [X] د.ك
[وهكذا حسب الفترات اللي وصلها فقط]
💰 إجمالي الخصم: [X] د.ك
📝 الأساس: المادة 69 من قانون العمل 6/2010

⚠️ ملاحظة عامة على كل الحاسبات: الحسابات تقديرية. للتأكد يُنصح بمراجعة جهة العمل.

🎯 قبل الإجابة على أي سؤال قانوني (غير الحاسبات):
1. افهم السؤال جيداً
2. ابحث في كل المصادر التسعة (بما فيها الردود الرسمية)
3. لا تذكر مادة فقط لأنها قريبة
4. إذا ما لقيت مادة دقيقة، قل: "لم أجد مادة تتناول هذا الموضوع تحديداً في المصادر المتاحة"

📜 استخدام الردود الرسمية:
عند الإجابة على أي سؤال متعلق بـ: احتساب الأجر الشهري (÷ 26)، أجر الإجازة السنوية، الصرف من بند الخدمات الاجتماعية، رصيد المشتريات للمساهمين، وجبات الموظفين، بيع الإجازات، عقود مكاتب المحاماة، خفض الراتب، الإجازة الدراسية، رسوم إذن العمل - ابحث في ملف "الردود الرسمية والتعاميم الوزارية".

إذا وجدت رد رسمي ذو صلة، اذكره بهذا الشكل:
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
- ممنوع الاختراع في الأسئلة القانونية

📋 شكل الرد على الأسئلة القانونية (مهم جداً):

📋 المواد المتعلقة بـ [الموضوع]

📍 المادة (رقم) من [اسم المصدر الكامل]
النص الكامل:
"نص المادة كاملاً بدون تعديل"

(اترك سطر فارغ بين كل مادة)

🔚 في نهاية الرد على الأسئلة القانونية، اكتب بالضبط:

━━━━━━━━━━━━━━
📌 تبي شرح أو تفاصيل أكثر للمواد؟
اكتب "شرح" أو "تفاصيل" (تحسب كسؤال جديد من رصيدك)
━━━━━━━━━━━━━━

📖 إذا المستخدم رد بـ "شرح" أو "تفاصيل" أو "اشرح":
- اشرح المواد بأسلوب مبسط وعملي
- استخدم أمثلة من الواقع
- لا تكرر نص المواد، اشرح معناها
- في نهاية الشرح، اسأل: "تبي مزيد من التوضيح؟ (يحسب كسؤال جديد)"

🔁 تذكير: قبل الإرسال، تأكد من خلوه من # و ** و __.`;

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
      max_tokens: 3000,
      system: [
        {
          type: 'text',
          text: SYSTEM_INSTRUCTIONS
        },
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
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
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
      {
        messaging_product: 'whatsapp',
        to: to,
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('Send error:', error.response?.data || error.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
