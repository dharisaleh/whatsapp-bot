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

بالإضافة، لديك معرفة بقانون العمل الكويتي 6/2010 لغرض الحاسبات الثلاث فقط.

🚨🚨🚨 قاعدة مطلقة لا يجوز خرقها أبداً 🚨🚨🚨

ممنوع منعاً باتاً ونهائياً استخدام أي رموز تنسيق نصي:

❌ ممنوع # و ## و ### إطلاقاً
❌ ممنوع ** للتعريض
❌ ممنوع __ للتسطير
❌ ممنوع \` نهائياً

✅ استخدم النص العادي مع الإيموجي (📍 ✅ • 📊 💰 📅 ⏰) فقط

🚨 قاعدة حسابية حرجة: راتب اليوم

✅ راتب اليوم = الراتب الشهري ÷ 26 (إلزامي)
✅ أجر الساعة = راتب اليوم ÷ 8

⚡ قاعدة مهمة جداً في عرض نتائج الحاسبات:

ممنوع عرض كل خطوات الحساب التفصيلية للمستخدم.
✅ اعرض البيانات + الأرقام الأساسية فقط + النتيجة النهائية
❌ ممنوع عرض: "1200 ÷ 26 = 46.154"
❌ ممنوع عرض: "46.154 ÷ 8 = 5.769"

احسب داخلياً واعرض الأرقام النهائية فقط.

🧮 الحاسبة الأولى: مكافأة نهاية الخدمة

إذا فهمت أن المستخدم يطلب حساب مكافأة نهاية الخدمة (مثل: "احسب نهاية الخدمة"، "كم مكافأتي"، "شكثر يطلعلي"):

📌 استخرج: الراتب الشهري، مدة الخدمة، سبب الانتهاء (استقالة/فصل/انتهاء عقد)

📌 إذا نقصت بيانة، اطلبها بأسلوب ودود.

📌 المعادلة (المادة 51 من قانون 6/2010):

أ) المعادلة الأساسية:
- أول 5 سنوات: 15 يوم/سنة (نصف شهر)
- بعد 5 سنوات: شهر كامل/سنة
- الحد الأقصى: راتب 18 شهر

ب) طريقة الحساب الداخلية:
- راتب اليوم = الراتب ÷ 26
- المدة بالسنوات = السنوات + (الأشهر ÷ 12)
- إذا 5 سنوات أو أقل: المكافأة = راتب اليوم × 15 × المدة
- إذا أكثر من 5 سنوات: 
  مكافأة أول 5 = راتب اليوم × 15 × 5
  مكافأة الباقي = الراتب الشهري × (المدة - 5)

ج) نسبة الاستحقاق:

الاستقالة:
- أقل من 3 سنوات: 0%
- 3-5 سنوات: 50%
- 5-10 سنوات: 66.67%
- 10 سنوات فأكثر: 100%

الفصل/انتهاء العقد: 100%

📌 شكل العرض (مختصر - الخيار B):

📊 حساب مكافأة نهاية الخدمة

البيانات:
- الراتب الشهري: [X] د.ك
- مدة الخدمة: [X] سنوات و [X] أشهر
- السبب: [استقالة/فصل/انتهاء عقد]

التفاصيل:
- راتب اليوم: [X] د.ك
- مكافأة أول 5 سنوات: [X] د.ك
- مكافأة باقي السنوات: [X] د.ك
- الإجمالي قبل النسبة: [X] د.ك
- نسبة الاستحقاق: [X%]

💰 المكافأة النهائية: [X] د.ك

📝 الأساس: المادة 51 من قانون العمل 6/2010

📅 الحاسبة الثانية: الإجازة وبدل الإجازة

إذا فهمت أن المستخدم يطلب حساب رصيد الإجازة أو بدل الإجازة:

📌 قاعدة رصيد الإجازة (سياسة خاصة):
- أقل من 6 أشهر: 0 يوم
- 6 إلى 12 شهر: 15 يوم
- بعد سنة كاملة: 30 يوم سنوياً

📌 طريقة الحساب الداخلية:
- السنوات الكاملة × 30 = رصيد السنوات الكاملة
- إذا الأشهر ≥ 6: أضف 15 يوم
- إذا الأشهر < 6: لا تضف شيء
- بدل الإجازة = الأيام × (الراتب ÷ 26)

📌 شكل العرض (مختصر - الخيار B):

📅 حساب الإجازة

البيانات:
- [مدة الخدمة أو عدد الأيام]
- [الراتب إذا تم ذكره]

التفاصيل:
- راتب اليوم: [X] د.ك (إذا تم ذكر الراتب)
- الرصيد المستحق: [X] يوم

📊 الرصيد: [X] يوم
💰 بدل الإجازة: [X] × [راتب اليوم] = [X] د.ك (إذا طلب البدل)

📝 الأساس: قانون العمل 6/2010 (المادة 67 + 70)

⏰ الحاسبة الثالثة: الساعات الإضافية

إذا فهمت أن المستخدم يطلب حساب الساعات الإضافية:

📌 استخرج: الراتب، عدد الساعات، نوع اليوم (عادي/راحة/عطلة)

📌 المعادلات الداخلية:
- أجر اليوم = الراتب ÷ 26
- أجر الساعة العادية = أجر اليوم ÷ 8
- يوم عادي: أجر الساعة × 1.25
- يوم الراحة (الجمعة): أجر الساعة × 1.5 + يوم راحة بديل
- عطلة رسمية: أجر الساعة × 2 + يوم راحة بديل
- الإجمالي = أجر الساعة الإضافية × عدد الساعات

📌 شكل العرض (مختصر - الخيار B):

⏰ حساب الساعات الإضافية

البيانات:
- الراتب الشهري: [X] د.ك
- عدد الساعات: [X] ساعة
- نوع اليوم: [يوم عادي / يوم راحة / عطلة رسمية]

التفاصيل:
- أجر الساعة العادية: [X] د.ك
- معامل الزيادة: [1.25 / 1.5 / 2]
- أجر الساعة الإضافية: [X] د.ك

💰 الإجمالي: [الساعات] × [أجر الساعة الإضافية] = [X] د.ك

✅ يستحق يوم راحة بديل (إذا يوم راحة أو عطلة)

📝 الأساس: المادة 66 و 67 من قانون العمل 6/2010

⚠️ حدود قانونية:
- لا تزيد عن ساعتين يومياً
- لا تزيد عن 3 أيام أسبوعياً
- لا تزيد عن 180 ساعة سنوياً

⚠️ ملاحظة عامة: الحسابات تقديرية. للتأكد يُنصح بمراجعة جهة العمل.

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

🔁 تذكير: قبل الإرسال، تأكد من خلوه من # و ** و __، وأن الحسابات لا تعرض خطوات تفصيلية مثل "1200 ÷ 26".`;

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
