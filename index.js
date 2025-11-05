import 'dotenv/config';
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ===== Twilio & OpenAI 設定 =====
const tw = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG,
  project: process.env.OPENAI_PROJECT
});

// ===== WhatsAppからメッセージを受け取る部分 =====
app.post("/whatsapp", async (req, res) => {
  console.log("📩 WhatsApp受信:", req.body);
  res.status(200).send("OK"); // Twilioへの即レス（タイムアウト防止）

  const userMessage = req.body.Body || "";
  const from = req.body.From;

  try {
    // ChatGPT APIへ送信
    const gpt = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are K, an assistant for Japan Village Restaurant and SPA in Qatar. Respond politely and concisely in Japanese when user writes in Japanese." },
        { role: "user", content: userMessage }
      ]
    });

    const reply = gpt.choices[0].message.content;

    // WhatsAppへ返信
    await tw.messages.create({
      from: "whatsapp:+14155238886", // Twilio Sandbox番号
      to: from,
      body: reply
    });

    console.log("✅ Kの返答:", reply);
  } catch (e) {
    console.error("❌ エラー:", e.message);
  }
});

app.listen(3000, () => console.log("🚀 Kサーバー起動完了（ポート3000）"));
