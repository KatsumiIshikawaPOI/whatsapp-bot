import 'dotenv/config';
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ===== Twilio & OpenAI 設定 =====
const tw = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== LINE Webhook (接続テスト用) =====
app.post("/line-webhook", (req, res) => {
  console.log("✅ LINE Webhookにアクセスあり！", req.body);
  res.status(200).send("OK ✅"); // LINEにHTTP 200を返す（Verify成功用）
});

// ===== WhatsAppメッセージ受信 =====
app.post("/whatsapp", async (req, res) => {
  console.log("📩 WhatsApp受信:", req.body);
  res.status(200).send("OK");

  const userMessage = req.body.Body || "";
  const from = req.body.From;

  try {
    const gpt = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are K, an assistant for Japan Village Restaurant & SPA in Qatar." },
        { role: "user", content: userMessage }
      ]
    });

    const reply = gpt.choices[0].message.content;

    await tw.messages.create({
      from: "whatsapp:+15558495873",
      to: from,
      body: reply
    });

    console.log("✅ Kの返信:", reply);
  } catch (e) {
    console.error("❌ エラー:", e.message);
  }
});

// ===== Renderサーバー起動 =====
app.listen(3000, () => console.log("🚀 Kサーバー起動完了（ポート3000）"));
