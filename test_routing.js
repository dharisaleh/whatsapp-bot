// سكربت اختبار: يقارن التوجيه الحالي مقابل المحسّن على أسئلة حقيقية.
// يطبع: المصادر المختارة، التوكن، والإجابتين جنب بعض للحكم على الجودة.
// التشغيل:  node test_routing.js
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4 });
const MODEL = 'claude-sonnet-4-6';

// ===== تحميل المصادر (نفس منطق index.js) =====
const sectionsData = JSON.parse(fs.readFileSync('sections.json', 'utf8'));
const sectionsContent = {}, sectionTitleById = {};
let allLawText = '';
for (const s of sectionsData.sections) {
  const c = fs.readFileSync(s.file, 'utf8');
  sectionsContent[s.id] = c;
  sectionTitleById[s.id] = s.title;
  allLawText += `\n\n========== ${s.title} ==========\n\n${c}`;
}
const VALID = sectionsData.sections.map(s => s.id);
const sectionsIndex = sectionsData.sections
  .map(s => `- ${s.id}: ${s.title}\n  ${s.description}`).join('\n\n');

// استخراج البرومبتات الحقيقية من index.js (تبقى متزامنة)
const src = fs.readFileSync('index.js', 'utf8');
const SYSTEM_INSTRUCTIONS = src.match(/const SYSTEM_INSTRUCTIONS = `([\s\S]*?)`;/)[1];
const CURRENT_ROUTER = src.match(/const ROUTER_INSTRUCTIONS = `([\s\S]*?)`;/)[1];

// ===== الراوتر المحسّن =====
const IMPROVED_ROUTER = `أنت موجّه ذكي لبوت قانوني. مهمتك تحديد المصادر المتعلقة بسؤال المستخدم من القائمة التالية فقط:

${sectionsIndex}

القواعد:
- أرجع معرفات (id) المصادر المتعلقة فقط، مفصولة بفاصلة. مثال: labor_law,manpower_responses
- كن دقيقاً ومحدداً: أرجع أقل عدد من المصادر يغطي السؤال. لا ترجع مصدراً إلا إذا له علاقة مباشرة.
- أسئلة الرواتب والمكافآت وأيام العمل والإجازات ونهاية الخدمة → labor_law (وأضف manpower_responses إن كان حساباً).
- ⚠️ decision_46 قرار ملغي — لا ترجعه إطلاقاً إلا إذا ذكر المستخدم صراحةً "القرار 46" أو "القانون الملغي". استخدم decision_196 (الساري) بدلاً منه.
- لو ما قدرت تحدد بثقة، أرجع أقرب 2-3 مصادر محتملة (وليس الكل).
- ممنوع تكتب أي شي ثاني — معرفات فقط، بدون شرح.`;

// ===== الأسئلة الحقيقية =====
const QUESTIONS = [
  'خدمتي 3 سنوات 5 شهور وتم انهاء خدماتي وراتبي 450 دينار كم مكافأة نهاية خدمتي؟',
  'اقدر اسوي اجتماع مجلس ادارة اونلاين؟',
  'شنو الاصناف المعفية من تعاميم اتحاد الجمعيات؟',
  'شنو شروط الترشح؟',
  'شنو اسوي اذا توفي صاحب مكتب تدقيق الحسابات للجمعية؟'
];

const estTok = chars => Math.round(chars / 2);

async function route(instructions, text) {
  const r = await anthropic.messages.create({
    model: MODEL, max_tokens: 60, system: instructions,
    messages: [{ role: 'user', content: text }]
  });
  const raw = (r.content[0]?.text || '').trim();
  if (!raw || raw.toUpperCase().includes('ALL')) return { ids: VALID, fallback: true };
  const ids = raw.split(',').map(s => s.trim()).filter(id => VALID.includes(id));
  return { ids: ids.length ? ids : VALID, fallback: ids.length === 0 };
}

function buildContent(ids) {
  let c = '';
  for (const id of ids) if (sectionsContent[id]) c += `\n\n===== ${sectionTitleById[id]} =====\n\n${sectionsContent[id]}`;
  return c || allLawText;
}

async function answer(content, text) {
  const r = await anthropic.messages.create({
    model: MODEL, max_tokens: 2500,
    system: [
      { type: 'text', text: SYSTEM_INSTRUCTIONS },
      { type: 'text', text: `📚 النصوص القانونية المتاحة:\n\n${content}` }
    ],
    messages: [{ role: 'user', content: text }]
  });
  return { text: r.content[0].text, usage: r.usage };
}

(async () => {
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    console.log('\n' + '='.repeat(80));
    console.log(`السؤال ${i + 1}: ${q}`);
    console.log('='.repeat(80));

    // الحالي
    const curRoute = await route(CURRENT_ROUTER, q);
    const curContent = buildContent(curRoute.ids);
    const curAns = await answer(curContent, q);

    // المحسّن
    const impRoute = await route(IMPROVED_ROUTER, q);
    const impContent = buildContent(impRoute.ids);
    const impAns = await answer(impContent, q);

    console.log(`\n🔴 الحالي  → مصادر: [${curRoute.ids.join(', ')}]${curRoute.fallback ? ' ⚠️ fallback' : ''}`);
    console.log(`   توكن الإدخال الفعلي: ${curAns.usage.input_tokens}`);
    console.log(`\n🟢 المحسّن → مصادر: [${impRoute.ids.join(', ')}]${impRoute.fallback ? ' ⚠️ fallback' : ''}`);
    console.log(`   توكن الإدخال الفعلي: ${impAns.usage.input_tokens}`);
    const save = Math.round((1 - impAns.usage.input_tokens / curAns.usage.input_tokens) * 100);
    console.log(`   💰 التوفير: ${save}%`);

    console.log('\n--- إجابة النظام الحالي ---\n' + curAns.text);
    console.log('\n--- إجابة النظام المحسّن ---\n' + impAns.text);
  }
  console.log('\n' + '='.repeat(80) + '\nانتهى الاختبار.');
})();
