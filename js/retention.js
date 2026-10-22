/**
 * 目標保持率のおすすめ。
 *
 * 目標保持率を下げると、1枚あたりの復習が減り、浮いた時間で新しいカードを多く覚えられる。
 * 上げると、覚えたカードを忘れにくくなるが、復習に時間を取られる。
 * どちらが得かは「1日にどれだけ答えられるか」「残りの枚数」「試験日まで何日か」で決まる。
 *
 * そこで、今のカードの状態から試験日（無ければ半年先）まで、候補の保持率ごとに
 * 自分の記憶の性質（パラメータ）で学習を回し、本番の日に思い出せる枚数を比べる。
 *
 * 架空の学習者での確認（test/retention.test.mjs）:
 *  1日の解答に上限がある場合、0.9 → 0.75 で本番の知識が +20% 前後。上限が無い場合は高い方が良い。
 *
 * ⚠️ 見積もりは自分の記憶の性質が正しく推定できている前提。既定値のままだとずれる。
 */
import { Fsrs, State, Rating } from "./fsrs.js";

const DAY = 86400000;
export const RETENTION_CANDIDATES = [0.75, 0.8, 0.85, 0.9, 0.95];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 1つの保持率で、試験日まで回す。
 * @param {object} o
 * @param {object[]} o.cards        今のカード（停止中は除いて渡す）
 * @param {number[]} o.parameters   記憶の性質
 * @param {number}   o.retention    目標保持率
 * @param {number}   o.capacity     1日に答えられる回数
 * @param {number}   o.newPerDay    1日の新規上限
 * @param {number}   o.days         何日先まで回すか
 * @param {number}   o.now
 * @param {number}   [o.deadline]   試験日の始まり(ms)
 * @param {number}   [o.studyRate]  学習する日の割合（休む日を入れる）
 * @param {number}   [o.seed]
 * @returns {{knowledge:number, introduced:number, answers:number}}
 */
export function simulateRetention(o) {
  const {
    cards, parameters, retention, capacity, newPerDay, days, now,
    deadline = null, studyRate = 1, seed = 1,
  } = o;
  const rnd = rng(seed);
  const life = rng(seed * 31 + 7); // 休む日は保持率によらず同じにする
  const sched = new Fsrs({ parameters, desiredRetention: retention, random: rnd, deadline });
  const truth = new Fsrs({ parameters, enableFuzz: false });

  const active = [];
  const fresh = [];
  for (const c of cards) (c.state === State.New ? fresh : active).push({ ...c });
  fresh.sort((a, b) => (a.newPos ?? 0) - (b.newPos ?? 0));
  let nextFresh = 0, answers = 0;

  const recall = (c, t) => {
    if (c.state === State.New || c.lastReview == null) return 0.6; // 初めて見る
    if (t - c.lastReview < DAY) return 0.85;                       // 同じ日の出し直し
    return truth.retrievability(c, t);
  };
  const answer = (c, t) => {
    let g = Rating.Again;
    if (rnd() < recall(c, t)) {
      const x = rnd();
      g = x < 0.12 ? Rating.Hard : x < 0.9 ? Rating.Good : Rating.Easy;
    }
    answers++;
    return sched.review(c, g, t, 8000).card;
  };

  for (let d = 0; d < days; d++) {
    const t0 = now + d * DAY;
    if (life() >= studyRate) continue;
    let budget = capacity;
    const end = t0 + DAY;
    const due = [];
    for (let i = 0; i < active.length; i++) if (active[i].due < end) due.push(i);
    due.sort((a, b) => active[a].due - active[b].due);
    const room = Math.min(newPerDay, fresh.length - nextFresh);
    // アプリと同じく、新規は復習の間に散らす
    const every = room ? Math.max(1, Math.round(due.length / room)) : Infinity;
    const order = [];
    let ri = 0, nNew = 0;
    for (let k = 0; k < due.length + room; k++) {
      if (nNew < room && (ri >= due.length || (k > 0 && k % every === 0))) { order.push(-1); nNew++; }
      else if (ri < due.length) order.push(due[ri++]);
      else { order.push(-1); nNew++; }
    }
    // 同じ日の出し直しは、時刻が来たら最優先（アプリの chooseNext と同じ）。
    // 列が尽きたら20分以内の分を繰り上げ、それより先なら時刻まで待つ
    const later = []; // active の添字
    const isLearning = (c) => c.state === State.Learning || c.state === State.Relearning;
    let t = t0, oi = 0;
    while (budget > 0) {
      let i = -2;
      let soon = -1;
      for (let k = 0; k < later.length; k++) if (soon < 0 || active[later[k]].due < active[later[soon]].due) soon = k;
      if (soon >= 0 && active[later[soon]].due <= t) i = later.splice(soon, 1)[0];
      else if (oi < order.length) {
        i = order[oi++];
        if (i < 0) { active.push(fresh[nextFresh++]); i = active.length - 1; }
      } else if (soon >= 0) {
        const at = active[later[soon]].due;
        if (at >= end) break;
        if (at - t > 20 * 60000) t = at;
        i = later.splice(soon, 1)[0];
      } else break;
      active[i] = answer(active[i], t);
      budget--; t += 8000;
      if (active[i].due < end && isLearning(active[i])) later.push(i);
    }
  }

  const at = deadline ?? now + days * DAY;
  let knowledge = 0;
  for (const c of active) if (c.lastReview != null) knowledge += truth.retrievability(c, at);
  return { knowledge, introduced: active.length, answers };
}

/**
 * 候補の保持率を全部回して比べる。
 * ほぼ同じ（1%以内）なら高い方を選ぶ（忘れる回数が少なく、気持ちよく続けられる）。
 * @returns {{rows:{retention:number,knowledge:number,introduced:number,answers:number}[], best:number}}
 */
export function recommendRetention(o) {
  const { candidates = RETENTION_CANDIDATES, seeds = [1, 2] } = o;
  const rows = candidates.map((retention) => {
    const rs = seeds.map((seed) => simulateRetention({ ...o, retention, seed }));
    const avg = (k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;
    return { retention, knowledge: avg("knowledge"), introduced: avg("introduced"), answers: avg("answers") };
  });
  const top = Math.max(...rows.map((r) => r.knowledge));
  const best = rows.filter((r) => r.knowledge >= top * 0.99).reduce((a, b) => (b.retention > a.retention ? b : a)).retention;
  return { rows, best };
}

/**
 * 解答の記録から、1日に答えている回数（学習した日の中央値）と、学習する日の割合を出す。
 * 直近 28 日を見る。学習した日が 5 日未満なら null（見積もれない）。
 */
export function studyHabit(revlog, now = Date.now(), rolloverHour = 4) {
  const shift = rolloverHour * 3600000;
  const today = Math.floor((now - shift) / DAY);
  const perDay = new Map();
  for (const r of revlog) {
    if (!(r.rating >= 1)) continue;
    const d = Math.floor(((r.reviewedAt ?? r.id) - shift) / DAY);
    if (d < today - 28 || d >= today) continue;
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  if (perDay.size < 5) return null;
  const v = [...perDay.values()].sort((a, b) => a - b);
  return { capacity: v[Math.floor(v.length / 2)], studyRate: perDay.size / 28, days: perDay.size };
}
