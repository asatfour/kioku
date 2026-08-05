/**
 * 出題キューの組み立て。
 *
 * 本家との違い（意図的）:
 *  - 「生活リズム別モード」で、その場面に向くカードだけを出す。
 *    通学中に図つきの記述問題を出されても解けない、という実際の不便を潰すため。
 */
import { State } from "./fsrs.js";
import { stripHtml } from "./render.js";

const DAY_MS = 86400000;

/** 1日の区切り（既定 午前4時）。深夜の学習を前日扱いにする。 */
export function dayStart(nowMs, rolloverHour = 4) {
  const d = new Date(nowMs);
  const start = new Date(d);
  start.setHours(rolloverHour, 0, 0, 0);
  if (d.getHours() < rolloverHour) start.setTime(start.getTime() - DAY_MS);
  return start.getTime();
}

/** 「今日の終わり」＝次の区切り時刻 */
export const dayEnd = (nowMs, rolloverHour = 4) => dayStart(nowMs, rolloverHour) + DAY_MS;

/** 既定の学習モード（設定画面で編集できる想定） */
export const DEFAULT_MODES = [
  {
    id: "commute",
    name: "通学・スキマ",
    emoji: "🚃",
    desc: "短い問題だけ。図や記述は出さない",
    filter: { maxChars: 260, allowImage: false, excludeTags: [] },
    limits: { new: 5, review: 60 },
    sessionSize: 20,
    order: "due",
  },
  {
    id: "desk",
    name: "机の前・本気",
    emoji: "🖥️",
    desc: "全部出す。図・記述・長文も",
    filter: {},
    limits: { new: 20, review: 200 },
    sessionSize: 0,
    order: "due",
  },
  {
    id: "night",
    name: "就寝前・暗記",
    emoji: "🌙",
    desc: "覚え直しだけ。新規は出さない",
    filter: { maxChars: 400, allowImage: true },
    limits: { new: 0, review: 40 },
    sessionSize: 20,
    order: "difficulty",
  },
  {
    id: "weak",
    name: "弱点だけ",
    emoji: "🎯",
    desc: "間違えた回数が多いカードを集中的に",
    filter: { minLapses: 1 },
    limits: { new: 0, review: 100 },
    sessionSize: 30,
    order: "lapses",
  },
];

