import 'dotenv/config';
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import line from "@line/bot-sdk";
import fetch from "node-fetch";
import fs from "fs";
import * as XLSX from "xlsx";

const app = express();

/* ===== 公開URL（RenderのURLを既定値に） ===== */
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://k-whatsapp-bot.onrender.com";

/* ===== LINE 署名検証用に raw(JSON) を最優先で適用 ===== */
app.use("/line-webhook", express.raw({ type: "application/json" }));

/* ===== そのほかのルート用 ===== */
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/* ===== Twilio & OpenAI 設定 ===== */
const tw = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG,
  project: process.env.OPENAI_PROJECT,
});

/* ===== LINE 設定 ===== */
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const lineClient = new line.Client(lineConfig);

/* -------------------------------------------------
   1) Excelダウンロード用ルート
   ------------------------------------------------- */
app.get("/files/:name", (req, res) => {
  const name = (req.params.name || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  const p = `/tmp/${name}`;
  if (fs.existsSync(p)) {
    return res.download(p, name); // attachment
  }
  return res.status(404).send("Not found");
});

/* -------------------------------------------------
   2) LINE Webhook
   ------------------------------------------------- */
// ★ 追加：直近の指示を記憶する“武装モード（90秒有効）”
const armedMap = new Map(); // key: sourceKey, value: { armed: true, expires: epoch_ms }
const ARM_WINDOW_MS = 90 * 1000;

// sourceキー（グループ/ルーム/個チャで一意）
function sourceKey(ev) {
  if (ev.source?.type === "group") return `group:${ev.source.groupId}`;
  if (ev.source?.type === "room")  return `room:${ev.source.roomId}`;
  return `user:${ev.source.userId}`;
}

// 指示トリガー（K + 空白…に続いて画像/表/解析/エクセル）
function isImageCommand(text) {
  const t = (text || "").trim();
  // 先頭K（半/全角OK）＋空白（半/全角OK）のあとにトリガー語
  return /^[\s　]*[KＫｋk][\s　]+/.test(t) &&
         /(画像|写真|解析|表|エクセル|excel|ocr)/i.test(t);
}

// ===== LINE Webhook =====
app.post("/line-webhook", line.middleware(lineConfig), async (req, res) => {
  res.status(200).end();
  let body;
  try { body = req.body?.events ? req.body : JSON.parse(req.body.toString("utf8")); }
  catch { body = req.body || {}; }
  const events = body.events || [];

  for (const ev of events) {
    try {
      const sk = sourceKey(ev);
      const now = Date.now();

      // ---- テキスト受信 -----------------------------------------------------
      if (ev.type === "message" && ev.message.type === "text") {
        const userText = (ev.message.text || "").trim();
        const is1on1 = ev.source?.type === "user";
        const calledK = /^[\s　]*[KＫｋk][\s　]+/.test(userText);

        // グループでは呼びかけ必須（1対1は自由）
        if (!is1on1 && !calledK) {
          console.log("（スルー）呼びかけなし:", userText);
          continue;
        }

        // ★ 画像関連の指示なら“武装モード”にして案内（90秒以内の次の画像だけ処理）
        if (isImageCommand(userText)) {
          armedMap.set(sk, { armed: true, expires: now + ARM_WINDOW_MS });
          await lineClient.replyMessage(ev.replyToken, [
            { type: "text", text: "了解です。90秒以内に画像を送ってください。画像の表をExcelに変換します📊" }
          ]);
          console.log("🔔 Armed ON:", sk);
          continue;
        }

        // それ以外の通常テキストは従来どおりGPT応答
        const gpt = await ai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are K, a polite Japanese assistant for restaurant/spa operations in Qatar." },
            { role: "user", content: calledK ? userText.replace(/^[\s　]*[KＫｋk][\s　]+/, "").trim() : userText }
          ]
        });
        const answer = gpt.choices[0].message.content || "了解です。";
        await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: answer }]);
        console.log("✅ LINEテキスト返信:", answer);
        continue;
      }

      // ---- 画像受信 ---------------------------------------------------------
      if (ev.type === "message" && ev.message.type === "image") {
        // 有効な武装モードかチェック
        const state = armedMap.get(sk);
        if (!state || !state.armed || state.expires < now) {
          console.log("（スルー）武装モードOFFのため画像無視:", sk);
          continue; // ★ ここで無視（＝呼ばれてない画像には反応しない）
        }
        // 使い切りにする
        armedMap.delete(sk);

        console.log("🖼️ 画像を受信（armed許可）→ 解析開始...");
        const messageId = ev.message.id;
        const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

        const resImg = await fetch(url, { headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } });
        const buffer = Buffer.from(await resImg.arrayBuffer());

        // Visionで表データのJSON抽出
        const base64Image = buffer.toString("base64");
        const vision = await ai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "この画像の表をJSON配列で抽出してください。各要素は date, delivery, credit, cash, total, diff, mark のキーを持ちます。JSON以外の説明は省いてください。" },
                { type: "image_url", image_url: { url: "data:image/jpeg;base64," + base64Image } }
              ]
            }
          ]
        });

        const rawText = vision.choices[0].message.content || "";
        console.log("📊 OCR結果（生）:", rawText.slice(0, 200) + (rawText.length > 200 ? "..." : ""));
        const cleanJson = rawText
          .replace(/```json/gi, "").replace(/```/g, "")
          .replace(/^[^{\[]*/s, "").replace(/[^\]}]*$/s, "").trim();

        // JSON→Excel→URL返信（既存のExcel作成コードそのまま流用）
        try {
          const data = JSON.parse(cleanJson);
          if (!Array.isArray(data)) throw new Error("JSON配列ではありません");

          const ws = XLSX.utils.json_to_sheet(data);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "Sheet1");

          const ts = Date.now();
          const fileName = `output_${ts}.xlsx`;
          const filePath = `/tmp/${fileName}`;
          XLSX.writeFile(wb, filePath);

          const dlUrl = `${PUBLIC_BASE_URL}/files/${fileName}`;
          await lineClient.replyMessage(ev.replyToken, [
            { type: "text", text: "✅ 画像の表をExcelに変換しました。ダウンロードはこちら👇" },
            { type: "text", text: dlUrl }
          ]);
          console.log("✅ Excel生成完了:", filePath, "URL:", dlUrl);
        } catch (e) {
          console.error("❌ Excel出力エラー:", e.message);
          await lineClient.replyMessage(ev.replyToken, [
            { type: "text", text: "Excel変換でエラーが発生しました。もう一度、はっきり写る写真でお試しください。" }
          ]);
        }
        continue;
      }

    } catch (e) {
      console.error("❌ LINE処理エラー:", e?.message || e);
    }
  }
});
 /* ===== テキスト ===== */
