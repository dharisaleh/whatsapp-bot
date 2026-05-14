const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// قراءة ملف الفهرس
const sectionsData = JSON.parse(fs.readFileSync('sections.json', 'utf8'));

// قراءة كل الأقسام في الذاكرة (لتسريع الوصول)
const sectionsContent = {};
for (const section of sectionsData.sections) {
  sectionsContent[section.id] = fs.readFileSync(section.file, 'utf8');
}

// بناء نص فهرس الأقسام لـ Claude
const sectionsIndex = sectionsData.sections.map(s => 
  `- ${s.id}: ${s.title}\n  ${s.description}`
).join('\n\n');

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

    // المرحلة 1: تحديد الأقسام المتعلقة بالسؤال
    const routingResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `أنت موجه ذكي. مهمتك تحديد الأقسام المتعلقة بسؤال المستخدم من قائمة الأقسام التالية:

${sectionsIndex}

أجب فقط بأسماء معرفات الأقسام (id) المتعلقة بالسؤال، مفصولة بفواصل. مثلاً: law,decision_46
لا تكتب أي شيء آخر، فقط المعرفات.`,
      messages: [{ role: 'user', content: text }]
    });

    const sectionIds = routingResponse.content[0].text.trim().split(',').map(s => s.trim());
    
    // جمع محتوى الأقسام المختارة
    let relevantContent = '';
    for (const id of sectionIds) {
      if (sectionsContent[id]) {
        relevantContent += sectionsContent[id] + '\n\n';
      }
    }
    
    // إذا ما لقى شي، استخدم القانون الأساسي
    if (!relevantContent) {
      relevantContent = sectionsContent['law'];
    }

    // المرحلة 2: الإجابة على السؤال
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: `أنت مساعد قانوني للقانون التعاوني الكويتي.

قواعد مهمة جداً يجب اتباعها في كل رد:
- ممنوع منعاً باتاً استخدام علامة # أو ## أو ### في أي مكان من الرد
- ممنوع منعاً باتاً استخدام علامة * أو ** في أي مكان من الرد
- اكتب نص عادي فقط بدون أي تنسيق
- للعناوين استخدم سطر جديد فقط
- للقوائم استخدم أرقام عادية مثل 1. 2. 3.
- اذكر دائماً مصدر المعلومة (قانون / لائحة / قرار وزاري)
- إذا تعارض القانون مع قرار وزاري، الأولوية للقانون

أجب على الأسئلة بناءً على النصوص القانونية التالية فقط:

${relevantContent}`,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: text }]
    });

    const reply = response.content[0].text;
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
