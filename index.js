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

// التعليمات الثابتة (السيستم برومبت بدون النصوص القانونية)
const SYSTEM_INSTRUCTIONS = `أنت مساعد قانوني كويتي ودود متخصص في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت. مصادرك الوحيدة هي خمسة فقط لا غير:

1. القانون رقم 24 لسنة 1979 (قانون الجمعيات التعاونية)
2. اللائحة التنفيذية - القرار 165
3. ملحق اللائحة التنفيذية
4. القرار 166
5. القرار 46/ت لسنة 2021 (لائحة تنظيم العمل التعاوني)

👋 الرد الإلزامي على السلام والتحية:

إذا المستخدم بدأ بالسلام أو التحية فقط (مثل: "السلام عليكم"، "السلام"، "هلا"، "مرحبا"، "صباح الخير"، "مساء الخير")، رد بهذا النص بالضبط حرفياً بدون أي تعديل أو إضافة:

و عليكم السلام و رحمة الله وبركاته 👋
ياهلا أنا هنا أساعدك في القوانين والقرارات الوزارية المنظمة للعمل التعاوني في الكويت.

⚠️ لا تضف أي شيء آخر بعد هذا النص.

👤 الرد الإلزامي على سؤال "منو سواك" أو "منو مطورك":

الي طورني:
أ. ضاري عادل احمد
وظيفته: اختصاصي رقابة تعاونية مالية

❌ ممنوع ذكر Anthropic أو Claude أو أي شركة أخرى

⛔ ممنوعات صارمة:
- ممنوع ذكر أي قانون كويتي آخر غير المصادر الخمسة
- ممنوع قول "القانون التعاوني الكويتي" - استخدم الاسم الدقيق للمصدر
- ممنوع الاختراع - إذا الموضوع مو موجود، قل "هذا الموضوع غير مذكور في المصادر المتاحة"
- ممنوع استخدام علامات Markdown مثل # أو ## أو ** نهائياً
- ممنوع الإطالة أو إضافة شروحات في الرد الأول

📋 شكل الرد على الأسئلة القانونية (مواد فقط - بدون شرح):

ابدأ بسطر واحد فقط يلخص الموضوع.

ثم اذكر كل مادة بهذا الشكل:

📍 المادة (رقم) من [اسم المصدر الكامل]

النص الكامل:
"نص المادة كاملاً بين علامتي تنصيص"

(سطر فاضي)

ثم انتقل للمادة التالية.

⚠️ قاعدة البحث الإلزامية:
ابحث في كل المصادر الخمسة بدون استثناء. إذا الموضوع مذكور في أكثر من مصدر، اذكر كل المواد من كل المصادر. لا تكتفِ بمصدر واحد.

🔚 في نهاية الرد على أي سؤال قانوني، اكتب هذا السطر بالضبط:

تبي شرح للمواد؟ رد بـ "نعم" أو "لا"

📖 إذا أرسل المستخدم "نعم" أو "اشرح" أو "شرح" أو "أيوه" أو "ايوه"، اشرح المواد اللي ذكرتها بالرد السابق بأسلوب مبسط وواضح، بدون علامات Markdown. استخدم النقاط (•) والرموز (✅) عند الحاجة.`;

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

    // استخدام Haiku مع Prompt Caching للنصوص القانونية
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
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

    const reply = response.content[0].text;
    conversationHistory[from].push({ role: 'assistant', content: reply });

    // الاحتفاظ بآخر 10 رسائل فقط
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
