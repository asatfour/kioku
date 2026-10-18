/**
 * 試験日までの計画を、FSRS で**実際に回して**見積もる。
 *
 * 🔴 これまでの逆算は「未着手 ÷ 残り日数」で、**一度目を通せるか**しか見ていなかった。
 *   コード自身が「※一度は目を通せるだけの計算」と断っていたとおり、
 *   1日何枚おろすかを決める根拠としては足りない。決め手は次の3つ:
 *     ① 本番日に**どれだけ思い出せるか**（FSRSの想起率 R をその日で評価する）
 *     ② 本番までに**何回まわるか**（回数が少ない札は、覚えた気になっているだけ）
 *     ③ 毎日の**負担**（新規を増やすと復習が雪崩れる。ピークが効く）
 *   ①〜③は互いに引っ張り合う。**枚数を増やすほど良い、ではない**ので、
 *   候補をいくつか回して見比べられるようにする。
 *
 * ⚠️ これは予測ではなく**見積もり**。すべて Good で答え続けた場合の上振れで、
 *   `againRate` を上げると悲観側に振れる。実際の成績はこの間に来る。
 */
import { Fsrs, Rating, State, newCard } from "./fsrs.js";

const DAY = 86400000;

/**
 * 1つの「1日何枚」案を、試験日まで日単位で回す。
 *
 * @param {object} o
 * @param {number} o.total     まだ出していない枚数
 * @param {number} o.perDay    1日におろす新規の枚数
 * @param {number} o.days      試験日までの残り日数
 * @param {number} [o.againRate] 何割を Again で落とすか（0〜1）。既定 0.1
 * @param {number} [o.reviewCap] 1日に回せる復習の上限。超えた分は翌日へ持ち越す
 * @param {object} [o.fsrsOpts]  FSRS の設定（パラメータ・学習ステップ）
 * @returns {{
 *   perDay:number, 一周日:number|null, 出せた枚数:number, 積み残し:number,
 *   平均回数:number, 試験日の想起率:number, 1日平均:number, 1日ピーク:number,
 *   間に合う:boolean
 * }}
 */
export function simulatePlan(o) {
  const {
    total, perDay, days,
    againRate = 0.1,
    reviewCap = Infinity,
    fsrsOpts = {},
    now = Date.now(),
  } = o;
  // 🔴 見積もりでは**間隔のばらつき（fuzz）を切る**。
  //   本家と同じく既定は有効で、同じ入力でも毎回1〜2%ずれる。
  //   案を並べて比べる表で行ごとに揺れると、差が実力なのか偶然なのか分からなくなる。
  //   （実際の学習では fuzz は有効のまま。同じ日に期限が固まるのを防ぐため。）
  const fsrs = new Fsrs({ enableFuzz: false, ...fsrsOpts });
  const examMs = now + days * DAY;

  /** 出した札。due はミリ秒。 */
  const cards = [];
  let 出した = 0, 一周日 = null, ピーク = 0, のべ = 0;
  let 積み残し = [];   // 上限で回しきれなかった札

  // 🔴 Again をどこに割り当てるかで結果が変わるので、**札ごとに固定**する。
  //   乱数にすると、同じ入力で数字が毎回ぶれて比べられなくなる。
  const 落とす = (i, rep) => againRate > 0 && ((i * 7 + rep * 3) % Math.round(1 / againRate)) === 0;

  for (let d = 0; d < days; d++) {
    const dayMs = now + d * DAY;
    const dayEnd = dayMs + DAY;
    let 今日 = 0;

    // ① 期限が来た札（前日の積み残しを先に）
    const due = [...積み残し, ...cards.filter((c) => !積み残し.includes(c) && c.due < dayEnd && c.due >= dayMs)];
    積み残し = [];
    for (let idx = 0; idx < due.length; idx++) {
      let c = due[idx];
      if (今日 >= reviewCap) { 積み残し.push(c); continue; }
      // 学習ステップで同じ日に何度も出る分も、その日の負担として数える
      // 🔴 `review()` は**新しい札を返す**（元は書き換えない）。返り値で置き換えること。
      let t = Math.max(c.due, dayMs);
      do {
        const r = 落とす(c._i, c._rep) ? Rating.Again : Rating.Good;
        const next = fsrs.review(c, r, t).card;
        next._i = c._i; next._rep = c._rep + 1;
        c = next; 今日++; のべ++;
        t = c.due;
      } while (c.due < dayEnd && 今日 < reviewCap + 8);
      cards[cards.indexOf(due[idx])] = c;
      due[idx] = c;
    }

    // ② 新規をおろす
    for (let k = 0; k < perDay && 出した < total; k++) {
      let c = newCard(出した);
      c._i = 出した; c._rep = 0;
      let t = dayMs;
      do {
        const r = 落とす(c._i, c._rep) ? Rating.Again : Rating.Good;
        const next = fsrs.review(c, r, t).card;
        next._i = c._i; next._rep = c._rep + 1;
        c = next; 今日++; のべ++;
        t = c.due;
      } while (c.due < dayEnd && c._rep < 10);
      cards.push(c);
      出した++;
      if (出した === total && 一周日 === null) 一周日 = d + 1;
    }
    if (今日 > ピーク) ピーク = 今日;
  }

  const 想起率 = cards.length
    ? cards.reduce((s, c) => s + fsrs.retrievability(c, examMs), 0) / cards.length : 0;
  const 平均回数 = cards.length ? cards.reduce((s, c) => s + c._rep, 0) / cards.length : 0;

  return {
    perDay,
    一周日,
    出せた枚数: 出した,
    積み残し: total - 出した,
    平均回数: Math.round(平均回数 * 10) / 10,
    試験日の想起率: Math.round(想起率 * 1000) / 1000,
    "1日平均": Math.round(のべ / days),
    "1日ピーク": ピーク,
    間に合う: 出した >= total,
  };
}

/**
 * 候補をいくつか回して、比べられる表にする。
 *
 * 🔴 「おすすめ」は**最大枚数ではない**。
 *   全部おろせて、かつ1日の負担が上限に収まる中で、**本番日の想起率が最も高い案**を選ぶ。
 *   全部おろせる案が無ければ、いちばん多く回せる案を返す（そこが限界だと分かるように）。
 */
export function planCandidates(o) {
  const { candidates = [10, 15, 20, 30, 40, 60], loadCap = Infinity } = o;
  // 🔴 現在時刻は**候補全体で1つに固定する**。既定の `Date.now()` のままだと
  //   行ごとに数ミリ秒ずれ、日の区切りとの関係が変わって数字が動く。
  //   「比べるための表」で行ごとに前提が違うのは、いちばんやってはいけない。
  const now = o.now ?? Date.now();
  const rows = candidates.map((perDay) => simulatePlan({ ...o, perDay, now }));
  const 収まる = rows.filter((r) => r.間に合う && r["1日ピーク"] <= loadCap);
  const best = 収まる.length
    ? 収まる.reduce((a, b) => (b.試験日の想起率 > a.試験日の想起率 ? b : a))
    : rows.reduce((a, b) => (b.出せた枚数 > a.出せた枚数 ? b : a));
  return { rows, best };
}
