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

// قراءة ملف الفهرس
const sectionsData = JSON.parse(fs.readFileSync('sections.json', 'utf8'));

// قراءة كل المصادر منفصلة (لتجميعها حسب المجموعة)
const sourceTexts = {};
for (const section of sectionsData.sections) {
  const content = fs.readFileSync(section.file, 'utf8');
  sourceTexts[section.id] = `\n\n========== ${section.title} ==========\n\n${content}`;
}

// تعريف المجموعات
const GROUPS = {
  basic_law: {
    name: 'الأساس القانوني',
    sources: ['law', 'regulation_165', 'regulation_appendix', 'decision_166'],
    description: 'القانون 24/1979، اللائحة 165، ملحق اللائحة، القرار 166 - يشمل: التأسيس، العضوية، مجلس الإدارة، الجمعية العمومية، الأسهم، رأس المال، الانتخابات، الأرباح، الحل والتصفية، النظام النموذجي'
  },
  employment: {
    name: 'العمل والموظفين',
    sources: ['decision_46', 'decision_12', 'manpower_responses'],
    description: 'القرار 46/ت 2021، القرار 12/ت 2015، الردود الرسمية - يشمل: الرواتب، الإجازات، نهاية الخدمة، البدلات، ساعات العمل، العقوبات التأديبية، توظيف المدير، المراقب الإداري والمالي، احتساب الأجر، الإجازة المرضية، الإجازة الدراسية، رسوم إذن العمل، بيع الإجازات، خفض الراتب، عقود المحاماة، خدمات اجتماعية للمستوصفات، وجبات الموظفين'
  },
  operations: {
    name: 'التشغيل والتجارة',
    sources: ['decision_347', 'decision_75'],
    description: 'القرار 347 لسنة 2025، القرار 75/أ 2019 - يشمل: المنتج الزراعي المحلي، منافذ التسويق والمزادات، ركن المزارع الكويتي، نسب الشراء، هوامش الربح، التوالف، المشاريع الصغيرة، شروط المبادرين، المحلات، القواطع، آلية الطرح والترسية، المهرجانات التسويقية'
  }
};

const conversationHistory = {};
const WHITELIST = ['96555667373'];

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const FREE_LIMIT = 2;
const DAILY_LIMIT = 10;

// كلمات التحية
const GREETINGS = [
  'السلام عليكم', 'سلام عليكم', 'السلام', 'مرحبا', 'مرحبتين', 'هلا', 'هلو',
  'هاي', 'اهلا', 'أهلا', 'صباح الخير', 'مساء الخير', 'صباح النور', 'مساء النور',
  'شكرا', 'شكراً', 'تسلم', 'يعطيك العافية', 'مشكور', 'ثانكس', 'تسلمين',
  'نعم', 'لا', 'اوك', 'أوك', 'تمام', 'زين', 'طيب', 'ماشي', 'اوكي', 'حياك',
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

// تصنيف السؤال باستخدام Haiku
async function classifyQuestion(text) {
  try {
    const classificationPrompt = `أنت مصنّف أسئلة. هدفك تحديد المجموعات المتعلقة بالسؤال من 3 مجموعات:

1. basic_law: ${GROUPS.basic_law.description}

2. employment: ${GROUPS.employment.description}

3. operations: ${GROUPS.operations.description}

السؤال: "${text}"

أرجع فقط أسماء المجموعات المتعلقة مفصولة بفاصلة، بدون أي شرح.
مثال 1: basic_law
مثال 2: employment
مثال 3: basic_law,employment

إذا السؤال غامض أو يخص أكثر من مجموعة، اختر مجموعتين كحد أقصى.`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: classificationPrompt }]
    });

    const result = response.content[0].text.trim().toLowerCase();
    const groups = result.split(',').map(g => g.trim()).filter(g => GROUPS[g]);
    
    // إذا التصنيف فشل، نرجع كل المجموعات (احتياط)
    if (groups.length === 0) {
      return Object.keys(GROUPS);
    }
    
    return groups;
  } catch (error) {
    console.error('Classification error:', error.message);
    // عند الخطأ، نرجع كل المجموعات (احتياط آمن)
    return Object.keys(GROUPS);
  }
}

