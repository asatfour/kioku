/**
 * FSRS のパラメータを、その人の解答履歴から作り直す（自前実装）。
 *
 * 考え方は公式の最適化（fsrs-rs）と同じ:
 *   各復習の「その時点で思い出せる確率 R」を記憶モデルで予測し、
 *   実際に思い出せたか（評価が「思い出せない」以外か）との交差エントロピーを最小にする。
 * 違い:
 *   - 勾配は式を手で微分して1回の走査で求める（lossAndGrad。テストで中心差分と突き合わせる）
 *   - 全件で1ステップ（ミニバッチにしない）。学習率はコサインで下げる
 *   - 初期値への引き戻し（L2）を少し入れ、履歴が少ない人でも暴れないようにする
 *   - **採用するのは、学習に使っていないカードで予測が良くなったときだけ**
 *
 * 経過日数は fsrs.js と同じ定義（前回からの経過ミリ秒 ÷ 1日 の切り捨て）で数える。
 * ここがずれると、学習した値をアプリで使ったときに意味が変わってしまう。
 */
import { Fsrs, DEFAULT_PARAMETERS } from "./fsrs.js";

const DAY_MS = 86400000;

/** 各パラメータの取りうる範囲（公式の最適化と同じ制約） */
export const PARAM_BOUNDS = Object.freeze([
  [0.001, 100], [0.001, 100], [0.001, 100], [0.001, 100],
  [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75],
  [0, 4.5], [0, 0.8], [0.001, 3.5], [0.001, 5],
  [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1],
  [1, 6], [0, 2], [0, 2], [0, 0.8], [0.1, 0.8],
]);

/** 最適化に回すのに要る「予測できる復習」（前回から1日以上空いた復習）の最小数 */
export const MIN_REVIEWS = 400;

const clampParams = (w) => w.map((v, i) => Math.min(Math.max(v, PARAM_BOUNDS[i][0]), PARAM_BOUNDS[i][1]));

/**
 * 解答履歴をカードごとの並びにまとめる。
 * @param {object[]} revlog  {cardId, rating(1-4), reviewedAt(ms), state?}
 * @returns {{cards: {id, ratings:number[], deltas:number[], complete:boolean}[], predictable:number}}
 *   complete: 最初の記録が新規カードのときの解答か（途中からの履歴は記憶状態を作り直せない）
 */
export function buildHistories(revlog) {
  const byCard = new Map();
  for (const r of revlog) {
    if (!(r.rating >= 1 && r.rating <= 4)) continue; // 手動の日付変更など（評価0）は除く
    if (!byCard.has(r.cardId)) byCard.set(r.cardId, []);
    byCard.get(r.cardId).push(r);
  }
  const cards = [];
  let predictable = 0;
  for (const [id, logs] of byCard) {
    logs.sort((a, b) => a.reviewedAt - b.reviewedAt);
    const ratings = [], deltas = [];
    let prev = null;
    for (const l of logs) {
      ratings.push(l.rating);
      const d = prev == null ? 0 : Math.floor((l.reviewedAt - prev) / DAY_MS);
      deltas.push(d);
      prev = l.reviewedAt;
    }
    // 最初の記録が「新規カードへの解答」なら、履歴は最初から揃っている。
    //   state: このアプリの記録（0 = 新規）／ type: Anki から取り込んだ記録（0 = 初回の学習）
    // 途中からしか無い履歴（取り込む前の分が無い）は、最初の解答を「初めて見た」と取り違えるので
    // 当てはめに使わない。どちらも無い古い取り込み分は、わからないので使う。
    const first = logs[0];
    const complete = first.state === 0 || first.type === 0;
    const partial = (first.state != null && first.state !== 0) || (first.type != null && first.type !== 0);
    if (!partial) for (let i = 1; i < deltas.length; i++) if (deltas[i] > 0) predictable++;
    cards.push({ id, ratings, deltas, complete, partial, lastReview: prev });
  }
  return { cards, predictable };
}

