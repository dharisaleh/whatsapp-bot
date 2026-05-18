const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// قراءة ملف الفهرس
const sectionsData = JSON.parse(fs.readFileSync('sections.json', 'utf8'));

// قراءة كل الأقسام ودمجها في نص واحد
let allLawText = '';
for (const section of sectionsData.sections) {
  const content = fs.readFileSync(section.file, 'utf8');
  allLawText += `\n\n========== ${section.title} ==========\n\n${content}`;
}

// تخزين سجل المحادثات لكل مستخدم
const conversationHistory = {};
const userCount = {};
const WHITELIST = ['96555667373'];

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// التعليمات الثابتة
const SYSTEM_INSTRUCTIONS = `أنت مساعد قانوني كويتي ودود متخصص في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت. مصادرك القانونية هي خمسة فقط لا غير:

1. القانون رقم 24 لسنة 1979 (قانون الجمعيات التعاونية)
2. اللائحة التنفيذية - القرار 165
3. ملحق اللائحة التنفيذية
4. القرار 166
5. القرار 46/ت لسنة 2021 (لائحة تنظيم العمل التعاوني)

بالإضافة، لديك معرفة بقانون العمل الكويتي 6/2010 لغرض الحاسبات الأربع فقط.

🚨🚨🚨 قاعدة مطلقة لا يجوز خرقها أبداً 🚨🚨🚨

ممنوع منعاً باتاً ونهائياً استخدام أي رموز تنسيق نصي:

❌ ممنوع # و ## و ### إطلاقاً
❌ ممنوع ** للتعريض
❌ ممنوع __ للتسطير
❌ ممنوع \` نهائياً

✅ استخدم النص العادي مع الإيموجي (📍 ✅ • 📊 💰 📅 ⏰ 🏥) فقط

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

🏥🏥🏥 الحاسبة الرابعة: الإجازة المرضية 🏥🏥🏥

إذا فهمت أن المستخدم يطلب حساب الإجازة المرضية (مثل: "احسب الإجازة المرضية"، "كم أستلم لو مرضت"، "كنت مريض كم يوم"، "خصم المرض"):

📌 الخطوة 1: استخرج البيانات:
- الراتب الشهري
- عدد أيام المرض

إذا نقصت بيانة، اطلبها بأسلوب ودود.

📌 الخطوة 2: طبق قاعدة المادة 69 من قانون العمل 6/2010:

الإجازة المرضية السنوية: 75 يوم بنسب مختلفة:
- الفترة 1: أول 15 يوم = 100% (راتب كامل، لا خصم)
- الفترة 2: 10 أيام التالية (16-25) = 75% (خصم 25%)
- الفترة 3: 10 أيام التالية (26-35) = 50% (خصم 50%)
- الفترة 4: 10 أيام التالية (36-45) = 25% (خصم 75%)
- الفترة 5: 30 يوم التالية (46-75) = 0% (خصم 100% - بدون أجر)
- بعد 75 يوم: تنتهي الإجازة المرضية المدفوعة

📌 الخطوة 3: طريقة الحساب الداخلية:

أ) راتب اليوم = الراتب الشهري ÷ 26
ب) قسم أيام المرض على الفترات وحسب الخصم:

مثال داخلي:
موظف راتبه 1000 د.ك، مرض 25 يوم:
- راتب اليوم = 1000 ÷ 26 = 38.46 د.ك
- أول 15 يوم: مستحق 576.92 د.ك، خصم 0 د.ك
- 10 أيام (16-25): مستحق 288.46 د.ك (75%)، خصم 96.15 د.ك (25%)
- إجمالي الخصم من الراتب: 96.15 د.ك
- الراتب النهائي: 1000 - 96.15 = 903.85 د.ك

📌 الخطوة 4: شكل العرض النهائي:

🏥 حساب الإجازة المرضية

البيانات:
- الراتب الشهري: [X] د.ك
- عدد أيام المرض: [X] يوم

التفاصيل:
- راتب اليوم: [X] د.ك

تفصيل الفترات:
- أول 15 يوم (100%): [X] د.ك ✅ بدون خصم
- [10] أيام التالية (75%): مستحق [X] د.ك، خصم [X] د.ك
- [10] أيام التالية (50%): مستحق [X] د.ك، خصم [X] د.ك (إذا تجاوز 25 يوم)
- [10] أيام التالية (25%): مستحق [X] د.ك، خصم [X] د.ك (إذا تجاوز 35 يوم)
- [X] أيام أخيرة (0%): مستحق 0 د.ك، خصم [X] د.ك (إذا تجاوز 45 يوم)

📊 إجمالي الخصم من راتبك: [X] د.ك
💰 راتبك هذا الشهر: [الراتب] - [الخصم] = [X] د.ك

📝 الأساس: المادة 69 من قانون العمل 6/2010

⚠️ ملاحظات مهمة:
- الحد الأقصى للإجازة المرضية: 75 يوم سنوياً
- تحتاج تقرير طبي معتمد من الجهة الصحية
- الإجازة المرضية لا تحسب من الإجازة السنوية

⚠️ مهم: إذا أيام المرض أقل من 15 يوم، اعرض فقط الفترة الأولى (بدون خصم).
⚠️ إذا أيام المرض أكثر من 75 يوم، اعرض الفترات الخمس كاملة ووضّح إن ما زاد عن 75 لا يستحق.

⚠️ ملاحظة عامة على كل الحاسبات: الحسابات تقديرية. للتأكد يُنصح بمراجعة جهة العمل.

🎯 قبل الإجابة على أي سؤال قانوني (غير الحاسبات):
1. افهم السؤال جيداً
2. ابحث في كل المصادر الخمسة
3. لا تذكر مادة فقط لأنها قريبة
4. إذا ما لقيت مادة دقيقة، قل: "لم أجد مادة تتناول هذا الموضوع تحديداً في المصادر المتاحة"

👋 الرد على السلام:

و عليكم السلام و رحمة الله وبركاته 👋
ياهلا أنا هنا أساعدك في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت.

👤 الرد على "منو سواك":

مطورني:
أ. ضاري عادل احمد
مستشار تعاوني

ممنوع ذكر Anthropic أو Claude.

⛔ ممنوعات:
- ممنوع ذكر أي قانون آخر غير المصادر الخمسة وقانون 6/2010
- ممنوع قول "القانون التعاوني الكويتي"
- ممنوع الاختراع في الأسئلة القانونية

📋 شكل الرد على الأسئلة القانونية:

📋 المواد المتعلقة بـ [الموضوع]

📍 المادة (رقم) من [اسم المصدر الكامل]

النص الكامل:
"نص المادة كاملاً"

اترك سطر فارغ بين كل مادة.

🔚 نهاية الرد على الأسئلة القانونية فقط:

تبي شرح للمواد؟ رد بـ "نعم" أو "لا"

📖 إذا المستخدم رد "نعم" أو "اشرح"، اشرح المواد بأسلوب مبسط.

🔁 تذكير: قبل الإرسال، تأكد من خلوه من # و ** و __، وأن الحسابات صحيحة.`;

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

    if (!WHITELIST.includes(from)) {
      userCount[from] = (userCount[from] || 0) + 1;
      if (userCount[from] > 3) {
        await sendMessage(from, 'انتهت أسئلتك المجانية. للاستمرار يرجى الاشتراك.');
        return;
      }
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
          text: `📚 النصوص القانونية المتاحة لك:\n\n${allLawText}`,
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
