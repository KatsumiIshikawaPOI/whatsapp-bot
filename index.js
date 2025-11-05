import 'dotenv/config';
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import line from "@line/bot-sdk";

const app = express();

// ----------------------------
// Twilio（WhatsApp）設定
// ----------------------------
const tw = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

// ----------------------------
// OpenAI 設定（Kの頭脳）
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG,
  project: process.env.OPENAI_PROJECT
});

// ----------------------------
// LINE設定
// ----------------------------
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const lineClient = new line.Client(lineConfig);

// ============================================================
// LINE Webhook: メンション or 「K 」呼びかけ時のみ返信
// ============================================================
app.post("/line-webhook", line.middleware(lineConfig), async (req, res) => {
  res.status(200).end(); // まずACKを返す

  // BotのuserId（getBotInfoで自動取得 or ENVから）
  let BOT_USER_ID = process.env.LINE_BOT_USER_ID || null;
  try {
    if (!BOT_USER_ID && lineClient.getBotInfo) {
      const info = await lineClient.getBotInfo();
      BOT_USER_ID = info.userId;
      console.log("BOT_USER_ID:", BOT_USER_ID);
    }
  } catch (e) {
    console.log("getBotInfo失敗（ENVのLINE_BOT_USER_IDを使用）");
  }

  for (const ev of req.body.events) {
    try {
      if (ev.type !== "message" || ev.message.type !== "text") continue;

      const userText = (ev.message.text || "").trim();

      // 1対1チャットかどうか
      const is1on1 = ev.source.type === "user";

      // グループ/ルーム時のメンション検出
      const mentionees = ev.message?.mention?.mentionees || [];
      const mentionedMe = BOT_USER_ID
        ? mentionees.some(m => m.userId === BOT_USER_ID)
        : false;

      // 「K 」や「ｋ 」などの呼びかけ検出（半角・全角対応）
      const calledK = /^ *[KＫｋk][\s　]/.test(userText);

      // 条件判定：1対1 または メンション / 呼びかけ の場合のみ返信
      if (!is1on1 && !(mentionedMe || calledK)) {
        console.log("（スルー）メンション/呼びかけなし:", userText);
        continue;
      }

      // GPTへ送るメッセージ（先頭の「K 」は削除）
      const cleanText = userText.replace(/^ *[KＫｋk][\s　]/, "");

      const gpt = await ai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are K, reply concisely in Japanese when the user writes in Japanese. Be helpful for restaurant/spa operations.",
          },
          { role: "user", content: cleanText },
        ],
      });

      const answer = gpt.choices[0].message.content || "了解です。";

      await lineClient.replyMessage(ev.replyToken, [
        { type: "text", text: answer },
      ]);
      console.log("✅ LINEへ返信:", answer);
    } catch (e) {
      console.error("❌ LINE処理エラー:", e?.message || e);
    }
  }
});

// ============================================================
// WhatsApp Webhook: 常に返信
// ============================================================
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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
            "You are K, an assistant for Japan Village Restaurant & SPA in Qatar.",
        },
        { role: "user", content: userMessage },
      ],
    });

    const reply = gpt.choices[0].message.content;

    await tw.messages.create({
      from: "whatsapp:+15558495973", // ← あなたのTwilio Business番号
      to: from,
      body: reply,
    });

    console.log("✅ Kの返信:", reply);
  } catch (e) {
    console.error("❌ WhatsAppエラー:", e.message);
  }
});

// ============================================================
// サーバー起動
// ============================================================
app.listen(3000, () => console.log("🚀 Kサーバー起動完了（ポート3000）"));
