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

/**
 * 日ごとに変わるが、同じ日なら何度呼んでも同じ並びになる乱数。
 * 毎回ばらばらだと、画面を開き直すたびに順番が変わって落ち着かない。
 */
function seededShuffle(arr, seed) {
  let s = seed >>> 0;
  const rnd = () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 同じ日に期限が来るカードどうしだけ入れ替える（期限の前後は崩さない） */
function shuffleWithinDay(list, seed, rolloverHour) {
  const groups = new Map();
  for (const c of list) {
    const k = Math.floor(dayStart(c.due, rolloverHour) / DAY_MS);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const out = [];
  for (const k of [...groups.keys()].sort((a, b) => a - b)) {
    out.push(...seededShuffle(groups.get(k), seed + k));
  }
  return out;
}

/** そのカードが属する一番上のデッキ名（「沖縄県 教職・一般教養 2026::1 教職教養::…」→ 先頭） */
function topDeckOf(card, deckNameById) {
  const name = deckNameById?.get(card.did);
  return name ? name.split("::")[0] : "";
}

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
/**
 * 新規カードを、デッキごとの上限を守りつつ、デッキ横断で均等に配る。
 * 一番上のデッキ（教科）単位で順番に1枚ずつ取っていく。
 */
function pickFreshFairly(fresh, { newLimit, deckNameById, deckNewLimits, todayNewByDeck }) {
  if (newLimit <= 0) return [];
  if (!deckNameById || deckNameById.size === 0) return fresh.slice(0, newLimit);

  const buckets = new Map(); // 一番上のデッキ名 → その順で並んだ新規カード
  for (const c of fresh) {
    const top = topDeckOf(c, deckNameById);
    if (!buckets.has(top)) buckets.set(top, []);
    buckets.get(top).push(c);
  }
  // デッキごとの残り枠（未設定なら無制限）
  const room = new Map();
  for (const top of buckets.keys()) {
    const cap = deckNewLimits?.[top];
    room.set(top, cap == null ? Infinity : Math.max(0, cap - (todayNewByDeck?.[top] ?? 0)));
  }

  const out = [];
  const keys = [...buckets.keys()];
  let progressed = true;
  while (out.length < newLimit && progressed) {
    progressed = false;
    for (const k of keys) {
      if (out.length >= newLimit) break;
      const b = buckets.get(k);
      if (!b.length || room.get(k) <= 0) continue;
      out.push(b.shift());
      room.set(k, room.get(k) - 1);
      progressed = true;
    }
  }
  return out;
}

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
    /** did → デッキ名。デッキごとの配分に使う */
    deckNameById = null,
    /** {一番上のデッキ名: 1日の新規上限} */
    deckNewLimits = null,
    /** {一番上のデッキ名: 今日すでに出した新規枚数} */
    todayNewByDeck = null,
    /** 同じ期限のカードを日替わりで入れ替える */
    shuffleSameDay = true,
    /** "position"（登録順） or "random" */
    newOrder = "position",
    /** 印（🚩）を付けたカードだけに絞る */
    onlyFlagged = false,
  } = opts;

  const deckSet = deckIds ? new Set(deckIds) : null;
  const endOfDay = dayEnd(now, rolloverHour);

  const learning = [];
  const review = [];
  const fresh = [];

  for (const c of cards) {
    if (c.suspended) continue;
    // buried は取り込み時の真偽値、buriedUntil はこのアプリが同じ日の兄弟を伏せた時刻
    if (c.buried === true || (c.buriedUntil ?? 0) > now) continue;
    if (deckSet && !deckSet.has(c.did)) continue;
    if (onlyFlagged && !c.flags) continue;
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

  // 同じ期限のカードが毎日同じ順で出ると、順番そのものを手がかりに思い出してしまう。
  // 期限の前後は崩さず、同じ日の中だけ日替わりで入れ替える。
  const daySeed = Math.floor(dayStart(now, rolloverHour) / DAY_MS);
  if (shuffleSameDay && mode.order !== "random") {
    const shuffled = shuffleWithinDay(review, daySeed, rolloverHour);
    review.length = 0;
    review.push(...shuffled);
  }
  if (newOrder === "random") seededShuffle(fresh, daySeed + 7919);

  // 今日すでに出したぶんを引く（渡されなければ 1回あたりの上限として働く）
  const newLimit = Math.max(0, (mode.limits?.new ?? 20) - todayCounts.new);
  const revLimit = Math.max(0, (mode.limits?.review ?? 200) - todayCounts.review);

  // 新規はデッキごとの上限を先にかけ、残りをデッキ横断で均等に配る。
  // 登録順だけで切ると、片方のデッキばかり進んでもう片方が何日も出ない。
  const pickedFresh = pickFreshFairly(fresh, {
    newLimit, deckNameById, deckNewLimits, todayNewByDeck,
  });

  const picked = {
    learning,
    review: review.slice(0, revLimit),
    fresh: pickedFresh,
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