/** 当てはめに使えるカード（途中からの履歴を除く） */
const usable = (cards) => cards.filter((c) => !c.partial);

/** 1枚ぶんの履歴を順にたどり、記憶状態と予測を返す */
function walk(fsrs, ratings, deltas, onPredict) {
  let s = fsrs._initialStability(ratings[0]);
  let d = fsrs._initialDifficulty(ratings[0]);
  for (let i = 1; i < ratings.length; i++) {
    const g = ratings[i], t = deltas[i];
    if (t === 0) {
      s = fsrs._shortTermStability(s, g);
    } else {
      const r = Math.pow(1 + (fsrs.FACTOR * t) / s, fsrs.DECAY);
      if (onPredict) onPredict(r, g > 1 ? 1 : 0);
      s = fsrs._nextStability(d, s, r, g);
    }
    d = fsrs._nextDifficulty(d, g);
  }
  return { stability: s, difficulty: d };
}

function modelFor(w) {
  const f = new Fsrs({ parameters: w, enableFuzz: false });
  return f;
}

/** 平均の交差エントロピー（小さいほど予測が当たっている）と件数 */
export function logLoss(w, cards) {
  const f = modelFor(w);
  let sum = 0, n = 0;
  const add = (p, y) => {
    const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
    sum -= y * Math.log(q) + (1 - y) * Math.log(1 - q);
    n++;
  };
  for (const c of cards) walk(f, c.ratings, c.deltas, add);
  return { loss: n ? sum / n : NaN, n };
}

/**
 * 予測の当たり具合を、予測した確率の帯ごとに見た誤差（公式の RMSE(bins) に近い指標）。
 * 「80%と予測したカードが実際に80%思い出せていたか」を見る。
 */
export function calibrationError(w, cards, bins = 20) {
  const f = modelFor(w);
  const sumP = new Array(bins).fill(0), sumY = new Array(bins).fill(0), cnt = new Array(bins).fill(0);
  for (const c of cards) {
    walk(f, c.ratings, c.deltas, (p, y) => {
      const b = Math.min(bins - 1, Math.floor(p * bins));
      sumP[b] += p; sumY[b] += y; cnt[b]++;
    });
  }
  let se = 0, n = 0;
  for (let b = 0; b < bins; b++) {
    if (!cnt[b]) continue;
    se += cnt[b] * ((sumP[b] - sumY[b]) / cnt[b]) ** 2;
    n += cnt[b];
  }
  return n ? Math.sqrt(se / n) : NaN;
}

/** 履歴を平たい配列に詰める（勾配計算の内側でオブジェクトをたどらないため） */
export function pack(cards) {
  let n = 0;
  for (const c of cards) n += c.ratings.length;
  const g = new Int8Array(n), t = new Int32Array(n), start = new Int32Array(cards.length + 1);
  let k = 0;
  cards.forEach((c, i) => {
    start[i] = k;
    for (let j = 0; j < c.ratings.length; j++, k++) { g[k] = c.ratings[j]; t[k] = c.deltas[j]; }
  });
  start[cards.length] = k;
  return { g, t, start, count: cards.length };
}

/**
 * 交差エントロピー（平均）と、その21個のパラメータについての勾配を1回の走査で求める。
 * 記憶状態（安定度 S・難易度 D）といっしょに、それぞれの各パラメータについての偏微分を
 * 持ち回す（前進型の微分）。式は fsrs.js の記憶モデルとまったく同じものを微分している。
 * 中心差分（21個×2回の走査）より1桁以上速い。
 */