// بناء نص المصادر بناءً على المجموعات المحددة
function buildSourcesText(groupIds) {
  const sourceIds = new Set();
  for (const groupId of groupIds) {
    if (GROUPS[groupId]) {
      GROUPS[groupId].sources.forEach(s => sourceIds.add(s));
    }
  }
  
  let text = '';
  for (const sourceId of sourceIds) {
    if (sourceTexts[sourceId]) {
      text += sourceTexts[sourceId];
    }
  }
  return text;
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

ملاحظة: في هذه المحادثة، تم تزويدك بالمصادر المتعلقة بسؤال المستخدم فقط. إذا السؤال يحتاج مصدر غير موجود معك، قل: "هذا السؤال يحتاج مصدر آخر، اسأله بصيغة أوضح من فضلك".

🚨 ممنوع منعاً باتاً استخدام رموز التنسيق:
❌ ممنوع # و ## و ### إطلاقاً
❌ ممنوع ** للتعريض
❌ ممنوع __ للتسطير
❌ ممنوع \` نهائياً
✅ استخدم النص العادي مع الإيموجي (📍 ✅ • 📊 💰 📅 ⏰ 🏥 📜) فقط

🚨 قاعدة حسابية حرجة:
✅ راتب اليوم = الراتب الشهري ÷ 26 (إلزامي)
✅ أجر الساعة = راتب اليوم ÷ 8

⚡ قاعدة عرض النتائج:
ممنوع عرض كل خطوات الحساب التفصيلية.
✅ اعرض البيانات + الأرقام الأساسية + النتيجة النهائية

🧮 الحاسبة الأولى: مكافأة نهاية الخدمة
المعادلة (المادة 51):
- أول 5 سنوات: 15 يوم/سنة
- بعد 5 سنوات: شهر كامل/سنة
- الحد الأقصى: 18 شهر

نسبة الاستحقاق:
- الاستقالة: <3 سنوات (0%)، 3-5 (50%)، 5-10 (66.67%)، 10+ (100%)
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
- <6 أشهر: 0 يوم
- 6-12 شهر: 15 يوم
- بعد سنة كاملة: 30 يوم سنوياً
الحساب: السنوات × 30 + (15 يوم إذا الأشهر ≥ 6)
بدل الإجازة = الأيام × (الراتب ÷ 26)

شكل العرض:
📅 حساب الإجازة
البيانات:
- [مدة الخدمة]
- [الراتب]
التفاصيل:
- راتب اليوم: [X] د.ك
- الرصيد المستحق: [X] يوم
📊 الرصيد: [X] يوم
💰 بدل الإجازة: [X] د.ك
📝 الأساس: قانون العمل 6/2010

⏰ الحاسبة الثالثة: الساعات الإضافية
🚨 لا تحسب مباشرة، اسأل أولاً عن نظام العطلة والراحة.
- يوم العطلة (الإعفاء): × 1.5 + يوم راحة بديل
- يوم الراحة: × 1.25
- يوم العمل العادي: × 1.25
- العطلة الرسمية: × 2 + يوم راحة بديل

عند طلب الحساب، اسأل:
"تأمر، متى يوم عطلتك ويوم راحتك؟
مثلاً: عطلتي الجمعة، راحتي السبت"
ثم انتظر الجواب، ثم احسب.

شكل العرض:
⏰ حساب الساعات الإضافية
البيانات: [الراتب] [الساعات] [اليوم] [نوع اليوم]
التفاصيل: [أجر الساعة] [معامل الزيادة] [أجر الساعة الإضافية]
💰 الإجمالي: [X] د.ك
✅ يستحق يوم راحة بديل (إذا كان مستحقاً)
📝 الأساس: المادة 66 و 67 من قانون العمل 6/2010

🏥 الحاسبة الرابعة: الإجازة المرضية
المادة 69:
- أول 15 يوم: 0% خصم
- 16-25: خصم 25%
- 26-35: خصم 50%
- 36-45: خصم 75%
- 46-75: خصم 100%

شكل العرض:
🏥 حساب الإجازة المرضية
البيانات: [الراتب] [أيام المرض]
📋 تفصيل الأيام:
✅ أول 15 يوم: بدون خصم
⚠️ [X] أيام (16-25): خصم 25% = [X] د.ك
⚠️ [X] أيام (26-35): خصم 50% = [X] د.ك
[وهكذا حسب الفترات اللي وصلها]
💰 إجمالي الخصم: [X] د.ك
📝 الأساس: المادة 69 من قانون العمل 6/2010

⚠️ ملاحظة عامة: الحسابات تقديرية، يُنصح بمراجعة جهة العمل.

📜 شكل الرد على الأسئلة القانونية:
📋 المواد والردود المتعلقة بـ [الموضوع]
📍 المادة (رقم) من [اسم المصدر الكامل]
النص الكامل: "نص المادة كاملاً"
(اترك سطر فارغ بين كل مادة)

إذا وجدت رد رسمي، اذكره:
📜 رد رسمي ذو صلة:
المصدر: [الجهة]
التاريخ: [التاريخ]
[خلاصة الرد]

🔚 نهاية الرد على الأسئلة القانونية: "تبي شرح للمواد؟ رد بـ نعم أو لا"
📖 إذا قال "نعم"، اشرح بأسلوب مبسط.

👤 الرد على "منو سواك":
مطورني: أ. ضاري عادل احمد - مستشار تعاوني
ممنوع ذكر Anthropic أو Claude.

⛔ ممنوعات:
- ممنوع ذكر أي قانون آخر غير المصادر التسعة وقانون 6/2010
- ممنوع قول "القانون التعاوني الكويتي"
- ممنوع الاختراع في الأسئلة القانونية

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

    // التحيات - رد محلي بدون احتساب
    if (isGreeting(text) && !WHITELIST.includes(from)) {
      await sendMessage(from, getGreetingReply(text));
      return;
    }

    // التحقق من صلاحية المستخدم
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

    // تصنيف السؤال بـ Haiku لتحديد المصادر المطلوبة
    const relevantGroups = await classifyQuestion(text);
    console.log(`Question classified to groups: ${relevantGroups.join(', ')}`);
    
    // بناء نص المصادر المتعلقة فقط
    const relevantSources = buildSourcesText(relevantGroups);

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
          text: `📚 النصوص القانونية المتاحة لك (المتعلقة بالسؤال):\n\n${relevantSources}`,
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
