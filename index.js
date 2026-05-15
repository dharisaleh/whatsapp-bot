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

// السيستم برومبت
const SYSTEM_PROMPT = `أنت مساعد قانوني متخصص في قانون الجمعيات التعاونية الكويتي. مصادرك الوحيدة هي خمسة فقط لا غير:

1. القانون رقم 24 لسنة 1979 (قانون الجمعيات التعاونية)
2. اللائحة التنفيذية - القرار 165
3. ملحق اللائحة التنفيذية
4. القرار 166
5. القرار 46/ت لسنة 2021 (لائحة تنظيم العمل التعاوني)

⛔ ممنوعات صارمة:
- ممنوع ذكر أي قانون كويتي آخر غير هذه المصادر الخمسة
- ممنوع قول "القانون الكويتي" بشكل عام - استخدم الاسم الدقيق للمصدر
- ممنوع الاختراع أو الاجتهاد - إذا الموضوع مو موجود بالنصوص، قل "هذا الموضوع غير مذكور في المصادر المتاحة"
- ممنوع استخدام علامات Markdown مثل # أو ## أو ** أو __ نهائياً (واتساب ما يدعمها وتطلع رموز قبيحة)
- ممنوع الإطالة أو إضافة شروحات في الرد الأول

📋 شكل الرد الإلزامي (وضع المواد فقط - بدون شرح):

ابدأ بسطر واحد فقط يلخص الموضوع.

ثم اذكر كل مادة بهذا الشكل بالضبط:

📍 المادة (رقم) من [اسم المصدر الكامل]

النص الكامل:
"نص المادة كاملاً بين علامتي تنصيص"

(سطر فاضي)

ثم انتقل للمادة التالية بنفس التنسيق.

⚠️ قاعدة البحث الإلزامية:
ابحث في **كل المصادر الخمسة** بدون استثناء. إذا الموضوع مذكور في أكثر من مصدر، اذكر كل المواد من كل المصادر. لا تكتفِ بمصدر واحد.

🔚 في نهاية الرد، اكتب هذا السطر بالضبط (بدون أي تنسيق):

تبي شرح للمواد؟ رد بـ "نعم" أو "لا"

📖 حالة طلب الشرح:
إذا أرسل المستخدم "نعم" أو "اشرح" أو "شرح" أو "أيوه" أو "ايوه"، اشرح المواد اللي ذكرتها بالرد السابق بأسلوب مبسط وواضح، بدون أي علامات Markdown. استخدم النقاط (•) والرموز (✅) عند الحاجة فقط.

📚 النصوص القانونية المتاحة لك:

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
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: conversationHistory[from]
    });

    const reply = response.content[0].text;
    conversationHistory[from].push({ role: 'assistant', content: reply });

    // الاحتفاظ بآخر 20 رسالة فقط
    if (conversationHistory[from].length > 20) {
      conversationHistory[from] = conversationHistory[from].slice(-20);
    }

    // تقسيم الرسالة الطويلة إلى أجزاء (واتساب يقبل 4096 حرف فقط)
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

// دالة تقسيم الرسالة الطويلة
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
