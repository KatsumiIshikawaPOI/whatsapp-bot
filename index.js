import 'dotenv/config';
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import line from "@line/bot-sdk";

const app = express();

// =====================
// 1) LINE: raw body を最優先にマウント
// =====================
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
};
const lineClient = new line.Client(lineConfig);

// LINE は raw(JSON) を要求。ここで raw を適用し、直後に line.middleware を差し込む。
app.post("/line-webhook",
  express.raw({ type: "application/json" }),
  line.middleware(lineConfig),
  async (req, res) => {
    res.status(200).end(); // 先にACK

    // raw適用後、req.body は Buffer。line.middleware が parse 済みの内容は req.body.events にある
    let parsed;
    try {
      parsed = JSON.parse(req.body.toString("utf8"));
    } catch {
      // line.middleware がパース済みなら ev は req.body.events にある
      parsed = req.body;
    }

    const events = parsed?.events || [];
    for (const ev of events) {
      try {
        if (ev.type !== "message" || ev.message.type !== "text") continue;

        const userText = (ev.message.text || "").trim();
        const is1on1 = ev.source.type === "user";

        // 文頭の「K 」または文中の " K "/ "Ｋ " を検知
        const calledK =
          /^ *[KＫｋk][\s　]/.test(userText) ||
          userText.includes(" K ") ||
          userText.includes("Ｋ ");

        if (!is1on1 && !calledK) {
          console.log("（スルー）呼びかけなし:", userText);
          continue;
        }

        const cleanText = userText.replace(/^ *[KＫｋk][\s　]/, "").trim();

        const gpt = await new OpenAI({
          apiKey: process.env.OPENAI_API_KEY,
          organization: process.env.OPENAI_ORG,
          project: process.env.OPENAI_PROJECT
        }).chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system",
              content:
                "You are K, reply concisely in Japanese when the user writes in Japanese. Be helpful for restaurant/spa operations."
            },
            { role: "user", content: cleanText || userText }
          ]
        });

        const answer = gpt.choices[0].message.content || "了解です。";
        await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: answer }]);
        console.log("✅ LINE返信:", answer);
      } catch (e) {
        console.error("❌ LINEエラー:", e?.message || e);
      }
    }
  }
);

// =====================
// 2) それ以外（WhatsApp等）には通常の JSON/URLENCODED を適用
// =====================
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Twilio & OpenAI (共用)
const tw = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG,
  project: process.env.OPENAI_PROJECT
});

// =====================
// WhatsApp Webhook: 常に返信
// =====================
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
      from: "whatsapp:+15558495973", // ← あなたのTwilio Business番号
      to: from,
      body: reply
    });

    console.log("✅ Kの返信:", reply);
  } catch (e) {
    console.error("❌ WhatsAppエラー:", e.message);
  }
});

app.listen(3000, () => console.log("🚀 Kサーバー起動完了（ポート3000）"));
