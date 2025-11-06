import 'dotenv/config';
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import line from "@line/bot-sdk";
import fs from "fs";

const app = express();

// ===== LINE専用: 署名検証エラー防止 =====
app.use("/line-webhook", express.raw({ type: "application/json" }));

// ===== WhatsAppなど他ルートでは通常のJSONを使う =====
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ===== Twilio & OpenAI設定 =====
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
  res.status(200).end(); // ACK 返して即応答
  for (const ev of req.body.events) {
    try {
      // ✅ テキストメッセージ
      if (ev.type === "message" && ev.message.type === "text") {
        const userText = ev.message.text;
        console.log("📩 LINE受信:", userText);

        const gpt = await ai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are K, an assistant for Japan Village Restaurant & SPA in Qatar. Reply in Japanese if the user speaks Japanese." },
            { role: "user", content: userText }
          ]
        });

        const answer = gpt.choices[0].message.content || "了解しました。";
        await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: answer }]);
        console.log("✅ LINE返信:", answer);
      }

      // ✅ 画像メッセージ（Vision API対応）
      else if (ev.type === "message" && ev.message.type === "image") {
        console.log("🖼️ 画像を受信しました。解析中...");
        const stream = await lineClient.getMessageContent(ev.message.id);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);

        // OpenAI Visionで解析
        const gpt = await ai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are an AI assistant named K. Describe or interpret the image helpfully and briefly in Japanese." },
            {
              role: "user",
              content: [
                { type: "text", text: "この画像を説明してください。" },
                { type: "image_url", image_url: "data:image/jpeg;base64," + buffer.toString("base64") }
              ]
            }
          ]
        });

        const result = gpt.choices[0].message.content || "画像を確認しました。";
        await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: result }]);
        console.log("✅ 画像解析完了:", result);
      }

      // ✅ グループ参加時メッセージ
      else if (ev.type === "join") {
        await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: "Kです。よろしくお願いします！"}]);
      }

    } catch (e) {
      console.error("❌ LINE処理エラー:", e?.message || e);
    }
  }
});

// ===== WhatsApp Webhook =====
app.post("/whatsapp", async (req, res) => {
  res.status(200).send("OK");
  console.log("📩 WhatsApp受信:", req.body);
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
    console.log("✅ WhatsApp返信:", reply);
  } catch (e) {
    console.error("❌ WhatsAppエラー:", e.message);
  }
});

// ===== サーバー起動 =====
app.listen(3000, () => console.log("🚀 Kサーバー起動完了（ポート3000）"));