if (ev.message.type === "text") {
  const userText = (ev.message.text || "").trim();
  const is1on1 = ev.source?.type === "user"; // 個チャ or グループ

  // グループでは「K + 空白（半/全角OK）」で始まる時だけ反応
  const calledK = /^[\s　]*[KＫｋk][\s　]+/.test(userText);

  if (!is1on1 && !calledK) {
    console.log("（スルー）呼びかけなし:", userText);
    continue;
  }

  const cleanText = userText.replace(/^[\s　]*[KＫｋk][\s　]+/, "").trim();

  const gpt = await ai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are K, a polite Japanese assistant for restaurant/spa operations in Qatar." },
      { role: "user", content: cleanText || userText }
    ]
  });

  const answer = gpt.choices[0].message.content || "了解です。";
  await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: answer }]);
  console.log("✅ LINEテキスト返信:", answer);
}
  const answer = gpt.choices[0].message.content || "了解です。";
  await lineClient.replyMessage(ev.replyToken, [{ type: "text", text: answer }]);
  console.log("✅ LINEテキスト返信:", answer);
}
      /* ===== 画像 → OCR → Excel生成 → ダウンロードURL返信 ===== */
      else if (ev.message.type === "image") {
        console.log("🖼️ 画像メッセージを受信しました");
        const messageId = ev.message.id;
        const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

        // 画像バイナリ取得
        const resImg = await fetch(url, {
          headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
        });
        const buffer = Buffer.from(await resImg.arrayBuffer());

        // Visionで表データをJSONに抽出
        const base64Image = buffer.toString("base64");
        const vision = await ai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "この画像の表をJSON配列で抽出してください。各要素は date, delivery, credit, cash, total, diff, mark のキーを持ちます。JSON以外の説明文は付けずに返してください。" },
                { type: "image_url", image_url: { url: "data:image/jpeg;base64," + base64Image } }
              ]
            }
          ]
        });

        const rawText = vision.choices[0].message.content || "";
        console.log("📊 OCR結果（生）:", rawText.slice(0, 300) + (rawText.length > 300 ? "..." : ""));

        // GPTの返すJSON前後に説明が混ざるケースに備えてクリーンアップ
        const cleanJson = rawText
          .replace(/```json/gi, "")
          .replace(/```/g, "")
          .replace(/^[^{\[]*/s, "")
          .replace(/[^\]}]*$/s, "")
          .trim();

        try {
          const data = JSON.parse(cleanJson); // ← ここで配列にパース
          if (!Array.isArray(data)) throw new Error("JSON配列ではありません");

          // Excel生成
          const ws = XLSX.utils.json_to_sheet(data);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "Sheet1");

          const ts = Date.now();
          const fileName = `output_${ts}.xlsx`;
          const filePath = `/tmp/${fileName}`;
          XLSX.writeFile(wb, filePath);

          const dlUrl = `${PUBLIC_BASE_URL}/files/${fileName}`;

          // LINEへダウンロードURL返信
          await lineClient.replyMessage(ev.replyToken, [
            { type: "text", text: "✅ 画像の表をExcelに変換しました。ダウンロードはこちら👇" },
            { type: "text", text: dlUrl }
          ]);

          console.log("✅ Excel生成完了:", filePath, "URL:", dlUrl);
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

/* -------------------------------------------------
   3) WhatsApp（通常GPT応答）
   ------------------------------------------------- */
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

/* -------------------------------------------------
   4) 起動
   ------------------------------------------------- */
app.listen(3000, () => console.log("🚀 Kサーバー起動完了（ポート3000）"));