export function lossAndGrad(w, packed) {
  const N = 21;
  const { g: G, t: T, start, count } = packed;
  const decay = -w[20];
  const F = Math.pow(0.9, 1 / decay) - 1;
  const dFdw20 = Math.pow(0.9, -1 / w[20]) * Math.log(0.9) / (w[20] * w[20]);
  const target = w[4] - Math.exp(3 * w[5]) + 1; // 平均回帰の行き先（「即答」の初期難易度・範囲で切らない）
  const e3w5 = Math.exp(3 * w[5]);
  const ew8 = Math.exp(w[8]);
  const shortDen = Math.exp(-w[17] * w[18]);

  let s, d;
  const ds = new Float64Array(N), dd = new Float64Array(N);
  const nds = new Float64Array(N), ndd = new Float64Array(N);
  const dR = new Float64Array(N);
  const grad = new Float64Array(N);
  let sum = 0, n = 0;

  for (let ci = 0; ci < count; ci++) {
    const a = start[ci], b = start[ci + 1];
    // ---- 最初の解答 ----
    const g0 = G[a];
    ds.fill(0); dd.fill(0);
    s = w[g0 - 1];
    if (s < 0.001) s = 0.001; else ds[g0 - 1] = 1;
    const e0 = Math.exp(w[5] * (g0 - 1));
    d = w[4] - e0 + 1;
    if (d < 1) d = 1;
    else if (d > 10) d = 10;
    else { dd[4] = 1; dd[5] = -(g0 - 1) * e0; }

    for (let k = a + 1; k < b; k++) {
      const g = G[k], t = T[k];
      // ---- 安定度 ----
      if (t === 0) {
        const expo = Math.exp(w[17] * (g - 3 + w[18]));
        const sp = Math.pow(s, -w[19]);
        let inc = expo * sp;
        let ns;
        if (g >= 3 && inc < 1) {
          ns = s;
          for (let i = 0; i < N; i++) nds[i] = ds[i];
        } else {
          ns = s * inc;
          const dsdS = inc * (1 - w[19]);
          for (let i = 0; i < N; i++) nds[i] = dsdS * ds[i];
          nds[17] += ns * (g - 3 + w[18]);
          nds[18] += ns * w[17];
          nds[19] += -ns * Math.log(s);
        }
        if (ns < 0.001) { ns = 0.001; nds.fill(0); }
        s = ns;
        for (let i = 0; i < N; i++) ds[i] = nds[i];
      } else {
        const u = 1 + (F * t) / s;
        const R = Math.pow(u, decay);
        // R の勾配: S を通る分 ＋ w20（減衰）を直接通る分
        const dRdS = (R * w[20] * F * t) / (u * s * s);
        for (let i = 0; i < N; i++) dR[i] = dRdS * ds[i];
        dR[20] += R * (-Math.log(u) + (-w[20] * t * dFdw20) / (u * s));

        // 予測と答え合わせ
        const y = g > 1 ? 1 : 0;
        let q = R, clipped = false;
        if (q < 1e-6) { q = 1e-6; clipped = true; } else if (q > 1 - 1e-6) { q = 1 - 1e-6; clipped = true; }
        sum -= y * Math.log(q) + (1 - y) * Math.log(1 - q);
        n++;
        if (!clipped) {
          const dLdR = -y / q + (1 - y) / (1 - q);
          for (let i = 0; i < N; i++) grad[i] += dLdR * dR[i];
        }

        let ns;
        if (g === 1) {
          const dpow = Math.pow(d, -w[12]);
          const sp1 = Math.pow(s + 1, w[13]);
          const er = Math.exp((1 - R) * w[14]);
          const long = w[11] * dpow * (sp1 - 1) * er;
          const short = s * shortDen;
          if (long < short) {
            ns = long;
            const dSdS = w[11] * dpow * w[13] * Math.pow(s + 1, w[13] - 1) * er;
            const dSdD = long * (-w[12] / d);
            const dSdR = -long * w[14];
            for (let i = 0; i < N; i++) nds[i] = dSdS * ds[i] + dSdD * dd[i] + dSdR * dR[i];
            nds[11] += long / w[11];
            nds[12] += -long * Math.log(d);
            nds[13] += w[11] * dpow * sp1 * Math.log(s + 1) * er;
            nds[14] += long * (1 - R);
          } else {
            ns = short;
            for (let i = 0; i < N; i++) nds[i] = shortDen * ds[i];
            nds[17] += -w[18] * short;
            nds[18] += -w[17] * short;
          }
        } else {
          const hard = g === 2 ? w[15] : 1;
          const easy = g === 4 ? w[16] : 1;
          const sp = Math.pow(s, -w[9]);
          const ex = Math.exp((1 - R) * w[10]);
          const base = ew8 * (11 - d) * sp * hard * easy; // A = base × (ex − 1)
          const A = base * (ex - 1);
          ns = s * (1 + A);
          const dSdS = 1 + A - w[9] * A;
          const dSdD = -s * ew8 * sp * (ex - 1) * hard * easy;
          const dSdR = -s * base * ex * w[10];
          for (let i = 0; i < N; i++) nds[i] = dSdS * ds[i] + dSdD * dd[i] + dSdR * dR[i];
          nds[8] += s * A;
          nds[9] += -s * A * Math.log(s);
          nds[10] += s * base * ex * (1 - R);
          if (g === 2) nds[15] += (s * A) / w[15];
          if (g === 4) nds[16] += (s * A) / w[16];
        }
        if (ns < 0.001) { ns = 0.001; nds.fill(0); }
        s = ns;
        for (let i = 0; i < N; i++) ds[i] = nds[i];
      }

      // ---- 難易度（更新前の D から） ----
      const deltaD = -w[6] * (g - 3);
      const damped = d + ((10 - d) * deltaD) / 9;
      let nd = w[7] * target + (1 - w[7]) * damped;
      if (nd < 1 || nd > 10) {
        nd = nd < 1 ? 1 : 10;
        ndd.fill(0);
      } else {
        const k1 = (1 - w[7]) * (1 - deltaD / 9);
        for (let i = 0; i < N; i++) ndd[i] = k1 * dd[i];
        ndd[6] += ((1 - w[7]) * (10 - d) * -(g - 3)) / 9;
        ndd[4] += w[7];
        ndd[5] += w[7] * -3 * e3w5;
        ndd[7] += target - damped;
      }
      d = nd;
      for (let i = 0; i < N; i++) dd[i] = ndd[i];
    }
  }
  if (n) for (let i = 0; i < N; i++) grad[i] /= n;
  return { loss: n ? sum / n : NaN, grad: [...grad], n };
}

