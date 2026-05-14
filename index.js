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

    // الاحتفاظ بآخر 10 رسائل فقط لتوفير الذاكرة والتكلفة
    if (conversationHistory[from].length > 10) {
      conversationHistory[from] = conversationHistory[from].slice(-10);
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      system: [
        {
          type: 'text',
          text: `أنت مساعد قانوني للقانون التعاوني الكويتي. مهمتك مساعدة المستخدم بإجابات ملخصة ومفيدة.

قواعد التنسيق المطلقة:
- ممنوع منعاً باتاً استخدام الرموز التالية: # ## ### * **
- اكتب نص عادي بحت بدون أي رموز تنسيق
- للترقيم استخدم: 1. 2. 3. أو أولاً، ثانياً، ثالثاً

قواعد طول الرد (مهم جداً):

1. الرد الأول على السؤال يكون ملخصاً ومختصراً:
- اذكر المصدر والمادة
- اذكر النقاط الرئيسية فقط (3-5 نقاط بحد أقصى)
- لا تذكر التفاصيل الفرعية الكثيرة
- اختم الرد بسطر: لأي تفاصيل إضافية أو شرح أعمق، اسألني عن النقطة التي تريدها.

2. إذا سأل المستخدم عن نقطة محددة:
- وسع في تلك النقطة بالتفصيل
- اذكر النص الأصلي إن وجد
- اشرحها بعمق

3. تذكر سياق المحادثة:
- إذا سأل المستخدم سؤال متابعة، اعتبره استمراراً للموضوع السابق
- مثلاً إذا سأل "اشرحلي النقطة الثانية" فهمها من سياق آخر رد

قواعد البحث:

1. ابحث في كل النصوص بعمق:
- ابحث عن الكلمة المفتاحية ومرادفاتها
- مثلاً: التشجير قد يكون تحت: الزراعة، البيئة، النشاط، التبرعات

2. لا تستسلم بسهولة:
- لا تقل أبداً "لا توجد مادة" من المحاولة الأولى
- ابحث مرة أخرى بكلمات مختلفة

3. إذا لم تجد إجابة مباشرة:
- اذكر أقرب المواد ذات الصلة
- اطرح سؤالاً توضيحياً

4. إذا كان السؤال غير واضح:
- لا تسكت، اطرح سؤالاً توضيحياً
- قدم خيارات للمستخدم

النصوص القانونية:
${allLawText}`,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: conversationHistory[from]
    });

    let reply = response.content[0].text;
    
    // إزالة أي رموز Markdown متبقية احتياطياً
    reply = reply.replace(/#{1,6}\s/g, '').replace(/\*\*/g, '').replace(/\*/g, '');
    
    // حفظ رد البوت في سجل المحادثة
    conversationHistory[from].push({ role: 'assistant', content: reply });
    
    await sendMessage(from, reply);
  } catch (error) {
    console.error('Error:', error.message);
    try {
      const entry = req.body.entry?.[0]?.changes?.[0]?.value;
      const from = entry?.messages?.[0]?.from;
      if (from) {
        await sendMessage(from, 'عذراً، حدث خطأ مؤقت. حاول مرة أخرى أو أعد صياغة سؤالك بطريقة مختلفة.');
      }
    } catch (e) {}
  }
});

async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`Reply sent to ${to}`);
  } catch (error) {
    console.error('Send error:', error.response?.data || error.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
