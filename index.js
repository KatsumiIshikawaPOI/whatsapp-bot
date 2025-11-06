import 'dotenv/config';
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import line from "@line/bot-sdk";

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

// ===== LINE設定 =====
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
};
const lineClient = new line.Client(lineConfig);

// 半角/全角のKをどちらも検出できるように正規化
const normalizeK = (s="") =>
  s.replace(/Ｋ/g, "K").replace(/ｋ/g, "k");


// ============================================================
// LINE Webhook: 1対1は常に返信 / グループは「KKK」or「K 呼びかけ」で返信
// ============================================================
app.post("/line-webhook", line.middleware(lineConfig), async (req, res) => {
  res.status(200).end(); // 先にACK

  for (const ev of req.body.events) {
    try {
      if (ev.type !== "message" || ev.message.type !== "text") continue;

      const rawText = (ev.message.text || "").trim();
      const userText = rawText;                 // 表示用
      const normText = normalizeK(rawText);     // 判定用（全角→半角）

      // 1対1なら常に返信
      const is1on1 = ev.source.type === "user";

      // トリガー判定：
      // A) 先頭が「K 」呼びかけ
      const calledK = /^ *[Kk][\s　]/.test(normText);
      // B) 文中に「KKK」が含まれる（大文字小文字区別なし、全角対応）
      const hasKKK  = /kkk/i.test(normText);

      // グループ/ルームでは上記トリガーが無ければスルー
      if (!is1on1 && !(calledK || hasKKK)) {
        console.log("（スルー）トリガーなし:", userText);
        continue;
      }

      // 「K 呼びかけ」で始まる場合は先頭のKと空白を削って送る
      const cleanText = calledK ? normText.replace(/^ *[Kk][\s　]/, "").trim() : normText;

      // === ChatGPTへ ===
      const gpt = await ai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are K, reply concisely in Japanese when the user writes in Japanese. Be helpful for restaurant/spa operations."
          },
          { role: "user", content: cleanText }
        ]
      });

      const answer = gpt.choices[0].message.content || "了解です。";

      await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: answer }]);
      console.log("✅ LINE返信:", answer);

    } catch (e) {
      console.error("❌ LINEエラー:", e?.message || e);
    }
  }
});


// ============================================================
// WhatsApp Webhook（従来どおり常に返信）
// ============================================================
app.post("/whatsapp", async (req, res) => {
  console.log("📩 WhatsApp受信:", req.body);
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
