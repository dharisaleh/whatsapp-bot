const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// الاتصال بقاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// إنشاء جدول المستخدمين تلقائياً عند بدء التشغيل
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

// قراءة كل الأقسام ودمجها في نص واحد
let allLawText = '';
for (const section of sectionsData.sections) {
  const content = fs.readFileSync(section.file, 'utf8');
  allLawText += `\n\n========== ${section.title} ==========\n\n${content}`;
}

// تخزين سجل المحادثات لكل مستخدم (في الذاكرة - مؤقت)
const conversationHistory = {};
const WHITELIST = ['96555667373'];

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const FREE_LIMIT = 2;
const DAILY_LIMIT = 10;

// الحصول على التاريخ الحالي بتوقيت الكويت (YYYY-MM-DD)
function getKuwaitDate() {
  const now = new Date();
  const kuwaitTime = new Date(now.getTime() + (3 * 60 * 60 * 1000)); // UTC+3
  return kuwaitTime.toISOString().split('T')[0];
}

// التحقق من حالة المستخدم وصلاحية إرسال سؤال
async function checkUserAccess(phone) {
  // الرقم في القائمة البيضاء - بلا حدود
  if (WHITELIST.includes(phone)) {
    return { allowed: true };
  }

  const today = getKuwaitDate();

  // جلب بيانات المستخدم
  let result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);

  // مستخدم جديد - نسجله
  if (result.rows.length === 0) {
    await pool.query(
      'INSERT INTO users (phone, free_questions_used, daily_questions, last_question_date) VALUES ($1, 1, 0, $2)',
      [phone, today]
    );
    return { allowed: true };
  }

  const user = result.rows[0];

  // التحقق من الاشتراك
  const isSubscribed = user.subscribed_until && new Date(user.subscribed_until) >= new Date(today);

  if (isSubscribed) {
    // مشترك - نتحقق من الحد اليومي
    let dailyCount = user.daily_questions;
    const lastDate = user.last_question_date ? user.last_question_date.toISOString().split('T')[0] : null;

    // يوم جديد - نصفّر العداد اليومي
    if (lastDate !== today) {
      dailyCount = 0;
    }

    if (dailyCount >= DAILY_LIMIT) {
      return { allowed: false, reason: 'daily_limit' };
    }

    // نزيد العداد اليومي
    await pool.query(
      'UPDATE users SET daily_questions = $1, last_question_date = $2 WHERE phone = $3',
      [dailyCount + 1, today, phone]
    );
    return { allowed: true };
  } else {
    // غير مشترك - نتحقق من الأسئلة المجانية
    if (user.free_questions_used >= FREE_LIMIT) {
      return { allowed: false, reason: 'free_limit' };
    }

    // نزيد عداد الأسئلة المجانية
    await pool.query(
      'UPDATE users SET free_questions_used = free_questions_used + 1 WHERE phone = $1',
      [phone]
    );
    return { allowed: true };
  }
}

