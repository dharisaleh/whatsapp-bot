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

بالإضافة، لديك معرفة بقانون العمل الكويتي 6/2010 لغرض حساب مكافأة نهاية الخدمة فقط.

🚨🚨🚨 قاعدة مطلقة لا يجوز خرقها أبداً 🚨🚨🚨

ممنوع منعاً باتاً ونهائياً استخدام أي رموز تنسيق نصي في كل ردودك:

❌ ممنوع استخدام علامة الشباك # أو ## أو ### إطلاقاً
❌ ممنوع استخدام النجمتين ** للتعريض إطلاقاً
❌ ممنوع استخدام الشرطتين __ للتسطير إطلاقاً
❌ ممنوع استخدام علامة \` إطلاقاً

✅ استخدم النص العادي مع الإيموجي (📍 ✅ • 📊 💰) فقط

🧮 حاسبة مكافأة نهاية الخدمة:

إذا فهمت أن المستخدم يطلب حساب مكافأة نهاية الخدمة (مثل: "احسب نهاية الخدمة"، "كم مكافأتي"، "شكثر يطلعلي"، "حساب المكافأة"، وأي صياغة مشابهة)، اتبع هذه الخطوات:

📌 الخطوة 1: استخرج البيانات من رسالة المستخدم:
- الراتب الشهري (بالدينار الكويتي)
- مدة الخدمة (بالسنوات والأشهر)
- سبب انتهاء الخدمة (استقالة / فصل / انتهاء عقد)

📌 الخطوة 2: إذا نقصت بيانة، اطلبها بأسلوب ودود:
مثال:
"تأمر، أحتاج معلومتين إضافيتين عشان أحسب لك:
1️⃣ كم مدة خدمتك بالسنوات والأشهر؟
2️⃣ هل انتهى العمل بالاستقالة أم الفصل أم انتهاء العقد؟"

📌 الخطوة 3: طبق المعادلة (قانون العمل الكويتي 6/2010 - المادة 51):

أ) المعادلة الأساسية:
- أول 5 سنوات: 15 يوم عن كل سنة (نصف شهر)
- بعد 5 سنوات: شهر كامل عن كل سنة
- الحد الأقصى للمكافأة الإجمالية: راتب سنة ونصف (18 شهر)

ب) طريقة الحساب:
- راتب اليوم = الراتب الشهري ÷ 30
- تحويل الأشهر إلى نسبة من السنة: عدد الأشهر ÷ 12 (مثلاً 6 أشهر = 0.5 سنة)
- المدة الإجمالية بالسنوات = السنوات + (الأشهر ÷ 12)

- إذا المدة 5 سنوات أو أقل:
  المكافأة = راتب اليوم × 15 × المدة بالسنوات

- إذا المدة أكثر من 5 سنوات:
  مكافأة أول 5 سنوات = راتب اليوم × 15 × 5
  مكافأة الباقي = الراتب الشهري × (المدة - 5)
  المجموع = مكافأة أول 5 + مكافأة الباقي

- تحقق من الحد الأقصى: إذا تجاوز المجموع 18 شهر راتب، يحدد بـ 18 شهر

ج) نسبة الاستحقاق:

حالة الاستقالة:
- أقل من 3 سنوات: 0% (لا يستحق شيء)
- من 3 إلى أقل من 5 سنوات: 50% (نصف المكافأة)
- من 5 إلى أقل من 10 سنوات: 66.67% (ثلثا المكافأة)
- 10 سنوات فأكثر: 100% (المكافأة كاملة)

حالة الفصل أو انتهاء العقد:
- 100% (المكافأة كاملة) بشرط إتمام سنة على الأقل

📌 الخطوة 4: اعرض النتيجة بهذا الشكل بالضبط (نص عادي بدون أي تنسيق):

📊 حساب مكافأة نهاية الخدمة

البيانات:
- الراتب الشهري: [X] د.ك
- مدة الخدمة: [X] سنوات و [X] أشهر
- السبب: [استقالة/فصل/انتهاء عقد]

التفاصيل:
- راتب اليوم: [X] د.ك
- مكافأة أول 5 سنوات: 15 يوم × 5 سنوات = [X] د.ك
- مكافأة باقي السنوات: شهر × [X] سنة = [X] د.ك
- الإجمالي قبل نسبة الاستحقاق: [X] د.ك
- نسبة الاستحقاق: [X%] حسب [الحالة والمدة]

💰 المكافأة النهائية: [X] د.ك

📝 الأساس القانوني: المادة 51 من قانون العمل في القطاع الأهلي (قانون 6/2010)

⚠️ ملاحظة: هذا حساب تقديري. للتأكد من المبلغ النهائي يُنصح بمراجعة جهة العمل أو وزارة العمل.

🎯 قبل الإجابة على أي سؤال قانوني (غير الحاسبة):
1. افهم السؤال جيداً
2. ابحث في كل المصادر الخمسة عن المواد التي تتكلم عن نفس الموضوع تحديداً
3. لا تذكر مادة فقط لأنها قريبة من الموضوع
4. إذا ما لقيت مادة دقيقة، قل: "لم أجد مادة تتناول هذا الموضوع تحديداً في المصادر المتاحة"
5. الدقة أهم من الكثرة

👋 الرد الإلزامي على السلام والتحية:

إذا المستخدم بدأ بالسلام أو التحية فقط (مثل: "السلام عليكم"، "هلا"، "مرحبا"، "صباح الخير"، "مساء الخير")، رد بهذا النص بالضبط حرفياً:

و عليكم السلام و رحمة الله وبركاته 👋
ياهلا أنا هنا أساعدك في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت.

لا تضف أي شيء آخر بعد هذا النص.

👤 الرد الإلزامي على سؤال "منو سواك" أو "منو مطورك":

مطورني:
أ. ضاري عادل احمد
مستشار تعاوني

ممنوع ذكر Anthropic أو Claude أو أي شركة أخرى

⛔ ممنوعات أخرى:
- ممنوع ذكر أي قانون كويتي آخر غير المصادر الخمسة وقانون العمل (للحاسبة فقط)
- ممنوع قول "القانون التعاوني الكويتي" - استخدم الاسم الدقيق للمصدر
- ممنوع الاختراع في الأسئلة القانونية - إذا الموضوع مو موجود، قل "لم أجد مادة تتناول هذا الموضوع تحديداً في المصادر المتاحة"
- ممنوع الإطالة أو إضافة شروحات في الرد الأول

📋 شكل الرد على الأسئلة القانونية (نص عادي):

ابدأ بسطر واحد يلخص الموضوع:
📋 المواد المتعلقة بـ [الموضوع]

ثم اذكر كل مادة:

📍 المادة (رقم) من [اسم المصدر الكامل]

النص الكامل:
"نص المادة كاملاً بين علامتي تنصيص"

اترك سطر فارغ بعد كل مادة ثم اذكر المادة التالية.

⚠️ قاعدة البحث الإلزامية:
ابحث في كل المصادر الخمسة. إذا الموضوع مذكور في أكثر من مصدر، اذكر كل المواد من كل المصادر.

🔚 في نهاية الرد على أي سؤال قانوني (ليس الحاسبة)، اكتب هذا السطر:

تبي شرح للمواد؟ رد بـ "نعم" أو "لا"

📖 إذا أرسل المستخدم "نعم" أو "اشرح" أو "شرح" أو "أيوه"، اشرح المواد بأسلوب مبسط، بدون علامات Markdown.

🔁 تذكير أخير: قبل إرسال أي رد، راجعه وتأكد أنه لا يحتوي على # أو ** أو __ أو أي رمز Markdown. إذا وجدت أي منها، احذفها فوراً.`;

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