/** 目的関数: 交差エントロピー ＋ 初期値への引き戻し（テストで勾配を突き合わせる用） */
export function objective(w, cards, base, l2) {
  const { loss } = logLoss(w, cards);
  let pen = 0;
  for (let i = 0; i < w.length; i++) {
    const span = PARAM_BOUNDS[i][1] - PARAM_BOUNDS[i][0];
    pen += ((w[i] - base[i]) / span) ** 2;
  }
  return loss + l2 * pen;
}

/**
 * 勾配降下でパラメータを当てはめる。
 * @param {object[]} cards  buildHistories().cards
 * @param {object} [o]
 * @param {number[]} [o.start]   出発点（既定は FSRS の既定値）
 * @param {number} [o.steps]     反復回数
 * @param {number} [o.lr]        学習率（Adam）
 * @param {number} [o.l2]        初期値への引き戻しの強さ
 * @param {(i:number, n:number, loss:number)=>void|Promise<void>} [o.onStep]  進み具合の通知
 */
export async function fit(cards, o = {}) {
  const base = [...(o.start ?? DEFAULT_PARAMETERS)];
  const steps = o.steps ?? 250;
  const lr0 = o.lr ?? 0.04;
  const l2 = o.l2 ?? 0.01;
  let w = clampParams(base);
  const packed = pack(cards);
  const m = new Array(21).fill(0), v = new Array(21).fill(0);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  for (let it = 1; it <= steps; it++) {
    const { grad } = lossAndGrad(w, packed);
    for (let i = 0; i < 21; i++) {
      const span = PARAM_BOUNDS[i][1] - PARAM_BOUNDS[i][0];
      grad[i] += (2 * l2 * (w[i] - base[i])) / (span * span);
    }
    const lr = lr0 * 0.5 * (1 + Math.cos((Math.PI * (it - 1)) / steps));
    w = w.map((x, i) => {
      m[i] = b1 * m[i] + (1 - b1) * grad[i];
      v[i] = b2 * v[i] + (1 - b2) * grad[i] ** 2;
      const mh = m[i] / (1 - b1 ** it), vh = v[i] / (1 - b2 ** it);
      return x - (lr * mh) / (Math.sqrt(vh) + eps);
    });
    w = clampParams(w);
    if (o.onStep) await o.onStep(it, steps);
  }
  return w;
}

