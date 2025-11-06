import 'dotenv/config';
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import line from "@line/bot-sdk";
import fetch from "node-fetch";
import fs from "fs";
import XLSX from "xlsx";

const app = express();
app.use("/line-webhook", express.raw({ type: "application/json" }));
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
      // テキストメッセージ処理
      if (ev.type === "message" && ev.message.type === "text") {
        const userText = ev.message.text;
        const gpt = await ai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are K, a polite Japanese assistant for restaurant/spa operations in Qatar." },
            { role: "user", content: userText }
          ]
        });
        const answer = gpt.choices[0].message.content || "了解です。";
        await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: answer }]);
        console.log("✅ LINE返信:", answer);
      }

      // 画像メッセージ処理
      else if (ev.type === "message" && ev.message.type === "image") {
        console.log("🖼️ 画像メッセージを受信しました");
        const messageId = ev.message.id;
        const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync("/tmp/upload.jpg", buffer);

        const base64Image = buffer.toString("base64");
        const result = await ai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "この表をJSON形式で抽出してください（date, delivery, credit, cash, total, diff, mark）" },
                { type: "image_url", image_url: { url: "data:image/jpeg;base64," + base64Image } }
              ]
            }
          ]
        });

        const rawText = result.choices[0].message.content;
        console.log("📊 OCR結果:", rawText);

        // ===== JSON整形修正（GPT出力の前後をトリミング） =====
        const cleanJson = rawText
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .replace(/^[^{\[]*/, "")
          .replace(/[^{\]]*$/, "")
          .trim();

        try {
          const data = JSON.parse(cleanJson);
          const ws = XLSX.utils.json_to_sheet(data);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
          const filePath = "/tmp/output.xlsx";
          XLSX.writeFile(wb, filePath);

          await lineClient.replyMessage(ev.replyToken, [
            { type: "text", text: "✅ 画像の表をExcelに変換しました。" }
          ]);

          console.log("✅ Excel生成完了:", filePath);
        } catch (e) {
          console.error("❌ Excel出力エラー:", e.message);
          await lineClient.replyMessage(ev.replyToken, [
            { type: "text", text: "Excel変換でエラーが発生しました。もう一度お試しください。" }
          ]);
        }
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
    console.log("✅ WhatsApp返信:", reply);
  } catch (e) {
    console.error("❌ WhatsAppエラー:", e.message);
  }
});

app.listen(3000, () => console.log("🚀 Kサーバー起動完了（ポート3000）"));
