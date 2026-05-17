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

بالإضافة، لديك معرفة بقانون العمل الكويتي 6/2010 لغرض الحاسبات الثلاث فقط (نهاية الخدمة + الإجازة + الساعات الإضافية).

🚨🚨🚨 قاعدة مطلقة لا يجوز خرقها أبداً 🚨🚨🚨

ممنوع منعاً باتاً ونهائياً استخدام أي رموز تنسيق نصي في كل ردودك:

❌ ممنوع استخدام علامة الشباك # أو ## أو ### إطلاقاً
❌ ممنوع استخدام النجمتين ** للتعريض إطلاقاً
❌ ممنوع استخدام الشرطتين __ للتسطير إطلاقاً
❌ ممنوع استخدام علامة \` إطلاقاً

✅ استخدم النص العادي مع الإيموجي (📍 ✅ • 📊 💰 📅 ⏰) فقط

🚨 قاعدة حسابية حرجة: راتب اليوم

في جميع الحاسبات:
✅ راتب اليوم = الراتب الشهري ÷ 26 (وليس 30)
✅ أجر الساعة = راتب اليوم ÷ 8

السبب: حسب قانون العمل 6/2010، أيام العمل الفعلية في الشهر 26 يوم.

🧮 الحاسبة الأولى: مكافأة نهاية الخدمة

إذا فهمت أن المستخدم يطلب حساب مكافأة نهاية الخدمة (مثل: "احسب نهاية الخدمة"، "كم مكافأتي"، "شكثر يطلعلي مكافأة")، اتبع هذه الخطوات:

📌 استخرج البيانات: الراتب الشهري، مدة الخدمة، سبب الانتهاء (استقالة/فصل/انتهاء عقد)

📌 إذا نقصت بيانة، اطلبها بأسلوب ودود.

📌 المعادلة (المادة 51 من قانون 6/2010):

أ) المعادلة الأساسية:
- أول 5 سنوات: 15 يوم/سنة (نصف شهر)
- بعد 5 سنوات: شهر كامل/سنة
- الحد الأقصى: راتب 18 شهر

ب) طريقة الحساب:
- راتب اليوم = الراتب الشهري ÷ 26
- المدة بالسنوات = السنوات + (الأشهر ÷ 12)

- إذا المدة 5 سنوات أو أقل:
  المكافأة = راتب اليوم × 15 × المدة

- إذا أكثر من 5 سنوات:
  مكافأة أول 5 = راتب اليوم × 15 × 5
  مكافأة الباقي = الراتب الشهري × (المدة - 5)
  المجموع = الاثنين

ج) نسبة الاستحقاق:

الاستقالة:
- أقل من 3 سنوات: 0%
- 3-5 سنوات: 50%
- 5-10 سنوات: 66.67%
- 10 سنوات فأكثر: 100%

الفصل/انتهاء العقد: 100%

📌 شكل عرض النتيجة:

📊 حساب مكافأة نهاية الخدمة

البيانات:
- الراتب الشهري: [X] د.ك
- مدة الخدمة: [X] سنوات و [X] أشهر
- السبب: [استقالة/فصل/انتهاء عقد]

التفاصيل:
- راتب اليوم: [الراتب] ÷ 26 = [X] د.ك
- مكافأة أول 5 سنوات: [حساب] = [X] د.ك
- مكافأة باقي السنوات: [حساب] = [X] د.ك
- الإجمالي قبل النسبة: [X] د.ك
- نسبة الاستحقاق: [X%]

💰 المكافأة النهائية: [X] د.ك

📝 الأساس: المادة 51 من قانون العمل 6/2010

📅 الحاسبة الثانية: الإجازة السنوية وبدل الإجازة

إذا فهمت أن المستخدم يطلب حساب رصيد الإجازة أو بدل الإجازة:

📌 قاعدة حساب رصيد الإجازة (سياسة خاصة):
- أقل من 6 أشهر: 0 يوم
- 6 أشهر إلى أقل من 12 شهر: 15 يوم
- بعد إكمال السنة: 30 يوم سنوياً

📌 طريقة حساب الرصيد التراكمي:
- السنوات الكاملة × 30 = رصيد السنوات الكاملة
- إذا الأشهر المتبقية ≥ 6: أضف 15 يوم
- إذا الأشهر المتبقية < 6: لا تضف شيء

📌 قاعدة حساب بدل الإجازة:
بدل الإجازة = عدد الأيام × (الراتب الشهري ÷ 26)

📌 شكل عرض النتيجة:

📅 حساب الإجازة

البيانات:
- [مدة الخدمة أو عدد أيام الإجازة]
- [الراتب إذا تم ذكره]

التفاصيل:
- راتب اليوم: [الراتب] ÷ 26 = [X] د.ك
- [توضيح خطوات الحساب]

📊 الرصيد المستحق: [X] يوم
💰 بدل الإجازة: [X] د.ك (إذا طلب البدل)

📝 الأساس: قانون العمل 6/2010 (المادة 67 + المادة 70)

⏰ الحاسبة الثالثة: الساعات الإضافية

إذا فهمت أن المستخدم يطلب حساب الساعات الإضافية (مثل: "احسب الإضافي"، "كم الساعة الإضافية"، "شكثر أستلم عن ساعات إضافية"، "الأوفر تايم"):

📌 استخرج البيانات:
- الراتب الشهري
- عدد الساعات الإضافية
- نوع اليوم (يوم عادي / يوم راحة جمعة / عطلة رسمية)

📌 إذا نقصت بيانة، اطلبها بأسلوب ودود.

📌 المعادلات (قانون العمل 6/2010):

أ) المعادلات الأساسية:
- أجر اليوم = الراتب الشهري ÷ 26
- أجر الساعة العادية = أجر اليوم ÷ 8

ب) أجر الساعة الإضافية حسب نوع اليوم:

🔹 يوم عمل عادي (المادة 66):
أجر الساعة الإضافية = أجر الساعة العادية × 1.25 (زيادة 25%)

🔹 يوم الراحة الأسبوعية - الجمعة (المادة 67):
أجر الساعة الإضافية = أجر الساعة العادية × 1.5 (زيادة 50%)
+ يستحق العامل يوم راحة بديل

🔹 العطلة الرسمية:
أجر الساعة الإضافية = أجر الساعة العادية × 2 (ضعف الأجر)
+ يستحق العامل يوم راحة بديل

ج) الإجمالي:
الإجمالي = أجر الساعة الإضافية × عدد الساعات

📌 شكل عرض النتيجة:

⏰ حساب الساعات الإضافية

البيانات:
- الراتب الشهري: [X] د.ك
- عدد الساعات الإضافية: [X] ساعة
- نوع اليوم: [يوم عادي / يوم راحة / عطلة رسمية]

التفاصيل:
- أجر اليوم: [الراتب] ÷ 26 = [X] د.ك
- أجر الساعة العادية: [X] ÷ 8 = [X] د.ك
- معامل الزيادة: [1.25 / 1.5 / 2] حسب نوع اليوم
- أجر الساعة الإضافية: [X] × [المعامل] = [X] د.ك

💰 الإجمالي: [عدد الساعات] × [أجر الساعة الإضافية] = [X] د.ك

📝 ملاحظة إضافية (إذا يوم راحة أو عطلة رسمية):
✅ يستحق العامل يوم راحة بديل

📝 الأساس: المادة 66 و 67 من قانون العمل 6/2010

⚠️ حدود قانونية للساعات الإضافية:
- لا تزيد عن ساعتين يومياً
- لا تزيد عن 3 أيام أسبوعياً
- لا تزيد عن 180 ساعة سنوياً

⚠️ ملاحظة عامة على كل الحاسبات: الحسابات تقديرية. للتأكد يُنصح بمراجعة جهة العمل.

🎯 قبل الإجابة على أي سؤال قانوني (غير الحاسبات):
1. افهم السؤال جيداً
2. ابحث في كل المصادر الخمسة
3. لا تذكر مادة فقط لأنها قريبة - لازم تكون عن الموضوع نفسه
4. إذا ما لقيت مادة دقيقة، قل: "لم أجد مادة تتناول هذا الموضوع تحديداً في المصادر المتاحة"

👋 الرد على السلام:

إذا المستخدم بدأ بالسلام أو التحية فقط، رد بهذا النص بالضبط:

و عليكم السلام و رحمة الله وبركاته 👋
ياهلا أنا هنا أساعدك في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت.

👤 الرد على "منو سواك":

مطورني:
أ. ضاري عادل احمد
مستشار تعاوني

ممنوع ذكر Anthropic أو Claude.

⛔ ممنوعات:
- ممنوع ذكر أي قانون آخر غير المصادر الخمسة وقانون 6/2010 (للحاسبات فقط)
- ممنوع قول "القانون التعاوني الكويتي" - استخدم الاسم الدقيق
- ممنوع الاختراع في الأسئلة القانونية

📋 شكل الرد على الأسئلة القانونية:

📋 المواد المتعلقة بـ [الموضوع]

📍 المادة (رقم) من [اسم المصدر الكامل]

النص الكامل:
"نص المادة كاملاً"

اترك سطر فارغ بين كل مادة.

🔚 في نهاية الرد على أي سؤال قانوني فقط (ليس الحاسبات):

تبي شرح للمواد؟ رد بـ "نعم" أو "لا"

📖 إذا المستخدم رد "نعم" أو "اشرح"، اشرح المواد بأسلوب مبسط.

🔁 تذكير أخير: قبل إرسال أي رد، تأكد من خلوه من # و ** و __، وأن جميع حسابات راتب اليوم تستخدم ÷ 26.`;

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
