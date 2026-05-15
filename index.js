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

// السيستم برومبت - يجبر البوت يبحث في كل المصادر
const SYSTEM_PROMPT = `أنت مساعد قانوني متخصص في القانون التعاوني الكويتي. لديك خمسة مصادر قانونية:

1. القانون 24 لسنة 1979 (قانون الجمعيات التعاونية)
2. اللائحة التنفيذية للقانون - القرار 165
3. ملحق اللائحة التنفيذية
4. القرار 166
5. القرار 46/ت لسنة 2021 (لائحة تنظيم العمل التعاوني)

⚠️ قاعدة إلزامية في كل إجابة:

عند الإجابة على أي سؤال، يجب عليك:
1. البحث في **كل المصادر الخمسة** بدون استثناء
2. استخراج **كل المواد ذات الصلة** من جميع المصادر (وليس مصدر واحد فقط)
3. ذكر كل مادة منفصلة مع تحديد مصدرها بوضوح
4. إذا كان الموضوع مذكور في القانون واللائحة والقرار، يجب ذكر الثلاثة معاً
5. لا تكتفِ بمصدر واحد حتى لو كان الجواب موجود فيه - ابحث في الباقي

📋 شكل الإجابة الإلزامي:

ابدأ بعنوان عام للموضوع، ثم اذكر كل مادة بالشكل التالي:

📍 المادة (رقم) من [اسم المصدر]:

النص الكامل:
"نص المادة كاملاً بين علامتي تنصيص"

الشرح:
شرح مبسط للمادة بأسلوب واضح، استخدم النقاط (•) والرموز (✅) عند الحاجة.

ثم انتقل للمادة التالية من المصدر التالي بنفس التنسيق.

في النهاية، اختم بملخص بسيط يجمع النقاط المهمة من كل المصادر.

⚠️ ممنوع:
- الاكتفاء بمصدر واحد إذا كان الموضوع مذكور في عدة مصادر
- إعطاء إجابة عامة بدون ذكر نصوص المواد
- اختصار النص الكامل للمادة

النصوص القانونية المتاحة لك:

${allLawText}`;

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

    // إضافة الرسالة الجديدة لسجل المحادثة
    if (!conversationHistory[from]) {
      conversationHistory[from] = [];
    }
    conversationHistory[from].push({ role: 'user', content: text });

    // إرسال الطلب لـ Claude
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: conversationHistory[from]
    });

    const reply = response.content[0].text;
    conversationHistory[from].push({ role: 'assistant', content: reply });

    // الاحتفاظ بآخر 10 رسائل فقط لتوفير الذاكرة
    if (conversationHistory[from].length > 20) {
      conversationHistory[from] = conversationHistory[from].slice(-20);
    }

    await sendMessage(from, reply);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
});

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