/** カードが持つ「見た目の重さ」を測る（モードの判定に使う） */
export function cardWeight(note, notetype) {
  const text = note.fields.join(" ");
  return {
    chars: stripHtml(text).length,
    hasImage: /<img\b/i.test(text),
    hasSound: /\[sound:/i.test(text),
    tags: note.tags,
  };
}

function matchesFilter(card, weight, filter) {
  if (!filter) return true;
  if (filter.maxChars != null && weight.chars > filter.maxChars) return false;
  if (filter.allowImage === false && weight.hasImage) return false;
  if (filter.minLapses != null && (card.lapses ?? 0) < filter.minLapses) return false;
  if (filter.includeTags?.length) {
    const hit = filter.includeTags.some((t) => weight.tags.some((x) => x.startsWith(t)));
    if (!hit) return false;
  }
  if (filter.excludeTags?.length) {
    const hit = filter.excludeTags.some((t) => weight.tags.some((x) => x.startsWith(t)));
    if (hit) return false;
  }
  return true;
}

/**
 * 今日出すカードを選ぶ。
 * @param {object} opts
 *  cards       : 学習カードの配列
 *  noteById    : Map<nid, note>
 *  notetypeById: Map<mid, notetype>
 *  deckIds     : 対象デッキID（null なら全部）
 *  mode        : DEFAULT_MODES の1件
 *  now         : 現在時刻(ms)
 *  todayCounts : {new: 今日出した新規枚数, review: 今日した復習枚数}
 *  rolloverHour
 */
export function buildQueue(opts) {
  const {
    cards,
    noteById,
    notetypeById,
    deckIds = null,
    mode = DEFAULT_MODES[1],
    now = Date.now(),
    todayCounts = { new: 0, review: 0 },
    rolloverHour = 4,
  } = opts;

  const deckSet = deckIds ? new Set(deckIds) : null;
  const endOfDay = dayEnd(now, rolloverHour);

  const learning = [];
  const review = [];
  const fresh = [];

  for (const c of cards) {
    if (c.suspended || c.buried) continue;
    if (deckSet && !deckSet.has(c.did)) continue;
    const note = noteById.get(c.nid);
    if (!note) continue;
    const w = cardWeight(note, notetypeById.get(note.mid));
    if (!matchesFilter(c, w, mode.filter)) continue;

    if (c.state === State.New) {
      fresh.push(c);
    } else if (c.state === State.Learning || c.state === State.Relearning) {
      // 学習中は「今すぐ」出す。まだ先の分も、他に出すものが無ければ繰り上げる
      learning.push(c);
    } else if (c.due <= endOfDay) {
      review.push(c);
    }
  }

  // 並び順
  const sorters = {
    due: (a, b) => a.due - b.due,
    lapses: (a, b) => (b.lapses ?? 0) - (a.lapses ?? 0) || a.due - b.due,
    difficulty: (a, b) => (b.difficulty ?? 0) - (a.difficulty ?? 0) || a.due - b.due,
    random: () => Math.random() - 0.5,
  };
  const sorter = sorters[mode.order] || sorters.due;

  learning.sort((a, b) => a.due - b.due);
  review.sort(sorter);
  fresh.sort((a, b) => (a.newPos ?? 0) - (b.newPos ?? 0));

  const newLimit = Math.max(0, (mode.limits?.new ?? 20) - todayCounts.new);
  const revLimit = Math.max(0, (mode.limits?.review ?? 200) - todayCounts.review);

  const picked = {
    learning,
    review: review.slice(0, revLimit),
    fresh: fresh.slice(0, newLimit),
  };

  // 出題順に混ぜる: 期限が来た学習カード → 復習 → 新規（新規は復習の間に散らす）
  const dueLearning = picked.learning.filter((c) => c.due <= now);
  const laterLearning = picked.learning.filter((c) => c.due > now);
  const order = [];
  const rev = [...picked.review];
  const nw = [...picked.fresh];
  order.push(...dueLearning);
  const total = rev.length + nw.length;
  const every = nw.length ? Math.max(1, Math.round(rev.length / nw.length)) : Infinity;
  let ri = 0;
  for (let i = 0; i < total; i++) {
    if (nw.length && (ri >= rev.length || (i > 0 && i % every === 0))) order.push(nw.shift());
    else if (ri < rev.length) order.push(rev[ri++]);
    else if (nw.length) order.push(nw.shift());
  }
  order.push(...laterLearning);

  const limited = mode.sessionSize ? order.slice(0, mode.sessionSize) : order;

  return {
    cards: limited,
    counts: {
      learning: picked.learning.length,
      review: picked.review.length,
      new: picked.fresh.length,
      total: limited.length,
    },
    /** 制限を外せばまだ出せる枚数 */
    available: {
      review: review.length,
      new: fresh.length,
    },
  };
}

/** 今日の学習実績を revlog から数える */
export function todayStats(revlog, now = Date.now(), rolloverHour = 4) {
  const start = dayStart(now, rolloverHour);
  const today = revlog.filter((r) => r.reviewedAt >= start);
  const out = {
    reviews: today.length,
    new: today.filter((r) => r.state === State.New || r.state === undefined).length,
    again: today.filter((r) => r.rating === 1).length,
    timeMs: today.reduce((s, r) => s + (r.durationMs || 0), 0),
  };
  out.retention = today.length ? 1 - out.again / today.length : null;
  return out;
}

/** 今後7日ぶんの予定枚数（グラフ用） */
export function forecast(cards, days = 7, now = Date.now(), rolloverHour = 4) {
  const start = dayStart(now, rolloverHour);
  const out = new Array(days).fill(0);
  for (const c of cards) {
    if (c.suspended || c.state === State.New) continue;
    const idx = Math.floor((c.due - start) / DAY_MS);
    if (idx >= 0 && idx < days) out[idx]++;
    else if (idx < 0) out[0]++; // 期限切れは今日にまとめる
  }
  return out;
}
