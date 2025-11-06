import 'dotenv/config';
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import line from "@line/bot-sdk";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
app.use("/line-webhook", express.raw({ type: "application/json" })); // LINE署名用
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ===== Twilio & OpenAI 設定 =====
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

// ===== LINE Webhook =====
app.post("/line-webhook", line.middleware(lineConfig), async (req, res) => {
  res.status(200).end();
  for (const ev of req.body.events) {
    try {
      // 📩 テキストメッセージ
      if (ev.type === "message" && ev.message.type === "text") {
        const userText = ev.message.text;
        const gpt = await ai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are K, a friendly AI assistant for a restaurant/spa business in Qatar. Reply in Japanese when the user speaks Japanese." },
            { role: "user", content: userText }
          ]
        });
        const answer = gpt.choices[0].message.content || "了解です。";
        await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: answer }]);
        console.log("✅ LINEテキスト返信:", answer);
      }

      // 🖼️ 画像メッセージ
      else if (ev.type === "message" && ev.message.type === "image") {
        const messageId = ev.message.id;
        const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

        const resImage = await fetch(url, {
          headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
        });

        const buffer = Buffer.from(await resImage.arrayBuffer());
        fs.writeFileSync("/tmp/upload.jpg", buffer);
        console.log("🖼️ 画像を受信。解析開始...");

        // OpenAIのVision APIで画像を解析
        const visionRes = await ai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "この画像を分析して内容を説明してください。" },
                { type: "image_url", image_url: "data:image/jpeg;base64," + buffer.toString("base64") }
              ]
            }
          ]
        });

        const description = visionRes.choices[0].message.content || "画像を読み取れませんでした。";
        await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: description }]);
        console.log("✅ 画像解析完了:", description);
      }
    } catch (e) {
      console.error("❌ LINE処理エラー:", e?.message || e);
    }
  }
});

// ===== WhatsApp =====
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