// التعليمات الثابتة
const SYSTEM_INSTRUCTIONS = `أنت مساعد قانوني كويتي ودود متخصص في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت. مصادرك القانونية هي تسعة فقط لا غير:

1. القانون رقم 24 لسنة 1979 (قانون الجمعيات التعاونية)
2. اللائحة التنفيذية - القرار 165
3. ملحق اللائحة التنفيذية
4. القرار 166
5. القرار 46/ت لسنة 2021 (لائحة تنظيم العمل التعاوني)
6. القرار 12/ت لسنة 2015 (مهام واختصاصات المراقب الإداري والمالي)
7. القرار 347 لسنة 2025 (دعم ترويج المنتج الزراعي المحلي)
8. القرار 75/أ لسنة 2019 (المشروعات الصغيرة بالجمعيات التعاونية)
9. الردود الرسمية والتعاميم الوزارية (من الهيئة العامة للقوى العاملة ووزارة الشؤون الاجتماعية واتحاد الجمعيات التعاونية)

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

قاعدة رصيد الإجازة (سياسة خاصة):
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

مثلاً:
- عطلتي الجمعة، راحتي السبت
- عطلتي الاثنين، راحتي الثلاثاء
- عطلتي الجمعة، راحتي الجمعة (نفس اليوم)

📌 ملاحظة:
- يوم العطلة (الإعفاء): يحسب بزيادة 50% + يوم راحة بديل
- يوم الراحة: يحسب يوم عمل عادي بزيادة 25% بدون بديل"

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

إذا فهمت أن المستخدم يطلب حساب الإجازة المرضية:

📌 الخطوة 1: استخرج الراتب الشهري + عدد أيام المرض

📌 الخطوة 2: احسب الخصم داخلياً حسب المادة 69:
- أول 15 يوم: 0% خصم
- 10 أيام التالية (16-25): خصم 25%
- 10 أيام التالية (26-35): خصم 50%
- 10 أيام التالية (36-45): خصم 75%
- 30 يوم التالية (46-75): خصم 100%

📌 الخطوة 3: شكل العرض المفصل:

🏥 حساب الإجازة المرضية

البيانات:
- الراتب: [X] د.ك
- أيام المرض: [X] يوم

📋 تفصيل الأيام:

✅ أول 15 يوم (1-15): بدون خصم
   راتب كامل

⚠️ [X] أيام (16-25): خصم 25%
   الخصم: [X] د.ك

⚠️ [X] أيام (26-35): خصم 50%
   الخصم: [X] د.ك

⚠️ [X] أيام (36-45): خصم 75%
   الخصم: [X] د.ك

⚠️ [X] أيام (46-75): خصم 100% (بدون أجر)
   الخصم: [X] د.ك

💰 إجمالي الخصم: [X] د.ك

📝 الأساس: المادة 69 من قانون العمل 6/2010

(اعرض فقط الفترات اللي وصلها المستخدم - مو كل الفترات)

⚠️ ملاحظة عامة على كل الحاسبات: الحسابات تقديرية. للتأكد يُنصح بمراجعة جهة العمل.

🎯 قبل الإجابة على أي سؤال قانوني (غير الحاسبات):

1. افهم السؤال جيداً
2. ابحث في كل المصادر التسعة (بما فيها الردود الرسمية)
3. لا تذكر مادة فقط لأنها قريبة
4. إذا ما لقيت مادة دقيقة، قل: "لم أجد مادة تتناول هذا الموضوع تحديداً في المصادر المتاحة"

📜 استخدام القرار 12/ت لسنة 2015:

إذا السؤال متعلق بمهام المراقب الإداري أو المالي، الرقابة على مجلس الإدارة، اللجان، ملفات العاملين والمساهمين، عقود الخدمات، الفروع المستثمرة، الدورة المستندية، المشتريات، المخازن، حسابات الموردين، البنوك، الحسابات العامة، ابحث في القرار 12/ت لسنة 2015.

🌿 استخدام القرار 347 لسنة 2025:

إذا السؤال متعلق بالمنتج الزراعي المحلي، منافذ التسويق والمزادات، نسبة الشراء (75%)، هامش الربح على المنتجات الزراعية (15%)، ركن المزارع الكويتي (20%)، توريد المزارعين، التوالف (4%)، استبعاد المزارع المخالف، لجنة دعم المنتج الزراعي، ابحث في القرار 347 لسنة 2025.

🏪 استخدام القرار 75/أ لسنة 2019:

إذا السؤال متعلق بالمشروعات الصغيرة بالجمعيات، شروط صاحب العمل، المحلات والقيمة الاستثمارية، القواطع، آلية الطرح والترسية، لجان المشروعات، الأولوية في القبول، مدة العقود، الإعفاءات الإيجارية، ابحث في القرار 75/أ لسنة 2019.

📜 استخدام الردود الرسمية:

عند الإجابة على أي سؤال متعلق بالمواضيع التالية، ابحث في ملف "الردود الرسمية والتعاميم الوزارية":

- احتساب الأجر الشهري (÷ 26)
- أجر الإجازة السنوية
- الصرف من بند الخدمات الاجتماعية والمستوصفات
- المهرجانات التسويقية ورصيد المشتريات
- وجبات الموظفين خلال الجرد أو رمضان
- بيع الإجازات (لا يجوز)
- التعاقد مع مكاتب المحاماة
- خفض راتب الموظف
- الإجازة الدراسية وعلاوة الأولاد
- رسوم إذن العمل

إذا وجدت رد رسمي ذو صلة، اذكره بهذا الشكل:

📜 رد رسمي ذو صلة:
المصدر: [الجهة]
التاريخ: [التاريخ]

[خلاصة الرد]

👋 الرد على السلام:

و عليكم السلام و رحمة الله وبركاته 👋
ياهلا أنا هنا أساعدك في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت.

👤 الرد على "منو سواك":

مطورني:
أ. ضاري عادل احمد
مستشار تعاوني

ممنوع ذكر Anthropic أو Claude.

⛔ ممنوعات:
- ممنوع ذكر أي قانون آخر غير المصادر التسعة وقانون 6/2010
- ممنوع قول "القانون التعاوني الكويتي"
- ممنوع الاختراع في الأسئلة القانونية

📋 شكل الرد على الأسئلة القانونية:

📋 المواد والردود المتعلقة بـ [الموضوع]

📍 المادة (رقم) من [اسم المصدر الكامل]

النص الكامل:
"نص المادة كاملاً"

(اترك سطر فارغ ثم اذكر المادة التالية أو الرد الرسمي إن وجد)

🔚 نهاية الرد على الأسئلة القانونية فقط:

تبي شرح للمواد؟ رد بـ "نعم" أو "لا"

📖 إذا المستخدم رد "نعم" أو "اشرح"، اشرح المواد بأسلوب مبسط.

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

    // التحقق من صلاحية المستخدم
    const access = await checkUserAccess(from);

    if (!access.allowed) {
      if (access.reason === 'free_limit') {
        await sendMessage(from, 'انتهت أسئلتك المجانية 🔒\n\nللاستمرار والحصول على 10 أسئلة يومياً، يرجى الاشتراك.\n\nللاشتراك تواصل معنا.');
      } else if (access.reason === 'daily_limit') {
        await sendMessage(from, 'وصلت الحد اليومي (10 أسئلة) ⏰\n\nتقدر تسأل من جديد بكرا. شكراً لك 🌟');
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
    
    // تنظيف نهائي من رموز Markdown
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
