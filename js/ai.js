/**
 * 復習中の「なぜ？」をその場で解決するためのAI連携。
 * キーは端末の localStorage にだけ置き、選んだ提供元へ直接投げる（中継サーバなし＝固定費0）。
 */
import { stripHtml, renderCard } from "./render.js";

/** 今出ているカードから、AIに渡す文脈を作る */
export function buildContext(card, notes, notetypes, decks) {
  const note = notes.get(card.nid);
  const nt = notetypes.get(note.mid);
  const tmpl = nt.templates[Math.min(card.ord, nt.templates.length - 1)] || nt.templates[0];
  const deck = decks.find((d) => d.id === card.did);
  const { question, answer } = renderCard({
    note,
    notetype: nt,
    template: tmpl,
    deckName: deck?.name ?? "",
    ord: card.ord,
  });
  const fields = {};
  nt.fields.forEach((f, i) => {
    const v = stripHtml(note.fields[i] ?? "");
    if (v) fields[f.name] = v;
  });
  return {
    deck: deck?.name ?? "",
    tags: note.tags,
    question: stripHtml(question),
    answer: stripHtml(answer),
    fields,
    lapses: card.lapses ?? 0,
  };
}

export function quickPrompts() {
  return [
    { label: "なぜこの答え？", prompt: "この問題の正答が正しい理由を、根拠から順に説明してください。" },
    { label: "解き方の型", prompt: "この問題を解くときの思考の順番を、次に同じ型が出たら再現できる形で教えてください。" },
    { label: "覚え方", prompt: "この知識を忘れないための覚え方（語呂・対比・関連づけ）を作ってください。" },
    { label: "他の選択肢はなぜ違う", prompt: "誤りの選択肢が、それぞれなぜ誤りなのかを1つずつ説明してください。" },
    { label: "似た問題を出して", prompt: "同じ考え方で解ける類題を1問作り、答えと解説もつけてください。" },
    { label: "もっとやさしく", prompt: "前提知識がない人にも分かるように、噛み砕いて説明してください。" },
  ];
}

function systemPrompt(ctx) {
  return [
    "あなたは教員採用試験の学習を支える講師です。日本語で、簡潔に、根拠を示して答えてください。",
    "断定できないことは推測と明示してください。数式は LaTeX（\\( \\) と \\[ \\]）で書いてください。",
    "",
    "# いま学習者が見ているカード",
    `デッキ: ${ctx.deck}`,
    ctx.tags.length ? `タグ: ${ctx.tags.join(" ")}` : "",
    ctx.lapses > 0 ? `※このカードは過去に ${ctx.lapses} 回まちがえています。つまずきやすい点を重点的に。` : "",
    "",
    "## 問題",
    ctx.question,
    "",
    "## 正答・解説",
    ctx.answer,
  ]
    .filter(Boolean)
    .join("\n");
}

const DEFAULT_MODELS = {
  gemini: "gemini-2.5-flash",
  claude: "claude-sonnet-5",
  openai: "gpt-4o-mini",
};

const MAX_TOKENS = 4000;

/**
 * 上限で切れた応答を黙って返さない。
 * 「途中で切れているのに気づかない」のが一番たちが悪いので、必ず明示する。
 */
function withTruncationNote(text, truncated) {
  if (!text) return "(空の応答)";
  return truncated ? text + "\n\n⚠️ 回答が長すぎて途中で切れました。もう少し絞って聞いてください。" : text;
}

/**
 * AIに質問する。
 * @param {{prompt:string, context:object, settings:{provider:string,key:string,model:string,base:string}}} args
 * @returns {Promise<string>}
 */
export async function askAI({ prompt, context, settings }) {
  const sys = systemPrompt(context);
  const { provider, key } = settings;
  const model = settings.model || DEFAULT_MODELS[provider];

  // 提供元を選んでいるのにキーだけ無い場合、勝手に別のサービスへ飛ばさない。
  // （Gemini を選んだのに Claude が開く、という取り違えを防ぐ）
  if (provider !== "none" && !key) {
    const names = { gemini: "Gemini", claude: "Claude", openai: "OpenAI互換" };
    throw new Error(
      `${names[provider] ?? provider} のAPIキーが未設定です。`
      + `設定 → AI で入れてください（Gemini は無料枠だけで使えます）。`
    );
  }

  if (provider === "none") {
    // 「使わない」を選んだときだけ、外部サイトに質問を持っていく
    const full = `${sys}\n\n# 質問\n${prompt}`;
    const url = "https://claude.ai/new?q=" + encodeURIComponent(full.slice(0, 1200));
    window.open(url, "_blank", "noopener");
    return "外部の Claude を新しいタブで開きました。カードの内容がURLに載る点にご注意ください。";
  }

  if (provider === "gemini") {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sys }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: MAX_TOKENS,
            // Gemini 2.5系は「思考」も同じ出力枠を食うため、切らないと本文が途中で切れる
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    const j = await handle(res);
    const cand = j.candidates?.[0];
    const text = cand?.content?.parts?.map((p) => p.text).join("") ?? "";
    return withTruncationNote(text, cand?.finishReason === "MAX_TOKENS");
  }

  if (provider === "claude") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: sys,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const j = await handle(res);
    const text = j.content?.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "";
    return withTruncationNote(text, j.stop_reason === "max_tokens");
  }

  // OpenAI 互換
  const base = settings.base || "https://api.openai.com/v1";
  const res = await fetch(base.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature: 0.3,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: prompt },
      ],
    }),
  });
  const j = await handle(res);
  const choice = j.choices?.[0];
  return withTruncationNote(choice?.message?.content ?? "", choice?.finish_reason === "length");
}

async function handle(res) {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429) {
      // 無料枠は「1分あたり」と「1日あたり」の両方に上限がある。前者なら少し待てば戻る。
      throw new Error(
        "無料枠の上限に達しました（429）。数分待つと戻ることが多いです。"
        + "1日の上限なら、設定のモデルに gemini-2.5-flash-lite と入れると多く使えます。"
      );
    }
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}
