import 'dotenv/config';
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import line from "@line/bot-sdk";

const app = express();

/* ===== LINE: 署名検証を通すため raw(JSON) 優先 ===== */
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
};
const lineClient = new line.Client(lineConfig);

// LINE Webhook
app.post(
  "/line-webhook",
  express.raw({ type: "application/json" }),
  (req, res, next) => line.middleware(lineConfig)(req, res, next),
  async (req, res) => {
    res.status(200).end(); // ACK
    let body;
    try {
      body = req.body?.events ? req.body : JSON.parse(req.body.toString("utf8"));
    } catch {
      body = req.body || {};
    }

    const events = body.events || [];
    for (const ev of events) {
      try {
        if (ev.type !== "message") continue;

        const is1on1 = ev.source?.type === "user";
        const userText = ev.message.type === "text" ? ev.message.text.trim() : "";

        /* === グループ内では「K 」呼びかけ時のみ反応 === */
        const calledK =
          /^ *[KＫｋk][\s　]/.test(userText) ||
          userText.includes(" K ") ||
          userText.includes("Ｋ ");

        if (!is1on1 && !calledK && ev.message.type === "text") {
          console.log("（スルー）呼びかけなし:", userText);
          continue;
        }

        // 先頭のKを削除
        const cleanText = userText.replace(/^ *[KＫｋk][\s　]/, "").trim();

        // === 画像処理 ===
        if (ev.message.type === "image") {
          console.log("🖼️ 画像を受信。解析開始...");
          const stream = await lineClient.getMessageContent(ev.message.id);
          const chunks = [];
          for await (const c of stream) chunks.push(c);
          const buffer = Buffer.concat(chunks);

          const aiClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            organization: process.env.OPENAI_ORG,
            project: process.env.OPENAI_PROJECT
          });

          const vision = await aiClient.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content:
                  "You are an AI assistant named K. Describe or interpret the image briefly in Japanese."
              },
              {
                role: "user",
                content: [
                  { type: "text", text: "この画像の内容を簡潔に説明してください。" },
                  {
                    type: "image_url",
                    image_url: "data:image/jpeg;base64," + buffer.toString("base64")
                  }
                ]
              }
            ]
          });

          const desc = vision.choices[0].message.content || "画像を確認しました。";
          await lineClient.replyMessage(ev.replyToken, [
            { type: "text", text: desc }
          ]);
          console.log("✅ 画像解析完了:", desc);
          continue;
        }

        // === テキストモード ===
        if (ev.message.type === "text") {
          // Excel支援モード
          if (/^excel[:：]/i.test(cleanText) || /^エクセル[:：]/.test(cleanText)) {
            const payload = cleanText
              .replace(/^excel[:：]/i, "")
              .replace(/^エクセル[:：]/, "")
              .trim();
            const help =
              "以下の形式で貼るとCSVを返します👇\n" +
              "1行目：列名（例）Date,Delivery,Credit,Cash,Total,Diff,Mark\n" +
              "2行目以降：値（カンマ区切り）\n\n" +
              "例：\n" +
              "Date,Delivery,Credit,Cash,Total,Diff,Mark\n" +
              "2025-09-21,934,1790,205,2929,-,ok";
            if (!payload) {
              await lineClient.replyMessage(ev.replyToken, [
                { type: "text", text: help }
              ]);
              continue;
            }
            const csv = payload;
            await lineClient.replyMessage(ev.replyToken, [
              {
                type: "text",
                text: "CSVを返します。Excelに貼り付けてお使いください👇"
              },
              { type: "text", text: "```csv\n" + csv + "\n```" }
            ]);
            continue;
          }

          // 通常GPT応答
          const aiClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            organization: process.env.OPENAI_ORG,
            project: process.env.OPENAI_PROJECT
          });

          const gpt = await aiClient.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content:
                  "You are K, an assistant for Japan Village Restaurant & SPA in Qatar. " +
                  "Reply concisely in Japanese if the user writes in Japanese."
              },
              { role: "user", content: cleanText || userText }
            ]
          });

          const answer = gpt.choices[0].message.content || "了解です。";
          await lineClient.replyMessage(ev.replyToken, [
            { type: "text", text: answer }
          ]);
          console.log("✅ LINE返信:", answer);
        }
      } catch (e) {
        console.error("❌ LINE処理エラー:", e?.message || e);
      }
    }
  }
);

/* ===== WhatsApp設定 ===== */
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const tw = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG,
  project: process.env.OPENAI_PROJECT
});

app.post("/whatsapp", async (req, res) => {
  res.status(200).send("OK");
  const userMessage = req.body.Body || "";
  const from = req.body.From;

  try {
    const gpt = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are K, an assistant for Japan Village Restaurant & SPA in Qatar."
        },
        { role: "user", content: userMessage }
      ]
    });

    const reply = gpt.choices[0].message.content;
    await tw.messages.create({
      from: "whatsapp:+15558495973", // Twilio番号
      to: from,
      body: reply
    });
    console.log("✅ WhatsApp返信:", reply);
  } catch (e) {
    console.error("❌ WhatsAppエラー:", e.message);
  }
});

/* ===== サーバー起動 ===== */
app.listen(3000, () => console.log("🚀 Kサーバー起動完了（ポート3000）"));
