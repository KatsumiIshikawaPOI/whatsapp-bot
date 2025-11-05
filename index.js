import 'dotenv/config';
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import line from "@line/bot-sdk";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ===== クライアント類 =====
const tw = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG,
  project: process.env.OPENAI_PROJECT
});

// ===== LINE設定 =====
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
};
const lineClient = new line.Client(lineConfig);

// ===== LINE Webhook: 受信 → GPT → 返信 =====
app.post("/line-webhook", line.middleware(lineConfig), async (req, res) => {
  res.status(200).end(); // 先にACK
  for (const ev of req.body.events) {
    try {
      if (ev.type === "message" && ev.message.type === "text") {
        const userText = ev.message.text;

        const gpt = await ai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are K, reply concisely in Japanese when the user writes in Japanese. Be helpful for restaurant/spa operations." },
            { role: "user", content: userText }
          ]
        });
        const answer = gpt.choices[0].message.content || "了解です。";

        await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: answer }]);
        console.log("✅ LINEへ返信:", answer);
      } else if (ev.type === "join") {
        await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: "Kです。よろしくお願いします！"}]);
      }
    } catch (e) {
      console.error("❌ LINE処理エラー:", e?.message || e);
    }
  }
});

// ===== WhatsAppは今のままでOK =====
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
      from: "whatsapp:+15558495973",
      to: from,
      body: reply
    });
    console.log("✅ Kの返信:", reply);
  } catch (e) {
    console.error("❌ エラー:", e.message);
  }
});

app.listen(3000, () => console.log("🚀 Kサーバー起動完了（ポート3000）"));
