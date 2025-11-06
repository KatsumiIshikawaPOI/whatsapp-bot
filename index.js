import 'dotenv/config';
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import line from "@line/bot-sdk";

const app = express();

/* =========================
   1) LINE: 署名検証のため raw(JSON) を最優先で適用
   ========================= */
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
};
const lineClient = new line.Client(lineConfig);

// LINE Webhook は raw → line.middleware → ハンドラ の順で 1 本にまとめる
app.post("/line-webhook",
  express.raw({ type: "application/json" }),
  (req, res, next) => line.middleware(lineConfig)(req, res, next),
  async (req, res) => {
    res.status(200).end();            // 先にACK
    let body;
    try {
      // raw を JSON へ（line.middlewareが既にパースした環境でも events を拾えるように両対応）
      body = req.body?.events ? req.body : JSON.parse(req.body.toString("utf8"));
    } catch {
      body = req.body || {};
    }

    const events = body.events || [];
    for (const ev of events) {
      try {
        // テキスト/画像以外は無視
        if (ev.type !== "message") continue;

        // 1:1 かどうか
        const is1on1 = ev.source?.type === "user";

        if (ev.message.type === "text") {
          const userText = (ev.message.text || "").trim();

          // --- グループでは「K 〜」呼びかけがある時だけ応答（@メンションはLINE仕様で不可）
          const calledK =
            /^ *[KＫｋk][\s　]/.test(userText) ||
            userText.includes(" K ") || userText.includes("Ｋ ");

          if (!is1on1 && !calledK) {
            console.log("（スルー）呼びかけなし:", userText);
            continue;
          }

          // 先頭の「K 」を取り除いてクリーンに
          const cleanText = userText.replace(/^ *[KＫｋk][\s　]/, "").trim();

          // --- エクセル支援モード： 例）「excel: 」で始める
          if (/^excel[:：]/i.test(cleanText) || /^エクセル[:：]/.test(cleanText)) {
            const payload = cleanText.replace(/^excel[:：]/i, "").replace(/^エクセル[:：]/, "").trim();
            const help = (
              "以下の形式で貼ると CSV を返します👇\n" +
              "1行目：列名（例）Date,Delivery,Credit,Cash,Total,Diff,Mark\n" +
              "2行目以降：値（カンマ区切り）\n\n" +
              "例：\n" +
              "Date,Delivery,Credit,Cash,Total,Diff,Mark\n" +
              "2025-09-21,934,1790,205,2929,-,ok\n" +
              "2025-09-22,1870,1698,554,3822,-,ok"
            );
            if (!payload) {
              await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: help }]);
              continue;
            }
            // そのまま CSV として返す（ユーザーはコピペでExcel貼付け可能）
            const csv = payload;
            await lineClient.replyMessage(ev.replyToken, [
              { type: "text", text: "CSV を返します。Excel に貼り付けてお使いください👇" },
              { type: "text", text: "```csv\n" + csv + "\n```" }
            ]);
            continue;
          }

          // --- 通常GPT応答（テキスト）
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
          await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: answer }]);
          console.log("✅ LINE返信:", answer);
        }

        // --- 画像（Vision）
        else if (ev.message.type === "image") {
          console.log("🖼️ 画像を受信。解析開始…");
          // 画像バイナリを取得
          const stream = await lineClient.getMessageContent(ev.message.id);
          const chunks = [];
          for await (const c of stream) chunks.push(c);
          const buffer = Buffer.concat(chunks);

          // Vision で解析
          const aiClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            organization: process.env.OPENAI_ORG,
            project: process.env.OPENAI_PROJECT
          });

          const vision = await aiClient.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are an AI assistant named K. Describe or interpret the image briefly in Japanese." },
              {
                role: "user",
                content: [
                  { type: "text", text: "この画像の内容を簡潔に説明してください。" },
                  { type: "image_url", image_url: "data:image/jpeg;base64," + buffer.toString("base64") }
                ]
              }
            ]
          });

          const desc = vision.choices[0].message.content || "画像を確認しました。";
          await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: desc }]);
          console.log("✅ 画像解析完了:", desc);
        }

      } catch (e) {
        console.error("❌ LINE処理エラー:", e?.message || e);
      }
    }
  }
);

/* =========================
   2) それ以外（WhatsApp等）は通常JSONで受ける
   ========================= */
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Twilio & OpenAI（共用）
const tw = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG,
  project: process.env.OPENAI_PROJECT
});

// WhatsApp: 常に返信
app.post("/whatsapp", async (req, res) => {
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
      from: "whatsapp:+15558495973",  // ← あなたのTwilio Business番号
      to: from,
      body: reply
    });
    console.log("✅ WhatsApp返信:", reply);
  } catch (e) {
    console.error("❌ WhatsAppエラー:", e.message);
  }
});

// 起動
app.listen(3000, () => console.log("🚀 Kサーバー起動完了（ポート3000）"));
