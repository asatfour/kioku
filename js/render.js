/**
 * Anki カードテンプレートの描画。
 *
 * 対応する記法（本家の挙動に合わせた自前実装）:
 *   {{Field}}            フィールド展開
 *   {{#Field}}…{{/Field}} フィールドが空でなければ表示
 *   {{^Field}}…{{/Field}} フィールドが空なら表示
 *   {{FrontSide}}        裏面で表面をそのまま埋め込む
 *   {{text:Field}}       HTMLタグを除いた素のテキスト
 *   {{cloze:Field}}      穴埋め（[[oc1::答え::ヒント]]）
 *   {{type:Field}}       入力欄（表面）／答え合わせ（裏面）
 *   {{Tags}} {{Deck}} {{Card}} {{Type}}  特殊フィールド
 */

const SPECIAL = new Set(["FrontSide", "Tags", "Deck", "Subdeck", "Card", "Type"]);

/** HTMLタグを除去して素のテキストにする */
export function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * フィールドが「空」かどうか。本家の判定に合わせる:
 * 空白と <br> / <div> 系のタグだけで構成されていれば空。
 * ※ <img> だけのフィールドは「中身あり」（図だけのフィールドを条件節で使えるように）
 */
export function fieldIsEmpty(text) {
  return /^(?:\s|<\/?(?:br|div)\s*\/?>)*$/i.test(String(text ?? ""));
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * 穴埋めを展開する。
 * @param {string} text  {{c1::答え}} や {{c1::答え::ヒント}} を含む本文
 * @param {number} ord   0始まりのカード番号（c1 → ord 0）
 * @param {boolean} reveal 答えを見せるか（裏面）
 */
export function renderCloze(text, ord, reveal) {
  const n = ord + 1;
  let out = "";
  let i = 0;
  const src = String(text);
  while (i < src.length) {
    const start = src.indexOf("{{c", i);
    if (start === -1) {
      out += src.slice(i);
      break;
    }
    // {{cN:: ... }} の対応する閉じ括弧を、入れ子を数えながら探す
    const m = /^\{\{c(\d+)::/.exec(src.slice(start));
    if (!m) {
      out += src.slice(i, start + 3);
      i = start + 3;
      continue;
    }
    let depth = 0;
    let j = start;
    let end = -1;
    for (; j < src.length - 1; j++) {
      if (src[j] === "{" && src[j + 1] === "{") depth++;
      else if (src[j] === "}" && src[j + 1] === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, start);
    const inner = src.slice(start + m[0].length, end);
    const [answer, hint] = splitHint(inner);
    const idx = Number(m[1]);
    if (idx === n) {
      out += reveal
        ? `<span class="cloze">${answer}</span>`
        : `<span class="cloze-blank">[${hint || "..."}]</span>`;
    } else {
      out += answer; // 対象外の穴は常に見えている
    }
    i = end + 2;
  }
  return out;
}

function splitHint(inner) {
  const at = inner.lastIndexOf("::");
  if (at === -1) return [inner, null];
  return [inner.slice(0, at), inner.slice(at + 2)];
}

/**
 * テンプレートを描画する。
 * @param {string} tmpl テンプレート文字列（qfmt / afmt）
 * @param {object} ctx  { fields, tags, deckName, cardName, notetypeName, frontSide, ord, isCloze, reveal, typedAnswer }
 */
export function renderTemplate(tmpl, ctx) {
  const value = (name) => {
    if (name === "FrontSide") return ctx.frontSide ?? "";
    if (name === "Tags") return (ctx.tags || []).join(" ");
    if (name === "Deck") return ctx.deckName ?? "";
    if (name === "Subdeck") return String(ctx.deckName ?? "").split("::").pop();
    if (name === "Card") return ctx.cardName ?? "";
    if (name === "Type") return ctx.notetypeName ?? "";
    return ctx.fields[name] ?? "";
  };

  // 1) 条件セクションを先に処理（入れ子も内側から解決される）
  let s = String(tmpl);
  const section = /\{\{([#^])([^}]+)\}\}([\s\S]*?)\{\{\/\2\}\}/;
  for (let guard = 0; guard < 200; guard++) {
    const m = section.exec(s);
    if (!m) break;
    const [whole, kind, rawName, body] = m;
    const name = rawName.trim();
    const filled = !fieldIsEmpty(value(name));
    const keep = kind === "#" ? filled : !filled;
    s = s.slice(0, m.index) + (keep ? body : "") + s.slice(m.index + whole.length);
  }

  // 2) 置換
  s = s.replace(/\{\{([^}]+)\}\}/g, (whole, raw) => {
    const expr = raw.trim();
    const colon = expr.lastIndexOf(":");
    let filters = [];
    let name = expr;
    if (colon !== -1) {
      const parts = expr.split(":");
      name = parts.pop();
      filters = parts;
    }
    if (!SPECIAL.has(name) && !(name in ctx.fields) && filters.length === 0) return whole;

    let v = value(name);
    for (const f of filters) {
      if (f === "text") v = escapeHtml(stripHtml(v));
      else if (f === "cloze") v = renderCloze(v, ctx.ord, ctx.reveal);
      else if (f === "type") {
        v = ctx.reveal ? typeComparison(ctx.typedAnswer ?? "", v) : `<input class="type-answer" autocomplete="off">`;
      } else if (f === "hint") {
        v = v ? `<details class="hint"><summary>ヒント</summary>${v}</details>` : "";
      }
      // 未知のフィルタ（tts: 等）はそのまま値を通す
    }
    return v;
  });

  return s;
}

/** 入力した答えと正解を突き合わせて色付けする */
function typeComparison(typed, correct) {
  const c = stripHtml(correct);
  const t = stripHtml(typed);
  if (t === c) return `<div class="type-ok">${escapeHtml(c)}</div>`;
  return `<div class="type-ng"><div class="typed">${escapeHtml(t) || "（未入力）"}</div><div class="correct">${escapeHtml(c)}</div></div>`;
}

/**
 * カード1枚分の表・裏のHTMLを作る。
 * @returns {{question:string, answer:string}}
 */
export function renderCard({ note, notetype, template, deckName, ord, typedAnswer }) {
  const fields = {};
  notetype.fields.forEach((f, i) => {
    fields[f.name] = note.fields[i] ?? "";
  });
  const base = {
    fields,
    tags: note.tags,
    deckName,
    cardName: template.name,
    notetypeName: notetype.name,
    ord: notetype.isCloze ? ord : 0,
    isCloze: notetype.isCloze,
    typedAnswer,
  };
  const question = renderTemplate(template.qfmt, { ...base, reveal: false, frontSide: "" });
  const answer = renderTemplate(template.afmt, { ...base, reveal: true, frontSide: question });
  return { question, answer };
}

/**
 * ノートから生成すべきカード枚数を返す。
 * 通常ノートタイプ = テンプレート数、穴埋め = 使われている c番号 の数。
 */
export function cardOrdsForNote(note, notetype) {
  if (!notetype.isCloze) {
    return notetype.templates.map((t) => t.ord);
  }
  const text = note.fields.join(" ");
  const ords = new Set();
  for (const m of text.matchAll(/\{\{c(\d+)::/g)) ords.add(Number(m[1]) - 1);
  return ords.size ? [...ords].sort((a, b) => a - b) : [0];
}

/** メディア参照（img src / audio src）をアプリ内のURLに差し替える */
export function resolveMedia(html, urlFor) {
  return String(html).replace(
    /(<(?:img|source|audio|video)\b[^>]*\ssrc=)(["'])(.*?)\2/gi,
    (whole, head, q, src) => {
      if (/^(https?:|data:|blob:)/i.test(src)) return whole;
      const url = urlFor(decodeURIComponent(src));
      return url ? `${head}${q}${url}${q}` : whole;
    }
  );
}