/** 決まった並びでカードを分ける（同じ履歴なら毎回同じ分け方） */
function holdoutSplit(cards, fraction = 0.2) {
  const train = [], test = [];
  for (const c of cards) {
    const k = String(c.id);
    let h = 2166136261;
    for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619);
    ((h >>> 0) / 4294967296 < fraction ? test : train).push(c);
  }
  return { train, test };
}

/**
 * 履歴からパラメータを作り直し、採用してよいかまで判断する。
 *  1. カードを 8:2 に分け、8割で当てはめ、残り2割で「今の値」と比べる
 *  2. 2割の側でも良くなっていたら、全部のカードで当てはめ直した値を返す
 * @returns {Promise<{ok:boolean, reason?:string, parameters?:number[], before?, after?, reviews:number}>}
 */
export async function optimize(revlog, current = DEFAULT_PARAMETERS, o = {}) {
  const built = buildHistories(revlog);
  const predictable = built.predictable;
  const cards = usable(built.cards);
  if (predictable < (o.minReviews ?? MIN_REVIEWS)) {
    return { ok: false, reason: "few", reviews: predictable };
  }
  const total = 2 * (o.steps ?? 250);
  const prog = (offset) => (i, n) => o.onProgress?.((offset + i) / total);
  const { train, test } = holdoutSplit(cards);
  const trial = await fit(train, { ...o, start: DEFAULT_PARAMETERS, onStep: prog(0) });
  const testBefore = logLoss(current, test).loss;
  const testAfter = logLoss(trial, test).loss;
  if (!(testAfter < testBefore)) {
    return { ok: false, reason: "noimprove", reviews: predictable, before: testBefore, after: testAfter };
  }
  const w = await fit(cards, { ...o, start: DEFAULT_PARAMETERS, onStep: prog(o.steps ?? 250) });
  return {
    ok: true,
    parameters: w.map((x) => Math.round(x * 10000) / 10000),
    reviews: predictable,
    before: logLoss(current, cards).loss,
    after: logLoss(w, cards).loss,
    calBefore: calibrationError(current, cards),
    calAfter: calibrationError(w, cards),
    heldOut: { before: testBefore, after: testAfter },
  };
}

/**
 * 新しいパラメータで、各カードの記憶状態（安定度・難易度）を履歴から計算し直す。
 * 次回の予定日は動かさない（本家と同じ。急に大量の復習が降ってこないように）。
 * 最初の解答から履歴が揃っているカードだけが対象。
 * @returns {Map<cardId, {stability, difficulty}>}
 */
export function recomputeMemory(revlog, parameters) {
  const { cards } = buildHistories(revlog);
  const f = modelFor(parameters);
  const out = new Map();
  for (const c of cards) {
    if (!c.complete) continue;
    out.set(c.id, walk(f, c.ratings, c.deltas, null));
  }
  return out;
}
