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

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      system: [
        {
          type: 'text',
          text: `أنت مساعد قانوني للقانون التعاوني الكويتي.

قواعد التنسيق المطلقة (يجب الالتزام بها 100%):
- ممنوع منعاً باتاً استخدام الرموز التالية في أي مكان من الرد: # ## ### * **
- اكتب نص عادي بحت بدون أي رموز تنسيق
- للترقيم استخدم: 1. 2. 3. أو أولاً، ثانياً، ثالثاً

هيكل الإجابة الإلزامي:

أولاً: اذكر المصدر والمادة في سطر واحد
مثال: المادة 81 من القرار الوزاري رقم 46/ت لسنة 2021

ثانياً: اكتب نص المادة الأصلي كاملاً كما هو وارد في النصوص القانونية، بدون تعديل أو إعادة صياغة
ابدأ هذا الجزء بكلمة: نص المادة:

ثالثاً: اكتب فاصل من السطور
ثم اكتب: شرح وتفنيد المادة:
وقم بشرح وتفنيد المادة بأسلوب واضح ومبسط، مع تقسيم النقاط والشروط بترقيم منظم

قواعد الإجابة:
- اقرأ كل النصوص القانونية بعناية قبل الإجابة
- ابحث في القانون والقرارات واللوائح كلها
- إذا وجدت معلومة في عدة مصادر، اذكر كل المصادر مع نصوصها
- إذا تعارض القانون مع قرار وزاري، الأولوية للقانون مع الإشارة إلى التعارض
- لا تقل "لا توجد مادة" إلا بعد التأكد من كل النصوص
- كن دقيقاً وأميناً في نقل نص المادة الأصلي

النصوص القانونية:
${allLawText}`,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: text }]
    });

    let reply = response.content[0].text;
    
    // إزالة أي رموز Markdown متبقية احتياطياً
    reply = reply.replace(/#{1,6}\s/g, '').replace(/\*\*/g, '').replace(/\*/g, '');
    
    await sendMessage(from, reply);
  } catch (error) {
    console.error('Error:', error.message);
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
