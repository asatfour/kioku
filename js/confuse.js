/**
 * 取り違えやすいカードを探す。
 *
 * 「研修」を定めた条文は 地方公務員法なら第三十九条、教育公務員特例法なら第二十一条。
 * 一方だけを覚え直しても、もう一方と混ざっていれば本番でまた迷う。
 * 間違えたカードの答えの横に、問いが似ていて答えが違うカードを並べ、見比べられるようにする。
 *
 * 似ているかどうか: 問いの文字2つ組（bigram）の重なり（Jaccard）。
 *  - デッキの中でありふれた2文字（「第何条か」「この条文は」など決まり文句）は数えない
 *  - 答えが同じ・片方の答えがもう片方の文に含まれる組は「同じことを別の形で聞いているだけ」なので外す
 *  - 出典欄（3つ目の欄）が同じ組も同じ理由で外す
 * 実デッキ（教育法規 1,798枚）で、似ている相手が見つかるのは 169枚（9%）。抜き出して見た14組中13組が
 * 「研修 = 地公法39条／教特法21条」「修業年限 中等教育学校6年／中学校3年」のような本当に紛らわしい組だった。
 *
 * 穴埋め（Cloze）のノートは問いと答えが欄で分かれていないので扱わない。
 */
import { stripHtml } from "./render.js";

const MIN_SIM = 0.5;      // 問いの重なりの下限
const MIN_SHARED = 3;     // 共有する（ありふれていない）2文字組の最低数
const MAX_ANS_SIM = 0.5;  // 答えの重なりの上限（これ以上は同じ答え）
const COMMON_RATE = 0.08; // デッキの8%を超えるノートに出る2文字組は決まり文句とみなす

const norm = (s) => stripHtml(s ?? "").replace(/〔\s*？\s*〕/g, "□").replace(/[\s、。，．・「」『』（）()]/g, "");
function grams(s) {
  const g = new Set();
  for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
  return g;
}

const prepCache = new WeakMap();
/** ノートを比べられる形にする（中身の配列が差し替わったら作り直す） */
function prep(note, notetype) {
  const hit = prepCache.get(note);
  if (hit && hit.f === note.fields) return hit.p;
  let p = null;
  if (notetype?.type !== 1 && note.fields.length >= 2) {
    const q = norm(note.fields[0]);
    const a = norm(note.fields[1]);
    if (q.length >= 4 && a.length >= 1) {
      p = {
        q: grams(q), a: grams(a), core: a.slice(0, 30), full: q + a,
        src: norm((note.fields[2] ?? "").replace(/https?:\/\/[^\s"<]+/g, "")).split("出典")[0],
      };
    }
  }
  prepCache.set(note, { f: note.fields, p });
  return p;
}

const poolCache = new Map(); // 束ねの名前 → { size, common:Set }
function commonGrams(key, preps) {
  const hit = poolCache.get(key);
  if (hit && hit.size === preps.length) return hit.common;
  const df = new Map();
  for (const p of preps) for (const g of p.q) df.set(g, (df.get(g) ?? 0) + 1);
  const cut = Math.max(3, preps.length * COMMON_RATE);
  const common = new Set();
  for (const [g, n] of df) if (n > cut) common.add(g);
  poolCache.set(key, { size: preps.length, common });
  return common;
}

function overlap(a, b, skip) {
  let n = 0, na = 0, nb = 0;
  for (const x of a) { if (skip?.has(x)) continue; na++; if (b.has(x)) n++; }
  for (const x of b) if (!skip?.has(x)) nb++;
  return { shared: n, sim: n / (na + nb - n || 1) };
}

/**
 * @param {object} target       対象のノート
 * @param {object[]} poolNotes  比べる相手のノート（同じ一番上のデッキのもの）
 * @param {Map} notetypeById
 * @param {object} [o]
 * @param {string} [o.key]      ありふれた2文字の控えに使う名前（デッキ名など）
 * @param {number} [o.limit]
 * @returns {{note:object, sim:number}[]} 似ている順
 */
export function findConfusable(target, poolNotes, notetypeById, o = {}) {
  const { key = "", limit = 2 } = o;
  const t = prep(target, notetypeById.get(target.mid));
  if (!t) return [];
  const preps = [];
  for (const n of poolNotes) {
    const p = prep(n, notetypeById.get(n.mid));
    if (p) preps.push([n, p]);
  }
  const common = commonGrams(key, preps.map((x) => x[1]));
  const out = [];
  for (const [n, p] of preps) {
    if (n.id === target.id) continue;
    if (t.src.length >= 4 && t.src === p.src) continue;
    const { shared, sim } = overlap(t.q, p.q, common);
    if (shared < MIN_SHARED || sim < MIN_SIM) continue;
    if (overlap(t.a, p.a).sim >= MAX_ANS_SIM) continue;
    if ((t.core.length >= 2 && p.full.includes(t.core)) || (p.core.length >= 2 && t.full.includes(p.core))) continue;
    out.push({ note: n, sim });
  }
  out.sort((a, b) => b.sim - a.sim);
  return out.slice(0, limit);
}
