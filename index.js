const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const Anthropic = require('@anthropic-ai/sdk');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const lawText = fs.readFileSync('law.txt', 'utf8');
const userCount = {};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({ auth: state });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update;
    if (qr) {
      console.log('\n\n========== امسح QR Code من واتساب ==========\n');
      qrcode.generate(qr, { small: true });
      console.log('\n=============================================\n\n');
    }
    if (connection === 'open') console.log('✅ البوت متصل بواتساب بنجاح!');
    if (connection === 'close') startBot();
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return;

    userCount[from] = (userCount[from] || 0) + 1;

    if (userCount[from] > 3) {
      await sock.sendMessage(from, { text: 'انتهت أسئلتك المجانية. للاستمرار يرجى الدفع.' });
      return;
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `بناءً على هذا القانون:\n${lawText}\n\nالسؤال: ${text}` }]
    });

    await sock.sendMessage(from, { text: response.content[0].text });
  });
}

startBot();
