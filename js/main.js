/**
 * アプリ本体。画面の組み立てと操作の受け付け。
 */
import * as store from "./store.js";
import { readApkg, writeApkg, toStudyCard } from "./apkg.js";
import { Fsrs, State, Rating, humanInterval, DEFAULT_PARAMETERS } from "./fsrs.js";
import { renderCard, resolveMedia, stripHtml, sanitizeCardHtml, sanitizeCardCss } from "./render.js";
import { buildQueue, DEFAULT_MODES, todayStats, forecast, dayStart, dayEnd } from "./queue.js";
import { askAI, quickPrompts, buildContext } from "./ai.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/** 画面をまたいで持つ状態 */
const app = {
  sql: null,
  settings: null,
  notes: new Map(),
  notetypes: new Map(),
  decks: [],
  cards: [],
  mediaUrls: new Map(),
  modes: DEFAULT_MODES,
  modeId: "desk",
  selectedDeckIds: null,
  queue: [],
  qIndex: 0,
  current: null,
  revealed: false,
  shownAt: 0,
  lastAnswer: null,
  fsrs: null,
  counts: { new: 0, learning: 0, review: 0 },
  /** 今日すでに出した枚数。1日の上限を「1回の上限」にしないために持つ */
  todayCounts: { new: 0, review: 0 },
  /** {一番上のデッキ名: 今日出した新規枚数} */
  todayNewByDeck: {},
  /** 印を付けたカードだけに絞って学習する */
  onlyFlagged: false,
  /** 「さらに続ける」で今日だけ上乗せする枚数 */
  extra: null,
};

const DEFAULT_SETTINGS = {
  desiredRetention: 0.9,
  rolloverHour: 4,
  /** 評価ボタンの数。2 なら「できた／できなかった」だけで迷わない */
  gradingButtons: 2,
  /** 解答表示から採点を受け付けるまでの待ち時間(ms)。連打の誤爆を防ぐ */
  gradeGuardMs: 350,
  /** 解答を出したら解答位置へ自動スクロールする（縦長カード対策） */
  autoScrollToAnswer: true,
  /** カードの文字サイズ(px) */
  fontSize: 17,
  /** カード内に埋め込まれた「外部AIに聞く」リンクを隠す（アプリ内AIで代替するため） */
  hideCardAILinks: true,
  parameters: [...DEFAULT_PARAMETERS],
  learningSteps: [60, 600],
  relearningSteps: [600],
  modes: DEFAULT_MODES,
  modeId: "desk",
  /** 同じ期限のカードを日替わりで入れ替える（順番で覚えてしまうのを防ぐ） */
  shuffleSameDay: true,
  /** 新規の出す順。"position"=登録順 / "random"=日替わりでばらばら */
  newOrder: "position",
  /** 何回まちがえたら「手こずっているカード」として扱うか。0 で無効 */
  leechThreshold: 8,
  /** "suspend"=出題を止める / "tag"=印だけ付けて出し続ける */
  leechAction: "suspend",
  /** 同じノートの別カードを、その日はもう出さない */
  burySiblings: true,
  /** {一番上のデッキ名: 1日の新規上限}。未設定のデッキは全体の上限だけが効く */
  deckNewLimits: {},
  /** 本番の日付（YYYY-MM-DD）。統計の逆算に使う */
  examDate: null,
};

// ---------------------------------------------------------------- 起動

// 握りつぶされた失敗を必ず表に出す。
// 保存できていないのに動いているように見えるのが、この種のアプリで一番たちが悪い。
addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
  toast("処理に失敗しました: " + (e.reason?.message ?? e.reason));
});
addEventListener("error", (e) => {
  if (!e.message) return;
  console.error(e.error ?? e.message);
  toast("エラーが起きました: " + e.message);
});

init().catch((e) => {
  console.error(e);
  toast("起動に失敗しました: " + e.message);
});

async function init() {
  await store.open();
  app.settings = { ...DEFAULT_SETTINGS, ...(await store.getMeta("settings", {})) };
  app.modes = app.settings.modes?.length ? app.settings.modes : DEFAULT_MODES;
  app.modeId = app.settings.modeId || "desk";
  makeFsrs();
  wireUI();
  setupInstall(); // beforeinstallprompt は起動直後に飛ぶので、描画より先に構える
  setupPullToRefresh();
  await loadCollection();
  renderModeStrip();
  await showHome();
  registerSW();
  requestPersistence();
}

function makeFsrs() {
  app.fsrs = new Fsrs({
    parameters: app.settings.parameters,
    desiredRetention: app.settings.desiredRetention,
    learningSteps: app.settings.learningSteps,
    relearningSteps: app.settings.relearningSteps,
    enableFuzz: true,
  });
}

async function sqlReady() {
  if (!app.sql) {
    app.sql = await initSqlJs({ locateFile: (f) => "vendor/" + f });
  }
  return {
    SQL: app.sql,
    JSZip: window.JSZip,
    zstdDecompress: (bytes) => window.fzstd.decompress(bytes),
  };
}

async function loadCollection() {
  const [notes, notetypes, decks, cards] = await Promise.all([
    store.getAll("notes"),
    store.getAll("notetypes"),
    store.getAll("decks"),
    store.getAll("cards"),
  ]);
  app.notes = new Map(notes.map((n) => [n.id, n]));
  app.notetypes = new Map(notetypes.map((n) => [n.id, n]));
  app.decks = decks;
  app.cards = cards;
}

// ---------------------------------------------------------------- 画面遷移

function show(viewId) {
  $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== viewId));
  $("#ai-panel").classList.add("hidden");
  $("#edit-panel").classList.add("hidden");
  // 学習中は通知帯を引っ込める（カードの上に居座ると邪魔になる）
  document.body.classList.toggle("studying", viewId === "view-study");
  window.scrollTo(0, 0);
}

async function showHome() {
  show("view-home");
  const has = app.cards.length > 0;
  $("#empty-state").classList.toggle("hidden", has);
  $("#home-body").classList.toggle("hidden", !has);
  await refreshBackupBanner();
  await refreshResumeBanner();
  if (!has) return;

  await refreshTodayCounts();
  const rev = await store.revlogSince(dayStart(Date.now(), app.settings.rolloverHour));
  const st = todayStats(rev, Date.now(), app.settings.rolloverHour);
  $("#today-date").textContent = new Date().toLocaleDateString("ja-JP", {
    month: "long", day: "numeric", weekday: "short",
  });
  const q = currentQueue();
  $("#today-counts").innerHTML = `
    <div class="c new"><span class="n">${q.counts.new}</span><span class="l">新しい</span></div>
    <div class="c learn"><span class="n">${q.counts.learning}</span><span class="l">学習中</span></div>
    <div class="c rev"><span class="n">${q.counts.review}</span><span class="l">復習</span></div>
    <div class="c"><span class="n">${st.reviews}</span><span class="l">今日やった</span></div>`;
  const target = st.reviews + q.counts.total;
  $("#today-progress .bar").style.width = target ? `${(st.reviews / target) * 100}%` : "0%";
  $("#today-note").textContent = st.retention == null
    ? "まだ今日は始めていません"
    : `今日の正答率 ${(st.retention * 100).toFixed(0)}%・所要 ${Math.round(st.timeMs / 60000)}分`;

  renderDeckList();
  const flagged = app.cards.filter((c) => c.flags && !c.suspended).length;
  const fb = $("#btn-only-flagged");
  fb.classList.toggle("on", app.onlyFlagged);
  fb.classList.toggle("hidden", flagged === 0 && !app.onlyFlagged);
  fb.textContent = app.onlyFlagged ? `🚩 解除` : `🚩 ${flagged}`;
  // 今日のぶんが尽きても、まだ出せる札が残っているならホームから続けられるようにする。
  // （終了画面の「制限を超えて続ける」はホームに戻ると押せなくなり、行き止まりだった）
  const extra = (q.available?.review ?? 0) + (q.available?.new ?? 0);
  const btnStudy = $("#btn-study-all");
  btnStudy.dataset.more = "";
  if (q.counts.total) {
    btnStudy.textContent = `学習をはじめる（${q.counts.total}枚）`;
    btnStudy.disabled = false;
  } else if (extra) {
    btnStudy.textContent = `今日のぶんは終わり — さらに続ける（あと${extra}枚）`;
    btnStudy.disabled = false;
    btnStudy.dataset.more = "1";
  } else {
    // このモードでは品切れでも、条件のゆるいモードなら残っていることがある。
    // 灰色のボタンで行き止まりにせず、どこへ行けば続けられるかを出す。
    const alt = bestAlternativeMode();
    if (alt) {
      btnStudy.textContent = `「${alt.mode.name}」に切り替えて続ける（${alt.count}枚）`;
      btnStudy.disabled = false;
      btnStudy.dataset.more = "switch:" + alt.mode.id;
    } else {
      btnStudy.textContent = "今日のぶんは終わりました";
      btnStudy.disabled = true;
    }
  }
  // なぜ品切れなのかを言う（条件で落ちているだけ、と分かるように）
  const note = $("#study-hint");
  const m = app.modes.find((x) => x.id === app.modeId);
  const filtered = q.counts.total === 0 && m?.filter && (m.filter.maxChars || m.filter.allowImage === false);
  note.textContent = filtered
    ? `いまは「${m.name}」（${m.filter.maxChars ? m.filter.maxChars + "字まで" : ""}${m.filter.allowImage === false ? "・図なし" : ""}）に絞っています。`
    : "";
  note.classList.toggle("hidden", !filtered);
}

const deckNameById = () => new Map(app.decks.map((d) => [d.id, d.name]));
const deckNameOf = (did) => app.decks.find((d) => d.id === did)?.name;
const topDeckName = (did) => (app.decks.find((d) => d.id === did)?.name ?? "").split("::")[0];

/**
 * 今日すでに出した枚数を履歴から数え直す。
 * これを渡さないと「1日の上限」が「1回の上限」になり、朝と夜で新規が二重に入る。
 */
async function refreshTodayCounts() {
  const rev = await store.revlogSince(dayStart(Date.now(), app.settings.rolloverHour));
  const cardById = new Map(app.cards.map((c) => [c.id, c]));
  let fresh = 0;
  const byDeck = {};
  for (const r of rev) {
    if (r.state !== State.New) continue; // 復習前の状態が New＝今日おろした新規
    fresh++;
    const top = topDeckName(cardById.get(r.cardId)?.did);
    byDeck[top] = (byDeck[top] ?? 0) + 1;
  }
  app.todayCounts = { new: fresh, review: Math.max(0, rev.length - fresh) };
  app.todayNewByDeck = byDeck;
}

function currentQueue() {
  const base = app.modes.find((m) => m.id === app.modeId) || app.modes[1];
  // 「さらに続ける」で上乗せした分を足す（設定そのものは変えない）
  const mode = app.extra
    ? {
        ...base,
        limits: {
          new: (base.limits?.new ?? 0) + app.extra.new,
          review: (base.limits?.review ?? 0) + app.extra.review,
        },
      }
    : base;
  return buildQueue({
    cards: app.cards,
    noteById: app.notes,
    notetypeById: app.notetypes,
    deckIds: app.selectedDeckIds,
    mode,
    now: Date.now(),
    rolloverHour: app.settings.rolloverHour,
    todayCounts: app.todayCounts,
    deckNameById: deckNameById(),
    deckNewLimits: app.settings.deckNewLimits,
    todayNewByDeck: app.todayNewByDeck,
    shuffleSameDay: app.settings.shuffleSameDay,
    newOrder: app.settings.newOrder,
    onlyFlagged: app.onlyFlagged,
  });
}

// 折りたたみ状態はデッキ名で覚える（IDは取り込み直しで変わりうるため）
function collapsedSet() {
  try {
    const raw = localStorage.getItem("deck.collapsed");
    if (raw != null) return new Set(JSON.parse(raw));
  } catch { /* 壊れていたら初期状態として扱う */ }
  return null; // 未設定
}
const saveCollapsed = (set) =>
  localStorage.setItem("deck.collapsed", JSON.stringify([...set]));

const hasChildren = (name) => app.decks.some((x) => x.name.startsWith(name + "::"));

function toggleCollapse(name) {
  const set = collapsedSet() ?? new Set();
  if (set.has(name)) set.delete(name);
  else set.add(name);
  saveCollapsed(set);
  renderDeckList();
}

function toggleAllDecks() {
  const parents = app.decks.filter((d) => hasChildren(d.name)).map((d) => d.name);
  const set = collapsedSet() ?? new Set();
  // ひとつでも開いていれば「全部たたむ」、全部たたまれていれば「全部ひらく」
  const anyOpen = parents.some((n) => !set.has(n));
  saveCollapsed(anyOpen ? new Set(parents) : new Set());
  renderDeckList();
}

function renderDeckList() {
  // デッキごとの枚数を数える
  const per = new Map();
  const mode = app.modes.find((m) => m.id === app.modeId) || app.modes[1];
  for (const d of app.decks) per.set(d.id, { new: 0, learn: 0, rev: 0 });
  const endOfDay = dayStart(Date.now(), app.settings.rolloverHour) + 86400000;
  for (const c of app.cards) {
    const p = per.get(c.did);
    if (!p || c.suspended) continue;
    if (c.state === State.New) p.new++;
    else if (c.state === State.Learning || c.state === State.Relearning) p.learn++;
    else if (c.due <= endOfDay) p.rev++;
  }
  // 親デッキに子の数を積み上げる。
  // ※ 各デッキ「自身の」枚数だけを祖先へ足すこと。積み上げ済みの値を再度足すと二重計上になる
  const own = new Map([...per].map(([id, v]) => [id, { ...v }]));
  const byName = new Map(app.decks.map((d) => [d.name, d]));
  for (const d of app.decks) {
    const parts = d.name.split("::");
    const mine = own.get(d.id);
    for (let i = 1; i < parts.length; i++) {
      const parent = byName.get(parts.slice(0, i).join("::"));
      if (!parent) continue;
      const pp = per.get(parent.id);
      pp.new += mine.new; pp.learn += mine.learn; pp.rev += mine.rev;
    }
  }

  const sorted = [...app.decks].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const sel = app.selectedDeckIds ? new Set(app.selectedDeckIds) : null;

  // 初回は親を全部たたんでおく。48デッキが一度に並ぶと目的の階層まで届かない。
  let collapsed = collapsedSet();
  if (collapsed === null) {
    collapsed = new Set(app.decks.filter((d) => hasChildren(d.name)).map((d) => d.name));
    saveCollapsed(collapsed);
  }
  // 祖先のどれかがたたまれていれば表示しない
  const hidden = (name) => {
    const parts = name.split("::");
    for (let i = 1; i < parts.length; i++) {
      if (collapsed.has(parts.slice(0, i).join("::"))) return true;
    }
    return false;
  };

  // 配下も含めて1枚も無いデッキは出さない（Anki既定の "Default" が並ぶだけになる）
  const empty = (d) => {
    const p = per.get(d.id);
    return !p || (p.new === 0 && p.learn === 0 && p.rev === 0)
      ? !app.cards.some((c) => c.did === d.id || (deckNameOf(c.did) ?? "").startsWith(d.name + "::"))
      : false;
  };

  $("#deck-list").innerHTML = sorted
    .filter((d) => !hidden(d.name) && !empty(d))
    .map((d) => {
      const p = per.get(d.id) || { new: 0, learn: 0, rev: 0 };
      const depth = Math.min(3, d.name.split("::").length - 1);
      const leaf = d.name.split("::").pop();
      const num = (v, k) => `<span class="${v ? "n" + k : "zero"}">${v}</span>`;
      const parent = hasChildren(d.name);
      const shut = collapsed.has(d.name);
      // 子を持たないデッキにも同じ幅の場所を空けて、名前の頭を揃える
      const twist = parent
        ? `<button class="twist${shut ? " shut" : ""}" data-twist="${d.id}"
             aria-label="${shut ? "ひらく" : "たたむ"}" aria-expanded="${!shut}">▾</button>`
        : `<span class="twist empty" aria-hidden="true"></span>`;
      return `<div class="deck ${sel?.has(d.id) ? "selected" : ""}" data-id="${d.id}" data-depth="${depth}">
        ${twist}
        <span class="name">${escapeHtml(leaf)}</span>
        <span class="nums">${num(p.new, 0)}${num(p.learn, 1)}${num(p.rev, 2)}</span>
      </div>`;
    })
    .join("");

  const btn = $("#btn-collapse-all");
  if (btn) {
    const parents = app.decks.filter((d) => hasChildren(d.name)).map((d) => d.name);
    btn.classList.toggle("hidden", parents.length === 0);
    btn.textContent = parents.some((n) => !collapsed.has(n)) ? "たたむ" : "ひらく";
  }
}

// ---------------------------------------------------------------- 学習

function startStudy() {
  const q = currentQueue();
  app.queue = q.cards;
  app.qIndex = 0;
  app.counts = { new: q.counts.new, learning: q.counts.learning, review: q.counts.review };
  if (!app.queue.length) {
    show("view-study");
    finishScreen(q);
    return;
  }
  enterStudy();
  saveSession();
  nextCard();
}

/**
 * 上限を超えて続ける。
 * モードの設定そのものを書き換えると「その日だけ多めにやった」が翌日以降も効いてしまうので、
 * この起動中だけの上乗せとして持つ。
 */
/** いまのモードで品切れのとき、いちばん多く出せる別のモードを探す */
function bestAlternativeMode() {
  let best = null;
  for (const m of app.modes) {
    if (m.id === app.modeId) continue;
    const q = buildQueue({
      cards: app.cards, noteById: app.notes, notetypeById: app.notetypes,
      deckIds: app.selectedDeckIds, mode: m, now: Date.now(),
      rolloverHour: app.settings.rolloverHour,
      deckNameById: deckNameById(), onlyFlagged: app.onlyFlagged,
    });
    const count = q.available.new + q.available.review;
    if (count > 0 && (!best || count > best.count)) best = { mode: m, count };
  }
  return best;
}

function studyMore() {
  app.extra = { new: (app.extra?.new ?? 0) + 20, review: (app.extra?.review ?? 0) + 50 };
  startStudy();
}

function enterStudy() {
  show("view-study");
  $("#finished").classList.add("hidden");
  $("#card-area").classList.remove("hidden");
  $("#answer-bar").classList.remove("hidden");
  $("#study-tools").classList.remove("hidden");
  $("#study-progress").classList.remove("hidden");
  $("#study-progress-text").classList.remove("hidden");
}

// ------------------------------------------------ 中断と再開

/**
 * いまの並びと位置を残す。通学中に使う前提だと中断は日常なので、
 * 開き直したときに最初からやり直しにならないようにする。
 */
function saveSession() {
  store
    .setMeta("session", {
      ids: app.queue.map((c) => c.id),
      qIndex: app.qIndex,
      modeId: app.modeId,
      deckIds: app.selectedDeckIds,
      at: Date.now(),
    })
    .catch(() => {});
}

const clearSession = () => store.setMeta("session", null).catch(() => {});

async function refreshResumeBanner() {
  const el = $("#resume-banner");
  if (!el || el.dataset.dismissed === "1") return;
  const s = await store.getMeta("session", null);
  const sameDay = s && s.at >= dayStart(Date.now(), app.settings.rolloverHour);
  const left = s ? s.ids.length - s.qIndex : 0;
  if (!s || !sameDay || left <= 0) {
    el.classList.add("hidden");
    return;
  }
  $("#resume-msg").textContent = `途中まで進めた学習が残っています（あと ${left} 枚）。`;
  el.classList.remove("hidden");
}

async function resumeSession() {
  const s = await store.getMeta("session", null);
  if (!s) return toast("続きが見つかりませんでした");
  const byId = new Map(app.cards.map((c) => [c.id, c]));
  // 消えたカード・保留にしたカードは飛ばす（並びと位置は保つ）
  const kept = [];
  let idx = 0;
  s.ids.forEach((id, i) => {
    const c = byId.get(id);
    if (!c || c.suspended) return;
    if (i < s.qIndex) idx = kept.length + 1;
    kept.push(c);
  });
  if (!kept.length || idx >= kept.length) {
    await clearSession();
    return toast("続きはもう残っていません");
  }
  app.modeId = s.modeId || app.modeId;
  app.selectedDeckIds = s.deckIds ?? null;
  app.queue = kept;
  app.qIndex = idx;
  $("#resume-banner").classList.add("hidden");
  renderModeStrip();
  enterStudy();
  await nextCard();
}

/** 残り枚数を出す。分母は学習中カードの出し直しで増えることがある */
function updateProgress() {
  const total = app.queue.length;
  const done = Math.min(app.qIndex, total);
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("#study-progress .bar").style.width = pct + "%";
  $("#study-progress-text").textContent = total ? `${done + 1} / ${total} 枚目` : "";
}

function finishScreen(q) {
  $("#card-area").classList.add("hidden");
  $("#answer-bar").classList.add("hidden");
  $("#study-tools").classList.add("hidden");
  $("#finished").classList.remove("hidden");
  const extra = (q?.available?.review ?? 0) + (q?.available?.new ?? 0);
  $("#finished-detail").textContent = extra
    ? `このモードの上限を超えて、あと ${extra} 枚出せます。`
    : "このデッキで今日出せるカードはもうありません。";
  $("#btn-more").classList.toggle("hidden", !extra);
}

async function nextCard() {
  if (app.qIndex >= app.queue.length) {
    // 学習中カードで、まだ時間が来ていないものが残っていれば待たずに再取得
    const q = currentQueue();
    if (q.cards.length) {
      app.queue = q.cards;
      app.qIndex = 0;
    } else {
      await clearSession(); // やり切ったので「続きから」は出さない
      await showHome();
      finishScreen(q);
      show("view-study");
      return;
    }
  }
  app.current = app.queue[app.qIndex];
  app.revealed = false;
  app.shownAt = Date.now();
  updateProgress();
  await drawCard(false);
}

async function drawCard(reveal) {
  const c = app.current;
  const note = app.notes.get(c.nid);
  const nt = app.notetypes.get(note.mid);
  const tmpl = nt.templates[Math.min(c.ord, nt.templates.length - 1)] || nt.templates[0];
  const deck = app.decks.find((d) => d.id === c.did);

  const { question, answer } = renderCard({
    note,
    notetype: nt,
    template: tmpl,
    deckName: deck?.name ?? "",
    ord: c.ord,
  });
  let html = reveal ? answer : question;
  html = await withMedia(html);

  const area = $("#card-content");
  area.classList.add("typesetting");
  area.style.fontSize = `${app.settings.fontSize}px`;
  // カードは他人が作った可能性のあるHTML。実行できる要素と外部通信を落としてから入れる
  area.innerHTML =
    `<style>${sanitizeCardCss(nt.css || "")}</style>`
    + `<div class="card">${sanitizeCardHtml(html)}</div>`;
  if (app.settings.hideCardAILinks) stripExternalAILinks(area);
  await typeset(area);
  area.classList.remove("typesetting");

  $("#study-deck").textContent = deck?.name.split("::").pop() ?? "";
  const remain = app.queue.length - app.qIndex;
  $("#study-counts").innerHTML =
    `<span class="n0">残り ${remain}</span>` +
    (c.state === State.New ? '<span class="n0">新しいカード</span>' : "") +
    (c.lapses > 2 ? `<span class="n1">${c.lapses}回まちがえた</span>` : "");

  const two = Number(app.settings.gradingButtons) === 2;
  $("#btn-show").classList.toggle("hidden", reveal);
  $("#grade-buttons").classList.toggle("hidden", !reveal || two);
  $("#grade-buttons-2").classList.toggle("hidden", !reveal || !two);
  if (reveal) {
    updateGradeLabels();
    guardGrades();
    if (app.settings.autoScrollToAnswer) scrollToAnswer(area);
  }
}

/**
 * カードのテンプレートに埋め込まれた「外部AIに聞く」ボタン群を取り除く。
 * このアプリはカードを離れずに聞けるので、同じものが二重に並ぶのを避ける。
 * （カードのデータ自体は変更しない。表示時に隠すだけ）
 */
const EXTERNAL_AI_HREF = ["claude.ai", "chatgpt.com", "chat.openai.com", "gemini.google.com", "google.com/search", "perplexity.ai"];
// href がダミーで、押したときに JS が URL を組み立てる作りのカードもあるので文字でも見る
const EXTERNAL_AI_TEXT = /(claude|chatgpt|gemini|copilot|perplexity|に聞く|質問をコピー|web\s*検索)/i;

function stripExternalAILinks(area) {
  const hits = [...area.querySelectorAll("a,button")].filter((el) => {
    const href = el.getAttribute("href") || "";
    if (EXTERNAL_AI_HREF.some((h) => href.includes(h))) return true;
    return EXTERNAL_AI_TEXT.test(el.textContent || "");
  });
  const bars = new Set();
  for (const el of hits) {
    const parent = el.parentElement;
    // ボタンが並んだ「帯」ごと消す。単体なら要素だけ消す
    if (parent && parent !== area && parent.querySelectorAll("a,button").length >= 2) bars.add(parent);
    else el.remove();
  }
  for (const bar of bars) bar.remove();
  // 帯と一緒に埋め込まれている隠しプロンプト（textarea）も片付ける
  area.querySelectorAll("textarea").forEach((t) => {
    if (t.offsetParent === null || /display\s*:\s*none/.test(t.getAttribute("style") || "")) t.remove();
  });
}

/**
 * 縦長カード対策: 解答の始まりまで自動でスクロールする。
 * 本家テンプレートの慣習（<hr id=answer>）と、我々のデッキの .a / .a-head を目印にする。
 */
function scrollToAnswer(area) {
  const mark =
    area.querySelector("#answer") ||
    area.querySelector("hr[id='answer']") ||
    area.querySelector(".a-head") ||
    area.querySelector(".a");
  if (!mark) return;
  const top = mark.getBoundingClientRect().top + window.scrollY - 70;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

/** 解答が出た直後の連打で誤って採点しないよう、少しだけ受け付けない */
function guardGrades() {
  const ms = Number(app.settings.gradeGuardMs) || 0;
  const btns = $$(".grade");
  if (!ms) {
    btns.forEach((b) => b.removeAttribute("disabled"));
    return;
  }
  btns.forEach((b) => b.setAttribute("disabled", ""));
  clearTimeout(guardGrades._t);
  guardGrades._t = setTimeout(() => btns.forEach((b) => b.removeAttribute("disabled")), ms);
}

/** メディア参照を Blob URL に差し替える（必要な分だけ作る） */
async function withMedia(html) {
  const names = [...html.matchAll(/src="([^"]+)"/g)]
    .map((m) => decodeURIComponent(m[1]))
    .filter((n) => !/^(https?:|data:|blob:)/i.test(n));
  for (const n of names) {
    if (!app.mediaUrls.has(n)) {
      const blob = await store.getMediaBlob(n);
      if (blob) app.mediaUrls.set(n, URL.createObjectURL(blob));
    }
  }
  return resolveMedia(html, (n) => app.mediaUrls.get(n));
}

async function typeset(el) {
  if (!window.MathJax?.typesetPromise) return;
  try {
    await window.MathJax.typesetPromise([el]);
  } catch (e) {
    console.warn("数式の描画に失敗:", e);
  }
}

function updateGradeLabels() {
  const preview = app.fsrs.preview(app.current, Date.now());
  $$(".grade").forEach((b) => {
    const r = Number(b.dataset.rating);
    b.querySelector(".g-ivl").textContent = humanInterval(preview[r]);
  });
}

/** 採点した直後だけ「戻す」を目立つ位置に出す（押し間違いのその場復帰） */
function showUndoStrip(rating) {
  const names = { 1: "思い出せない", 2: "あやふや", 3: "思い出せた", 4: "即答" };
  const strip = $("#undo-strip");
  $("#undo-text").textContent = `「${names[rating]}」で記録しました`;
  strip.classList.remove("hidden");
  clearTimeout(showUndoStrip._t);
  showUndoStrip._t = setTimeout(() => strip.classList.add("hidden"), 4000);
}

async function grade(rating) {
  const c = app.current;
  const now = Date.now();
  const duration = now - app.shownAt;
  const { card: next, log } = app.fsrs.review(c, rating, now, duration);

  const leechMsg = applyLeech(next, c, rating);

  // 先に保存する。容量不足などで書けなかったときに「答えたのに記録されていない」を
  // 黙って通さないため、画面を進める前に確定させる。
  try {
    await store.put("cards", next);
    await store.addRevlog({ ...log, cardId: c.id });
  } catch (e) {
    console.error(e);
    toast("保存できませんでした。この回答は記録されていません（空き容量をご確認ください）");
    return; // 進めない。同じカードのまま留まる
  }

  app.lastAnswer = { before: { ...c }, after: next, index: app.qIndex, buried: [] };
  showUndoStrip(rating);
  const idx = app.cards.findIndex((x) => x.id === c.id);
  if (idx >= 0) app.cards[idx] = next;

  // 今日の枚数を持ち回す（1日の上限を効かせるため。履歴の読み直しはしない）
  if (c.state === State.New) {
    app.todayCounts.new++;
    const top = topDeckName(c.did);
    app.todayNewByDeck[top] = (app.todayNewByDeck[top] ?? 0) + 1;
  } else {
    app.todayCounts.review++;
  }

  await burySiblingsOf(c);
  if (leechMsg) toast(leechMsg);

  // 学習中カードは同じセッションでもう一度出す
  app.qIndex++;
  saveSession();
  if ((next.state === State.Learning || next.state === State.Relearning) && next.due <= now + 20 * 60000) {
    app.queue.splice(Math.min(app.qIndex + 2, app.queue.length), 0, next);
  }
  await nextCard();
}

/**
 * 何度も間違えるカードを拾う。
 * 覚え方そのものが合っていないことが多く、放っておくと毎日出続けて時間を食う。
 */
function applyLeech(next, before, rating) {
  const th = app.settings.leechThreshold ?? 0;
  if (!th || rating !== Rating.Again) return null;
  if ((next.lapses ?? 0) < th) return null;
  // しきい値を跨いだ回だけ知らせる（以後は毎回言わない）
  if ((before.lapses ?? 0) >= th) return null;

  next.isLeech = true;
  const note = app.notes.get(next.nid);
  if (note && !note.tags.includes("leech")) {
    note.tags = [...note.tags, "leech"];
    store.put("notes", note).catch(() => {});
  }
  if (app.settings.leechAction === "suspend") {
    next.suspended = true;
    return `${th}回まちがえたので出題を止めました（設定→「保留中のカード」で戻せます）`;
  }
  return `${th}回まちがえています。覚え方を変えてみてください`;
}

/** 同じノートから作られた別のカードを、その日はもう出さない */
async function burySiblingsOf(card) {
  if (!app.settings.burySiblings) return;
  const until = dayEnd(Date.now(), app.settings.rolloverHour);
  const buried = [];
  for (const s of app.cards) {
    if (s.nid !== card.nid || s.id === card.id) continue;
    if (s.suspended || (s.buriedUntil ?? 0) >= until) continue;
    const nextS = { ...s, buriedUntil: until };
    const i = app.cards.indexOf(s);
    app.cards[i] = nextS;
    await store.put("cards", nextS);
    buried.push(s);
  }
  if (app.lastAnswer) app.lastAnswer.buried = buried;
}

async function undo() {
  if (!app.lastAnswer) return toast("取り消せる操作がありません");
  const { before, index, buried } = app.lastAnswer;
  const idx = app.cards.findIndex((x) => x.id === before.id);
  if (idx >= 0) app.cards[idx] = before;
  await store.put("cards", before);
  // 伏せた兄弟カードも元に戻す（戻したのに出てこない、を防ぐ）
  for (const s of buried ?? []) {
    const i = app.cards.findIndex((x) => x.id === s.id);
    if (i >= 0) app.cards[i] = s;
    await store.put("cards", s);
  }
  if (before.state === State.New) {
    app.todayCounts.new = Math.max(0, app.todayCounts.new - 1);
    const top = topDeckName(before.did);
    app.todayNewByDeck[top] = Math.max(0, (app.todayNewByDeck[top] ?? 1) - 1);
  } else {
    app.todayCounts.review = Math.max(0, app.todayCounts.review - 1);
  }
  app.qIndex = index;
  app.queue[index] = before;
  app.lastAnswer = null;
  await nextCard();
  toast("1つ戻しました");
}

// ---------------------------------------------------------------- 取り込み・書き出し

async function importFile(file) {
  busy(`${file.name} を読み込んでいます…`);
  try {
    const deps = await sqlReady();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = await readApkg(bytes, deps);

    busy(`${data.notes.length} ノートを保存しています…`);
    await store.putAll("notetypes", data.notetypes);
    await store.putAll("decks", data.decks);
    await store.putAll("notes", data.notes);

    // 学習履歴からカードごとの最終復習時刻を出す
    const lastByCard = new Map();
    for (const r of data.revlog) {
      const prev = lastByCard.get(r.cid) ?? 0;
      if (r.reviewedAt > prev) lastByCard.set(r.cid, r.reviewedAt);
    }
    const cards = data.cards.map((c) => toStudyCard(c, data.crt, lastByCard.get(c.id) ?? null));
    await store.putAll("cards", cards);
    if (data.revlog.length) {
      await store.putAll(
        "revlog",
        data.revlog.map((r) => ({
          id: r.id, cardId: r.cid, rating: r.rating, reviewedAt: r.reviewedAt,
          durationMs: r.durationMs, imported: true,
        }))
      );
    }
    busy(`画像・音声 ${data.media.size} 件を保存しています…`);
    await store.putMedia(data.media);
    await store.setMeta("crt", data.crt);

    await loadCollection();
    await showHome();
    toast(`${data.notes.length}ノート / ${cards.length}カード を取り込みました`);
  } finally {
    unbusy();
  }
}

// ------------------------------------------------ 学習履歴だけの控え
//
// デッキ本体（数MB）はめったに変わらないのに、毎回まるごと運ぶのは重い。
// 失って困るのは「どこまで覚えたか」なので、そこだけを小さく取り出せるようにする。
// 圧縮すると数十KBに収まり、メモ帳やメールにも置ける。

const HISTORY_FIELDS = [
  "id", "nid", "did", "ord", "state", "step", "due", "stability", "difficulty",
  "lastReview", "reps", "lapses", "suspended", "flags", "isLeech", "newPos",
];

async function gzip(text) {
  if (typeof CompressionStream !== "function") return new Blob([text]);
  const cs = new CompressionStream("gzip");
  const stream = new Blob([text]).stream().pipeThrough(cs);
  return new Response(stream).blob();
}

async function gunzip(blob) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) return blob.text(); // 圧縮していない控え
  const ds = new DecompressionStream("gzip");
  return new Response(blob.stream().pipeThrough(ds)).text();
}

/**
 * 利用者に「ときどき書き出してください」と頼るのは、いつか失うのと同じ。
 * かといってブラウザは操作なしにファイルを書けない。
 * そこで「学習をはじめる」など、利用者がどのみち押すタップに相乗りして、
 * 期限が来ていれば裏で控えを保存する。追加の操作はゼロ。
 *
 * 置き場所は端末のダウンロード先。ブラウザの保存領域の外なので、
 * 「閲覧データの削除」やアプリの削除では消えない。
 */
async function autoBackupIfDue() {
  try {
    const days = backupDays();
    if (!days || !app.cards.length) return;
    const last = await store.getMeta("lastExportAt", null);
    const elapsed = last == null ? Infinity : (Date.now() - last) / 86400000;
    if (elapsed < days) return;
    await exportHistory({ silent: true });
  } catch (e) {
    console.warn("自動の控えに失敗:", e);
  }
}

async function exportHistory({ silent = false } = {}) {
  if (!silent) busy("学習履歴をまとめています…");
  try {
    const revlog = await store.revlogSince(0);
    const payload = {
      kind: "kioku-history",
      version: 1,
      exportedAt: Date.now(),
      cards: app.cards.map((c) => {
        const o = {};
        for (const k of HISTORY_FIELDS) if (c[k] !== undefined) o[k] = c[k];
        return o;
      }),
      revlog,
    };
    const blob = await gzip(JSON.stringify(payload));
    const name = `記憶_履歴_${new Date().toISOString().slice(0, 10)}.json.gz`;

    if (silent) {
      // 自動のときは共有画面を出さない（学習を始めようとしている人の邪魔をしない）
      downloadBlob(blob, name);
    } else {
      const file = new File([blob], name, { type: "application/gzip" });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: name });
        } catch (e) {
          if (e?.name !== "AbortError") downloadBlob(blob, name);
        }
      } else {
        downloadBlob(blob, name);
      }
    }
    await store.setMeta("lastExportAt", Date.now());
    await refreshBackupBanner();
    toast(
      silent
        ? `学習履歴の控えを保存しました（${(blob.size / 1024).toFixed(0)}KB・自動）`
        : `学習履歴を書き出しました（${(blob.size / 1024).toFixed(0)}KB）`
    );
  } finally {
    if (!silent) unbusy();
  }
}

/** 控えを今のデッキに重ねる。カードは .apkg 由来のIDで突き合わせる。 */
async function importHistory(file) {
  busy("学習履歴を戻しています…");
  try {
    const data = JSON.parse(await gunzip(file));
    if (data?.kind !== "kioku-history") {
      return toast("これは学習履歴の控えではありません（.apkg なら「読み込む」から）");
    }
    const byId = new Map(app.cards.map((c) => [c.id, c]));
    let applied = 0;
    const updated = [];
    for (const rec of data.cards ?? []) {
      const cur = byId.get(rec.id);
      if (!cur) continue; // そのデッキを入れていなければ飛ばす
      updated.push({ ...cur, ...rec });
      applied++;
    }
    if (!applied) {
      return toast("重ねる相手が見つかりません。先に同じデッキを読み込んでください");
    }
    await store.putAll("cards", updated);
    if (data.revlog?.length) {
      const have = new Set((await store.revlogSince(0)).map((r) => `${r.cardId}:${r.reviewedAt}`));
      const add = data.revlog
        .filter((r) => !have.has(`${r.cardId}:${r.reviewedAt}`))
        .map(({ id, ...rest }) => rest); // idは振り直す（重複を避ける）
      for (const r of add) await store.addRevlog(r);
    }
    await loadCollection();
    await showHome();
    const skipped = (data.cards?.length ?? 0) - applied;
    toast(`${applied}枚に学習履歴を戻しました` + (skipped ? `（${skipped}枚は対象のデッキが未読込）` : ""));
  } catch (e) {
    toast("戻せませんでした: " + e.message);
  } finally {
    unbusy();
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function exportAll() {
  busy("書き出しています…");
  try {
    const deps = await sqlReady();
    const media = new Map();
    for (const name of await store.mediaNames()) {
      const blob = await store.getMediaBlob(name);
      if (blob) media.set(name, new Uint8Array(await blob.arrayBuffer()));
    }
    const revlog = await store.revlogSince(0);
    const crt = await store.getMeta("crt", Date.now());
    const bytes = await writeApkg(
      {
        crt,
        notetypes: [...app.notetypes.values()],
        decks: app.decks,
        notes: [...app.notes.values()],
        cards: app.cards.map((c) => toAnkiCard(c, crt)),
        revlog: revlog.map((r, i) => ({
          id: r.reviewedAt + i, cid: r.cardId, rating: r.rating,
          ivl: r.scheduledDays ?? 0, lastIvl: 0, factor: 0,
          durationMs: r.durationMs ?? 0, type: 1,
        })),
        media,
      },
      deps
    );
    const name = `記憶_${new Date().toISOString().slice(0, 10)}.apkg`;
    const blob = new Blob([bytes], { type: "application/octet-stream" });

    // 端末の中に置くだけでは、端末を失えば一緒に消える。
    // 共有できる端末では、そのままドライブやメールへ送れるようにする。
    const file = new File([blob], name, { type: "application/octet-stream" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
      } catch (e) {
        if (e?.name !== "AbortError") downloadBlob(blob, name); // 共有できなければ従来どおり保存
      }
    } else {
      downloadBlob(blob, name);
    }
    await store.setMeta("lastExportAt", Date.now());
    await refreshBackupBanner();
    toast("書き出しました（Ankiで読み込めます）");
  } finally {
    unbusy();
  }
}

/**
 * URL から .apkg を取り込む。
 * 相手のサーバが別オリジンからの取得を許していないと fetch は必ず失敗するので、
 * そのときは「端末に保存してから読み込む」へ誘導する（黙って失敗させない）。
 */
async function importFromUrl(url) {
  if (!url) return;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return toast("URLの形式が正しくありません");
  }
  if (!/^https?:$/.test(u.protocol)) return toast("http/https のURLを入れてください");

  busy("ダウンロードしています…");
  try {
    const res = await fetch(u.href, { redirect: "follow" });
    if (!res.ok) throw new Error(`${res.status}`);
    const blob = await res.blob();
    if (blob.size < 100) throw new Error("中身が空です");
    const name = decodeURIComponent(u.pathname.split("/").pop() || "deck.apkg");
    unbusy();
    await importFile(new File([blob], name.endsWith(".apkg") || name.endsWith(".colpkg") ? name : name + ".apkg"));
  } catch (e) {
    unbusy();
    // TypeError = CORS かネットワーク。Google ドライブの共有リンクはここに落ちる。
    const cors = e instanceof TypeError;
    toast(
      cors
        ? "そのURLからは直接取り込めません（配布元が許可していません）。端末に保存してから「読み込む」で選んでください。"
        : "取り込めませんでした: " + (e.message || e)
    );
  }
}

// ------------------------------------------------ バックアップの催促

const backupDays = () => Number(localStorage.getItem("backup.days") ?? "7");

async function refreshBackupBanner() {
  const el = $("#backup-banner");
  const last = await store.getMeta("lastExportAt", null);
  const days = backupDays();

  const note = $("#last-export-note");
  if (note) {
    note.textContent = last
      ? `最後の書き出し: ${new Date(last).toLocaleString("ja-JP")}`
      : "まだ書き出していません。";
  }

  if (!app.cards.length || days === 0 || el.dataset.dismissed === "1") {
    el.classList.add("hidden");
    return;
  }
  const elapsed = last == null ? Infinity : (Date.now() - last) / 86400000;
  if (elapsed < days) {
    el.classList.add("hidden");
    return;
  }
  $("#backup-msg").textContent =
    last == null
      ? "まだ一度も書き出していません。端末の中だけにあるので、消えると戻せません。"
      : `前回の書き出しから ${Math.floor(elapsed)} 日たっています。`;
  el.classList.remove("hidden");
}

/**
 * ブラウザに「このデータは勝手に消さないで」と申告する。
 * 容量不足のときに真っ先に捨てられるのを防ぐ（学習履歴の全損対策）。
 */
/** iOS の Safari は、しばらく使わないサイトの保存領域を自動で消すことがある */
const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

async function requestPersistence() {
  const note = $("#storage-note");
  try {
    if (!navigator.storage?.persist) {
      if (note) note.textContent = "この端末では保存領域の保護状態を確認できません。";
      return;
    }
    const persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    let usage = "";
    if (navigator.storage.estimate) {
      const { usage: u } = await navigator.storage.estimate();
      if (u) usage = `　使用中: ${(u / 1048576).toFixed(1)}MB`;
    }
    app.persisted = persisted;
    if (note) {
      note.textContent = persisted
        ? "保存領域は保護されています（容量不足でも自動削除されません）。" + usage
        : "保存領域は保護されていません。ホーム画面に追加すると保護されやすくなります。" + usage;
    }
    // 保護されていない端末では、書き出しの催促を早める
    if (!persisted && localStorage.getItem("backup.days") == null) {
      localStorage.setItem("backup.days", isIOS() ? "3" : "5");
    }
    const warn = $("#storage-warn");
    if (warn) {
      const risky = !persisted;
      warn.classList.toggle("hidden", !risky);
      warn.textContent = risky
        ? isIOS()
          ? "⚠️ iPhone/iPad では、しばらく開かないと学習履歴が自動で消えることがあります。"
            + "ホーム画面に追加し、ときどき書き出してください。"
          : "⚠️ 保存領域が保護されていません。ホーム画面に追加すると消えにくくなります。"
        : "";
    }
  } catch {
    /* 対応していない端末では何もしない */
  }
}

// ------------------------------------------------ 引っ張って更新

/**
 * 画面を下に引っ張って更新する。
 * ホーム画面に入れると display:standalone になり、Chrome 標準の引っ張り更新が効かなくなる
 * （この画面は overscroll-behavior:contain でもある）ので、自前で用意する。
 */
function setupPullToRefresh() {
  const el = $("#ptr");
  const TRIGGER = 70;   // ここまで引いたら更新
  const MAX = 110;      // それ以上は伸びない
  let startY = 0;
  let pulling = false;  // 引っ張りと判定済み
  let tracking = false; // 指が触れていて、判定待ち
  let dist = 0;
  let busyNow = false;

  const overlayOpen = () =>
    !$("#ai-panel").classList.contains("hidden") || !$("#img-viewer").classList.contains("hidden");

  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0;

  function place(d) {
    el.style.transform = `translate(-50%, ${-48 + d}px) rotate(${d * 3}deg)`;
    el.style.opacity = String(Math.min(1, d / 40));
    el.classList.toggle("ready", d >= TRIGGER);
  }

  function reset(animate = true) {
    el.classList.toggle("snap", animate);
    el.classList.remove("ready", "spin");
    el.style.transform = "translate(-50%, -48px)";
    el.style.opacity = "0";
    pulling = tracking = false;
    dist = 0;
  }

  addEventListener("touchstart", (e) => {
    if (busyNow || e.touches.length !== 1 || !atTop() || overlayOpen()) return;
    startY = e.touches[0].clientY;
    tracking = true;
    pulling = false;
    el.classList.remove("snap");
  }, { passive: true });

  // passive:false でないと引っ張り中のスクロールを止められない
  addEventListener("touchmove", (e) => {
    if (!tracking || busyNow) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || !atTop()) {      // 上方向＝ふつうのスクロール。手を出さない
      if (!pulling) tracking = false;
      return;
    }
    if (!pulling && dy < 8) return; // タップやわずかな揺れでは反応しない
    pulling = true;
    e.preventDefault();
    dist = Math.min(MAX, dy * 0.5); // 指の動きより鈍く動かして「引っ張っている」感を出す
    place(dist);
  }, { passive: false });

  const finish = async () => {
    if (!pulling || busyNow) return reset();
    if (dist < TRIGGER) return reset();

    busyNow = true;
    el.classList.add("snap", "spin");
    el.style.transform = "translate(-50%, 16px)";
    el.style.opacity = "1";
    // 新しい版があれば拾ってから読み直す（ここが「更新」の本体）
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.update();
    } catch {
      /* 圏外などは無視して、そのまま読み直す */
    }
    location.reload();
  };
  addEventListener("touchend", finish, { passive: true });
  addEventListener("touchcancel", () => reset(), { passive: true });
}

// ------------------------------------------------ インストールと更新

let deferredInstall = null;

/** matchMedia が無い実行環境（検証用のDOM実装など）でも落ちないようにする */
const mediaMatches = (q) =>
  typeof matchMedia === "function" ? matchMedia(q).matches : false;

function setupInstall() {
  const note = $("#install-note");
  const btn2 = $("#btn-install-2");
  const standalone = mediaMatches("(display-mode: standalone)");

  if (standalone) {
    if (note) note.textContent = "すでにアプリとして起動しています。";
    if (btn2) btn2.disabled = true;
    return;
  }
  if (note) {
    note.textContent =
      "インストールできる状態になると、ここのボタンが押せるようになります。"
      + "（Chrome以外や、他アプリの中で開いた画面では出ません）";
  }

  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // 既定のバナーを止めて、こちらの好きな場所から出す
    deferredInstall = e;
    if ($("#install-banner").dataset.dismissed !== "1") {
      $("#install-banner").classList.remove("hidden");
    }
    if (btn2) btn2.disabled = false;
    if (note) note.textContent = "インストールできます。";
  });

  addEventListener("appinstalled", () => {
    deferredInstall = null;
    $("#install-banner").classList.add("hidden");
    if (btn2) btn2.disabled = true;
    if (note) note.textContent = "インストール済みです。";
    toast("ホーム画面に追加しました");
  });
}

async function doInstall() {
  if (!deferredInstall) {
    return toast("この端末ではまだインストールできません。Chromeのメニューからお試しください。");
  }
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  if (outcome !== "accepted") toast("インストールを取りやめました");
}

/** 自前のカード → Anki のカード行 */
function toAnkiCard(c, crtMs) {
  const typeMap = { [State.New]: 0, [State.Learning]: 1, [State.Review]: 2, [State.Relearning]: 3 };
  const type = typeMap[c.state] ?? 0;
  const dayOf = (ms) => Math.round((ms - crtMs) / 86400000);
  const isLearn = type === 1 || type === 3;
  return {
    id: c.id, nid: c.nid, did: c.did, ord: c.ord,
    ankiType: type,
    ankiQueue: c.suspended ? -1 : type === 0 ? 0 : isLearn ? 1 : 2,
    ankiDue: type === 0 ? c.newPos ?? 0 : isLearn ? Math.round(c.due / 1000) : dayOf(c.due),
    ivl: c.stability ? Math.max(1, Math.round(c.stability)) : c.legacyIvl ?? 0,
    factor: c.legacyFactor ?? 2500,
    reps: c.reps ?? 0, lapses: c.lapses ?? 0, left: 0, flags: c.flags ?? 0,
    // FSRS の記憶状態を本家と同じ形で持たせる
    data: c.stability
      ? JSON.stringify({ s: c.stability, d: c.difficulty, dr: app.settings.desiredRetention })
      : "",
  };
}

// ---------------------------------------------------------------- AI

/**
 * AIとのやりとりはカードごとに残す。
 * せっかく解説してもらっても消えていたら、次に同じカードが出たときにまた一から聞くことになる。
 * 履歴はノート単位（表裏どちらのカードでも同じものが出る）で meta に持つ。
 */
/**
 * AIの回答は Markdown で返ってくる。素のまま出すと `####` や `**` が見えて読みにくいので、
 * 見出し・強調・箇条書きだけを組む。数式は MathJax に渡すため \( \) はそのまま残す。
 */
function renderMarkdown(src) {
  const esc = (s) =>
    String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const inline = (s) =>
    esc(s)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

  const out = [];
  let list = null;   // "ul" | "ol"
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join("\n"))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  for (const raw of String(src).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); closeList(); continue; }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara(); closeList();
      out.push("<hr>");            // 区切り線。素のまま出すと「---」が見える
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); closeList();
      const lv = Math.min(6, h[1].length + 2); // 本文中なので h3 以下に落とす
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*・]\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? "ul" : "ol";
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline(ul ? ul[1] : ol[2])}</li>`);
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara();
  closeList();
  return out.join("");
}

const aiHistoryKey = (card) => `ai:${card.nid}`;
const loadAIHistory = (card) => store.getMeta(aiHistoryKey(card), []);

async function appendAIHistory(card, entry) {
  const list = await loadAIHistory(card);
  list.push(entry);
  // 際限なく増えると書き出しも重くなるので、直近だけ残す
  await store.setMeta(aiHistoryKey(card), list.slice(-20));
}

async function openAI() {
  if (!app.current) return;
  const panel = $("#ai-panel");
  panel.classList.remove("hidden");
  $("#ai-log").innerHTML = "";
  const ctx = buildContext(app.current, app.notes, app.notetypes, app.decks);

  // 前に聞いた内容を先に出す
  const past = await loadAIHistory(app.current);
  if (past.length) {
    const log = $("#ai-log");
    log.insertAdjacentHTML(
      "beforeend",
      `<div class="ai-past-head">このカードで前に聞いた内容（${past.length}件）
         <button id="ai-clear" class="btn small">消す</button></div>`
    );
    for (const e of past) {
      log.insertAdjacentHTML(
        "beforeend",
        `<div class="ai-msg me old">${escapeHtml(e.q)}</div>
         <div class="ai-msg ai old">${renderMarkdown(e.a)}</div>`
      );
    }
    typeset(log);
    $("#ai-clear").onclick = async () => {
      await store.setMeta(aiHistoryKey(app.current), []);
      log.innerHTML = "";
      toast("このカードの記録を消しました");
    };
    // 数式を組んでから位置を決める（組む前だと高さが変わって狂う）

    await typeset(log);
    // 最後に聞いた質問を上端に置く（末尾ではなく読み始めに合わせる）
    const lastQ = [...log.querySelectorAll(".ai-msg.me")].pop();
    if (lastQ) anchorToTop(lastQ);
  }
  $("#ai-quick").innerHTML = quickPrompts()
    .map((p, i) => `<button data-i="${i}">${p.label}</button>`)
    .join("");
  $("#ai-quick").onclick = (e) => {
    const b = e.target.closest("button");
    if (b) sendAI(quickPrompts()[Number(b.dataset.i)].prompt, ctx);
  };
  $("#ai-form").onsubmit = (e) => {
    e.preventDefault();
    const v = $("#ai-input").value.trim();
    if (v) {
      $("#ai-input").value = "";
      sendAI(v, ctx);
    }
  };
}

/**
 * その要素が読み取り欄の一番上に来るように送る。
 * 届くたびに末尾へ送ると、読み終わったとき末尾に貼りついて
 * 毎回わざわざ先頭まで戻ることになる。読み始めの位置を固定する。
 */
function anchorToTop(el) {
  const log = $("#ai-log");
  // 位置の基準（offsetParent）が何であっても正しく出せるよう、実際の座標差で求める
  const delta = el.getBoundingClientRect().top - log.getBoundingClientRect().top;
  log.scrollTop = Math.max(0, log.scrollTop + delta);
}

async function sendAI(prompt, ctx) {
  const log = $("#ai-log");
  log.insertAdjacentHTML("beforeend", `<div class="ai-msg me">${escapeHtml(prompt)}</div>`);
  const question = log.lastElementChild;
  const holder = document.createElement("div");
  holder.className = "ai-msg ai";
  holder.textContent = "…";
  log.appendChild(holder);
  // 質問を上端に置く。以後は下へ伸びていくので、そのまま上から読める
  anchorToTop(question);
  $("#ai-status").textContent = "考えています…";
  const card = app.current;
  try {
    // 届いたそばから出す。長い解説で無言のまま待たされないように。
    const answer = await askAI({
      prompt,
      context: ctx,
      settings: aiSettings(),
      onChunk: (_delta, full) => {
        // 伸びるたびに追いかけない。上端に置いた質問はそのまま
        holder.innerHTML = renderMarkdown(full);
      },
    });
    holder.innerHTML = renderMarkdown(answer);
    typeset(holder); // 数式は全部そろってから組む
    if (card) await appendAIHistory(card, { q: prompt, a: answer, at: Date.now() });
  } catch (e) {
    holder.textContent = "失敗しました: " + e.message;
  } finally {
    $("#ai-status").textContent = "";
    anchorToTop(question); // 組み直しで位置がずれることがあるので置き直す
  }
}

const aiSettings = () => ({
  provider: localStorage.getItem("ai.provider") || "gemini",
  key: localStorage.getItem("ai.key") || "",
  model: localStorage.getItem("ai.model") || "",
  base: localStorage.getItem("ai.base") || "",
});

/**
 * 試験日からの逆算。
 * 「1日の新規を何枚にするか」を勘で決めずに済むようにする。
 */
function examPlanHtml(remainingNew) {
  const iso = app.settings.examDate;
  if (!iso) {
    return `<div class="card-panel">
      <h2>試験までの見通し</h2>
      <p class="hint">設定で試験日を入れると、
        「この進度で全部に手が回るか」「1日何枚おろせばよいか」を出します。</p>
    </div>`;
  }
  const days = Math.ceil((new Date(iso + "T00:00:00").getTime() - Date.now()) / 86400000);
  if (days <= 0) {
    return `<div class="card-panel"><h2>試験までの見通し</h2>
      <p class="hint">試験日（${iso}）を過ぎています。設定で更新してください。</p></div>`;
  }
  const mode = app.modes.find((m) => m.id === app.modeId) || app.modes[1];
  const perDay = mode.limits?.new ?? 0;
  const daysNeeded = perDay > 0 ? Math.ceil(remainingNew / perDay) : Infinity;
  const need = Math.ceil(remainingNew / days);
  const inTime = daysNeeded <= days;

  const verdict = !perDay
    ? `いまのモードは新規を出さない設定です。未着手が <strong>${remainingNew}枚</strong> 残ります。`
    : inTime
      ? `いまの <strong>${perDay}枚/日</strong> なら、<strong>あと${daysNeeded}日</strong>で全部に一度は目を通せます（${days - daysNeeded}日の余裕）。`
      : `いまの <strong>${perDay}枚/日</strong> だと <strong>${daysNeeded}日</strong>かかり、<strong>${daysNeeded - days}日</strong>足りません。`;

  return `<div class="card-panel ${inTime || !perDay ? "" : "danger"}">
    <h2>試験までの見通し</h2>
    <div class="stat-grid">
      <div class="stat"><div class="v">${days}</div><div class="k">試験まで（日）</div></div>
      <div class="stat"><div class="v">${remainingNew}</div><div class="k">まだ出していない枚数</div></div>
      <div class="stat"><div class="v">${need}</div><div class="k">間に合わせるなら／日</div></div>
    </div>
    <p class="hint">${verdict}</p>
    <p class="hint">※「一度は目を通せる」だけの計算です。定着には復習が要るので、
      実際にはもう少し早めに一周し終えるのが安全です。</p>
  </div>`;
}

// ---------------------------------------------------------------- 統計

async function showStats() {
  show("view-stats");
  const rev = await store.revlogSince(0);
  const st = todayStats(rev, Date.now(), app.settings.rolloverHour);
  const fc = forecast(app.cards, 7, Date.now(), app.settings.rolloverHour);
  const max = Math.max(1, ...fc);
  const mature = app.cards.filter((c) => (c.stability ?? 0) >= 21).length;
  const young = app.cards.filter((c) => c.state === State.Review && (c.stability ?? 0) < 21).length;
  const fresh = app.cards.filter((c) => c.state === State.New).length;

  $("#stats-body").innerHTML = examPlanHtml(fresh) + `
    <div class="stat-grid">
      <div class="stat"><div class="v">${st.reviews}</div><div class="k">今日の枚数</div></div>
      <div class="stat"><div class="v">${st.retention == null ? "—" : (st.retention * 100).toFixed(0) + "%"}</div><div class="k">今日の正答率</div></div>
      <div class="stat"><div class="v">${Math.round(st.timeMs / 60000)}分</div><div class="k">今日の時間</div></div>
      <div class="stat"><div class="v">${rev.length}</div><div class="k">のべ復習回数</div></div>
    </div>
    <div class="card-panel" style="margin-top:1rem">
      <h2>これから7日の予定</h2>
      <div class="bars" id="forecast-bars">${fc.map((v) => `<div class="b" style="height:${(v / max) * 100}%"><span>${v || ""}</span></div>`).join("")}</div>
      <div class="bar-labels">${["今日", "明日", "3日", "4日", "5日", "6日", "7日"].map((l) => `<div>${l}</div>`).join("")}</div>
    </div>
    <div class="card-panel">
      <h2>カードの育ち具合</h2>
      <div class="stat-grid">
        <div class="stat"><div class="v" style="color:var(--good)">${mature}</div><div class="k">定着（21日以上）</div></div>
        <div class="stat"><div class="v" style="color:var(--warn)">${young}</div><div class="k">育成中</div></div>
        <div class="stat"><div class="v" style="color:var(--accent)">${fresh}</div><div class="k">未学習</div></div>
      </div>
    </div>`
    + historyHtml(rev)
    + byDeckHtml();
}

/** 直近14日の「やった枚数」と「正答率」。続いているか、崩れていないかを見る。 */
function historyHtml(rev) {
  const days = 14;
  const start = dayStart(Date.now(), app.settings.rolloverHour) - (days - 1) * 86400000;
  const buckets = Array.from({ length: days }, () => ({ n: 0, again: 0 }));
  for (const r of rev) {
    const i = Math.floor((r.reviewedAt - start) / 86400000);
    if (i < 0 || i >= days) continue;
    buckets[i].n++;
    if (r.rating === 1) buckets[i].again++;
  }
  const max = Math.max(1, ...buckets.map((b) => b.n));
  const doneDays = buckets.filter((b) => b.n > 0).length;
  const totalN = buckets.reduce((s, b) => s + b.n, 0);
  const totalAgain = buckets.reduce((s, b) => s + b.again, 0);
  const rate = totalN ? (1 - totalAgain / totalN) * 100 : null;

  const bars = buckets
    .map((b, i) => {
      const d = new Date(start + i * 86400000);
      const acc = b.n ? Math.round((1 - b.again / b.n) * 100) : null;
      const color = acc == null ? "var(--line)" : acc >= 85 ? "var(--good)" : acc >= 70 ? "var(--warn)" : "var(--bad, #e06c6c)";
      return `<div class="b" style="height:${(b.n / max) * 100}%;background:${color}"
                title="${d.getMonth() + 1}/${d.getDate()} ${b.n}枚 ${acc == null ? "" : acc + "%"}">
                <span>${b.n || ""}</span></div>`;
    })
    .join("");

  return `<div class="card-panel">
    <h2>この2週間</h2>
    <div class="stat-grid">
      <div class="stat"><div class="v">${doneDays}/${days}</div><div class="k">学習した日数</div></div>
      <div class="stat"><div class="v">${totalN}</div><div class="k">のべ枚数</div></div>
      <div class="stat"><div class="v">${rate == null ? "—" : rate.toFixed(0) + "%"}</div><div class="k">正答率</div></div>
    </div>
    <div class="bars" id="history-bars">${bars}</div>
    <p class="hint">棒の高さは枚数、色は正答率（緑85%以上・黄70%以上・赤それ未満）。
      赤が続くときは1日の新規枚数を減らすと落ち着きます。</p>
  </div>`;
}

/** 教科ごとの進み具合。どこが手薄かを一目で分かるようにする。 */
function byDeckHtml() {
  const tops = [...new Set(app.decks.map((d) => d.name.split("::")[0]))];
  const rows = tops
    .map((name) => {
      const cards = app.cards.filter((c) => topDeckName(c.did) === name && !c.suspended);
      if (!cards.length) return "";
      const mature = cards.filter((c) => (c.stability ?? 0) >= 21).length;
      const young = cards.filter((c) => c.state === State.Review && (c.stability ?? 0) < 21).length;
      const learn = cards.filter((c) => c.state === State.Learning || c.state === State.Relearning).length;
      const fresh = cards.filter((c) => c.state === State.New).length;
      const t = cards.length;
      const pct = (v) => (v / t) * 100;
      return `<div class="deck-stat">
        <div class="deck-stat-head">
          <span class="name">${escapeHtml(name)}</span>
          <span class="muted">${Math.round(pct(mature))}% 定着 / ${t}枚</span>
        </div>
        <div class="stack">
          <div style="width:${pct(mature)}%;background:var(--good)" title="定着 ${mature}"></div>
          <div style="width:${pct(young)}%;background:var(--warn)" title="育成中 ${young}"></div>
          <div style="width:${pct(learn)}%;background:var(--accent)" title="学習中 ${learn}"></div>
          <div style="width:${pct(fresh)}%;background:var(--line)" title="未学習 ${fresh}"></div>
        </div>
      </div>`;
    })
    .join("");
  if (!rows) return "";
  return `<div class="card-panel">
    <h2>教科ごとの進み具合</h2>
    ${rows}
    <p class="hint">緑＝定着（21日以上あけても覚えている）／黄＝育成中／青＝学習中／灰＝まだ出していない。</p>
  </div>`;
}

// ---------------------------------------------------------------- 設定

function showSettings() {
  show("view-settings");
  $("#set-dr").value = app.settings.desiredRetention;
  $("#set-dr-out").textContent = `${(app.settings.desiredRetention * 100).toFixed(0)}%`;
  $("#set-rollover").value = app.settings.rolloverHour;
  $("#set-grading").value = String(app.settings.gradingButtons);
  $("#set-guard").value = app.settings.gradeGuardMs;
  $("#set-autoscroll").checked = !!app.settings.autoScrollToAnswer;
  $("#set-hideailinks").checked = !!app.settings.hideCardAILinks;
  $("#set-fontsize").value = app.settings.fontSize;
  $("#set-fontsize-out").textContent = `${app.settings.fontSize}px`;
  const s = aiSettings();
  $("#set-ai-provider").value = s.provider;
  $("#set-ai-key").value = s.key;
  $("#set-ai-model").value = s.model;
  $("#set-ai-base").value = s.base;
  $("#set-backup-days").value = String(backupDays());
  $("#set-neworder").value = app.settings.newOrder ?? "position";
  $("#set-examdate").value = app.settings.examDate ?? "";
  $("#set-shuffleday").checked = app.settings.shuffleSameDay !== false;
  $("#set-burysiblings").checked = app.settings.burySiblings !== false;
  $("#set-leech-th").value = String(app.settings.leechThreshold ?? 8);
  $("#set-leech-action").value = app.settings.leechAction ?? "suspend";
  renderDeckLimitEditor();
  renderDeckDeleteList();
  renderSuspendedList();
  refreshBackupBanner();
  requestPersistence();

  $("#mode-editor").innerHTML = app.modes
    .map(
      (m, i) => `<div class="mode-row" data-i="${i}">
      <div class="mr-head"><span>${m.emoji}</span><span class="mr-name">${escapeHtml(m.name)}</span></div>
      <div class="muted">${escapeHtml(m.desc || "")}</div>
      <div class="mr-fields">
        <label>新規/日 <input type="number" min="0" max="999" data-k="new" value="${m.limits.new}"></label>
        <label>復習/日 <input type="number" min="0" max="9999" data-k="review" value="${m.limits.review}"></label>
        <label>1回の枚数 <input type="number" min="0" max="999" data-k="session" value="${m.sessionSize || 0}"></label>
        <label>文字数上限 <input type="number" min="0" max="9999" data-k="chars" value="${m.filter?.maxChars || 0}"></label>
        <label><input type="checkbox" data-k="img" ${m.filter?.allowImage === false ? "" : "checked"}> 図を出す</label>
      </div>
    </div>`
    )
    .join("");
}

async function saveSettings() {
  app.settings.desiredRetention = Number($("#set-dr").value);
  app.settings.rolloverHour = Number($("#set-rollover").value);
  app.settings.gradingButtons = Number($("#set-grading").value);
  app.settings.gradeGuardMs = Number($("#set-guard").value);
  app.settings.autoScrollToAnswer = $("#set-autoscroll").checked;
  app.settings.hideCardAILinks = $("#set-hideailinks").checked;
  app.settings.fontSize = Number($("#set-fontsize").value);
    app.settings.examDate = $("#set-examdate").value || null;
  app.settings.newOrder = $("#set-neworder").value;
  app.settings.shuffleSameDay = $("#set-shuffleday").checked;
  app.settings.burySiblings = $("#set-burysiblings").checked;
  app.settings.leechThreshold = Number($("#set-leech-th").value);
  app.settings.leechAction = $("#set-leech-action").value;
  const limits = {};
  for (const inp of $$("#deck-limit-editor input[data-deck]")) {
    const v = inp.value.trim();
    if (v !== "") limits[inp.dataset.deck] = Math.max(0, Number(v));
  }
  app.settings.deckNewLimits = limits;
  app.modes = app.modes.map((m, i) => {
    const row = $(`.mode-row[data-i="${i}"]`);
    if (!row) return m;
    const val = (k) => Number(row.querySelector(`[data-k="${k}"]`).value);
    return {
      ...m,
      limits: { new: val("new"), review: val("review") },
      sessionSize: val("session"),
      filter: {
        ...m.filter,
        maxChars: val("chars") || null,
        allowImage: row.querySelector('[data-k="img"]').checked,
      },
    };
  });
  app.settings.modes = app.modes;
  app.settings.modeId = app.modeId;
  await store.setMeta("settings", app.settings);
  makeFsrs();
}

// ------------------------------------------------ 図の拡大

const zoom = { scale: 1, x: 0, y: 0 };

function applyZoom() {
  const img = $("#img-viewer img");
  img.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  $("#img-viewer").classList.toggle("zoomed", zoom.scale > 1);
}

function resetZoom() {
  zoom.scale = 1;
  zoom.x = 0;
  zoom.y = 0;
  applyZoom();
}

/**
 * 図を指で拡げられるようにする。
 * 細かい図はタップで開いても読めないことがあり、そこで学習が止まる。
 */
function setupPinchZoom() {
  const el = $("#img-viewer");
  let start = null;   // 2本指の初期距離とそのときの倍率
  let pan = null;     // 1本指で動かしているときの起点
  let lastTap = 0;
  let moved = false;  // 動かしたか。動かした指離しをダブルタップと取り違えない

  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const clamp = () => {
    zoom.scale = Math.min(6, Math.max(1, zoom.scale));
    if (zoom.scale === 1) { zoom.x = 0; zoom.y = 0; }
  };

  el.addEventListener("touchstart", (e) => {
    moved = false;
    if (e.touches.length === 2) {
      start = { d: dist(e.touches), scale: zoom.scale };
      pan = null;
    } else if (e.touches.length === 1 && zoom.scale > 1) {
      pan = { x: e.touches[0].clientX - zoom.x, y: e.touches[0].clientY - zoom.y };
    }
  }, { passive: true });

  el.addEventListener("touchmove", (e) => {
    if (start && e.touches.length === 2) {
      e.preventDefault();
      moved = true;
      zoom.scale = start.scale * (dist(e.touches) / start.d);
      clamp();
      applyZoom();
    } else if (pan && e.touches.length === 1) {
      e.preventDefault();
      moved = true;
      zoom.x = e.touches[0].clientX - pan.x;
      zoom.y = e.touches[0].clientY - pan.y;
      applyZoom();
    }
  }, { passive: false });

  el.addEventListener("touchend", (e) => {
    if (e.touches.length === 0) { start = null; pan = null; }
    // 拡げたり動かしたりした直後の指離しは、叩いた回数に数えない
    if (moved) { lastTap = 0; moved = false; return; }
    // 素早く2回叩いたら等倍と2.5倍を行き来する
    const now = Date.now();
    if (e.changedTouches.length === 1 && now - lastTap < 300) {
      zoom.scale = zoom.scale > 1 ? 1 : 2.5;
      zoom.x = 0;
      zoom.y = 0;
      clamp();
      applyZoom();
      lastTap = 0;
      return;
    }
    lastTap = now;
  }, { passive: true });

  // PCではホイールで拡大
  el.addEventListener("wheel", (e) => {
    if (el.classList.contains("hidden")) return;
    e.preventDefault();
    zoom.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
    clamp();
    applyZoom();
  }, { passive: false });
}

// ------------------------------------------------ 検索

function showSearch() {
  show("view-search");
  $("#search-input").focus();
  runSearch();
}

/** 問題文・答え・タグ・デッキ名から探す。空白区切りは「すべて含む」扱い。 */
function runSearch() {
  const raw = $("#search-input").value.trim();
  const words = raw.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
  const withSusp = $("#search-suspended").checked;
  const onlyFlag = $("#search-flagged").checked;
  const deckName = new Map(app.decks.map((d) => [d.id, d.name]));

  const hits = [];
  for (const c of app.cards) {
    if (!withSusp && c.suspended) continue;
    if (onlyFlag && !c.flags) continue;
    const note = app.notes.get(c.nid);
    if (!note) continue;
    const hay = (
      stripHtml(note.fields.join(" ")) + " " + note.tags.join(" ") + " " + (deckName.get(c.did) ?? "")
    ).toLowerCase();
    if (words.length && !words.every((w) => hay.includes(w))) continue;
    // 件数は必ず全件数える。表示だけ絞る（数と一覧が食い違うと判断を誤らせる）
    hits.push({ card: c, note, deck: deckName.get(c.did) ?? "" });
  }

  const LIMIT = 300;
  const shown = Math.min(hits.length, LIMIT);
  const tail = hits.length > LIMIT ? `（多いので先頭${LIMIT}枚を表示）` : "";
  $("#search-meta").textContent = words.length
    ? `${hits.length} 枚 見つかりました${tail}`
    : `${hits.length} 枚${tail}　文字を入れると絞り込めます`;

  $("#search-results").innerHTML = hits
    .slice(0, LIMIT)
    .map((h) => {
      const q = stripHtml(h.note.fields[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
      const a = stripHtml(h.note.fields[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      const badges =
        (h.card.suspended ? `<span class="badge">保留</span>` : "") +
        (h.card.flags ? `<span class="badge flag">🚩</span>` : "") +
        (h.card.lapses ? `<span class="badge">${h.card.lapses}回</span>` : "");
      return `<div class="hit" data-cid="${h.card.id}">
        <div class="hit-q">${escapeHtml(q) || "(空)"}</div>
        <div class="hit-a muted">${escapeHtml(a)}</div>
        <div class="hit-meta muted">${escapeHtml(h.deck.split("::").pop())}${badges}</div>
        <div class="hit-actions">
          <button class="btn small" data-act="edit">直す</button>
          <button class="btn small" data-act="flag">${h.card.flags ? "印を外す" : "印"}</button>
          <button class="btn small" data-act="susp">${h.card.suspended ? "保留を解除" : "保留"}</button>
          <button class="btn small" data-act="study">これだけ学習</button>
        </div>
      </div>`;
    })
    .join("");
}

async function searchAction(cardId, act) {
  const i = app.cards.findIndex((c) => c.id === cardId);
  if (i < 0) return;
  const c = app.cards[i];
  if (act === "edit") return openEditor(app.notes.get(c.nid));
  if (act === "flag" || act === "susp") {
    const next = act === "flag"
      ? { ...c, flags: c.flags ? 0 : 1 }
      : { ...c, suspended: !c.suspended, isLeech: c.suspended ? false : c.isLeech };
    app.cards[i] = next;
    await store.put("cards", next);
    runSearch();
    return;
  }
  if (act === "study") {
    // 見つけたカードを1枚だけ、その場で出す（期限や上限は無視する）
    app.queue = [c];
    app.qIndex = 0;
    enterStudy();
    await nextCard();
  }
}

// ------------------------------------------------ カードを直す

let editingNote = null;
let creatingNew = false;

function fieldsFormFor(mid, values = []) {
  const nt = app.notetypes.get(mid);
  $("#edit-fields").innerHTML = (nt?.fields ?? [])
    .map((f, i) => `<label class="field edit-field">
      <span>${escapeHtml(f.name)}</span>
      <textarea data-fi="${i}" rows="4"></textarea>
    </label>`)
    .join("");
  $$("#edit-fields textarea").forEach((t) => {
    t.value = values[Number(t.dataset.fi)] ?? "";
  });
}

function openEditor(note) {
  if (!note) return toast("このカードの問題が見つかりません");
  creatingNew = false;
  editingNote = note;
  $("#edit-title").textContent = "✏️ カードを直す";
  $("#edit-target").classList.add("hidden");
  $("#edit-revert").classList.remove("hidden");
  fieldsFormFor(note.mid, note.fields);
  $("#edit-panel").classList.remove("hidden");
}

/** 気づいたことをその場でカードにする */
function openNewCard() {
  if (!app.notetypes.size) return toast("先にデッキを1つ読み込んでください（型が必要です）");
  creatingNew = true;
  editingNote = null;
  $("#edit-title").textContent = "＋ カードを作る";
  $("#edit-revert").classList.add("hidden");
  $("#edit-target").classList.remove("hidden");

  // 入れ先は、いま選んでいるデッキ→末端のデッキ の順で妥当なものを既定にする
  const leaves = app.decks.filter((d) => !hasChildren(d.name));
  const preferred = app.selectedDeckIds?.length
    ? app.decks.find((d) => app.selectedDeckIds.includes(d.id) && !hasChildren(d.name))
    : null;
  $("#edit-deck").innerHTML = (leaves.length ? leaves : app.decks)
    .map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`)
    .join("");
  if (preferred) $("#edit-deck").value = String(preferred.id);

  // 項目が少ない型（表・裏だけ）を既定にすると迷いにくい
  const types = [...app.notetypes.values()].sort((a, b) => a.fields.length - b.fields.length);
  $("#edit-notetype").innerHTML = types
    .map((n) => `<option value="${n.id}">${escapeHtml(n.name ?? "型")}（${n.fields.length}項目）</option>`)
    .join("");
  $("#edit-notetype").onchange = () => fieldsFormFor(Number($("#edit-notetype").value));
  fieldsFormFor(types[0].id);
  $("#edit-panel").classList.remove("hidden");
}

async function saveEdit() {
  const collect = (n) => {
    const out = new Array(n).fill("");
    for (const t of $$("#edit-fields textarea")) out[Number(t.dataset.fi)] = t.value;
    return out;
  };

  if (creatingNew) {
    const mid = Number($("#edit-notetype").value);
    const did = Number($("#edit-deck").value);
    const nt = app.notetypes.get(mid);
    const fields = collect(nt.fields.length);
    if (!fields.some((v) => v.trim())) return toast("中身が空です");

    const id = Date.now();
    // guid は Anki がノートを同一視するための値。無いと書き出しに失敗する。
    const guid = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(36))
      .join("")
      .slice(0, 10);
    const note = { id, guid, mid, fields, tags: [], mod: Math.floor(id / 1000), usn: -1 };
    // 型が持つテンプレートの数だけカードができる（本家と同じ考え方）
    const maxPos = app.cards.reduce((m, c) => Math.max(m, c.newPos ?? 0), 0);
    const cards = nt.templates.map((_, ord) => ({
      id: id + ord, nid: id, did, ord,
      state: State.New, due: Date.now(), step: 0,
      stability: null, difficulty: null, lastReview: null,
      reps: 0, lapses: 0, suspended: false, flags: 0, newPos: maxPos + 1,
    }));
    try {
      await store.put("notes", note);
      await store.putAll("cards", cards);
    } catch (e) {
      return toast("保存できませんでした: " + e.message);
    }
    app.notes.set(id, note);
    app.cards.push(...cards);
    $("#edit-panel").classList.add("hidden");
    toast(`カードを${cards.length}枚 作りました`);
    await showHome();
    return;
  }

  if (!editingNote) return;
  const fields = [...editingNote.fields];
  const got = collect(fields.length);
  got.forEach((v, i) => { fields[i] = v; });
  const next = { ...editingNote, fields, mod: Math.floor(Date.now() / 1000) };
  try {
    await store.put("notes", next);
  } catch (e) {
    return toast("保存できませんでした: " + e.message);
  }
  app.notes.set(next.id, next);
  editingNote = next;
  $("#edit-panel").classList.add("hidden");
  toast("直しました");
  // いま出しているカードなら描き直す
  if (app.current && app.current.nid === next.id) await drawCard(app.revealed);
  if (!$("#view-search").classList.contains("hidden")) runSearch();
}

// ------------------------------------------------ 保留の解除

/** 保留カードの見出し文（問題文の先頭）を作る */
function cardLabel(card) {
  const note = app.notes.get(card.nid);
  const text = stripHtml(note?.fields?.[0] ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, 60) || "(空のカード)";
}

function renderSuspendedList() {
  const el = $("#suspended-list");
  const all = $("#btn-unsuspend-all");
  if (!el) return;
  const list = app.cards.filter((c) => c.suspended);
  all.classList.toggle("hidden", list.length === 0);
  if (!list.length) {
    el.innerHTML = `<p class="hint">保留中のカードはありません。</p>`;
    return;
  }
  el.innerHTML =
    `<p class="hint">${list.length} 枚あります。${list.length > 50 ? "先頭50枚を出しています。" : ""}</p>` +
    list
      .slice(0, 50)
      .map(
        (c) => `<div class="deck-del">
          <span class="name">${escapeHtml(cardLabel(c))}</span>
          ${c.isLeech ? `<span class="muted">${c.lapses ?? 0}回</span>` : ""}
          <button class="btn small" data-unsuspend="${c.id}">解除</button>
        </div>`
      )
      .join("");
}

async function unsuspend(cards) {
  for (const c of cards) {
    const next = { ...c, suspended: false, isLeech: false };
    const i = app.cards.findIndex((x) => x.id === c.id);
    if (i >= 0) app.cards[i] = next;
    await store.put("cards", next);
    // leech タグも外す（また間違えればしきい値で付き直す）
    const note = app.notes.get(c.nid);
    if (note?.tags?.includes("leech")) {
      note.tags = note.tags.filter((t) => t !== "leech");
      await store.put("notes", note);
    }
  }
  renderSuspendedList();
  toast(`${cards.length} 枚を解除しました`);
}

// ------------------------------------------------ デッキの削除

/** そのデッキ（配下を含む）を消したら何が消えるかを先に数える */
function deletionPlan(topName) {
  const deckIds = app.decks
    .filter((d) => d.name === topName || d.name.startsWith(topName + "::"))
    .map((d) => d.id);
  const deckSet = new Set(deckIds);
  const cards = app.cards.filter((c) => deckSet.has(c.did));
  const keptNids = new Set(app.cards.filter((c) => !deckSet.has(c.did)).map((c) => c.nid));
  // 他のデッキからも使われているノートは残す
  const noteIds = [...new Set(cards.map((c) => c.nid))].filter((n) => !keptNids.has(n));
  return { deckIds, cards, noteIds };
}

/** どのノートからも参照されなくなった画像・音声を消す */
async function pruneMedia() {
  const used = new Set();
  for (const n of app.notes.values()) {
    for (const m of n.fields.join(" ").matchAll(/(?:src|data)="([^"]+)"|\[sound:([^\]]+)\]/g)) {
      const name = decodeURIComponent(m[1] || m[2] || "");
      if (name && !/^(https?:|data:|blob:)/i.test(name)) used.add(name);
    }
  }
  const all = await store.mediaNames();
  const orphans = all.filter((n) => !used.has(n));
  await store.del("media", orphans);
  return orphans.length;
}

async function deleteDeck(topName) {
  const plan = deletionPlan(topName);
  const msg =
    `「${topName}」を削除します。\n\n`
    + `・カード ${plan.cards.length} 枚\n`
    + `・問題 ${plan.noteIds.length} 件\n`
    + `・その学習履歴もすべて\n\n`
    + `元に戻せません。書き出しておくと復元できます。よろしいですか？`;
  if (!confirm(msg)) return;

  busy(`${topName} を削除しています…`);
  try {
    await store.delRevlogForCards(plan.cards.map((c) => c.id));
    await store.del("cards", plan.cards.map((c) => c.id));
    await store.del("notes", plan.noteIds);
    await store.del("decks", plan.deckIds);
    for (const n of plan.noteIds) await store.setMeta(`ai:${n}`, null); // AIの記録も道連れにする
    await loadCollection();
    const freed = await pruneMedia();
    app.selectedDeckIds = null;
    await clearSession();
    await showHome();
    toast(`「${topName}」を削除しました（メディア ${freed} 件も整理）`);
  } finally {
    unbusy();
  }
}

function renderDeckDeleteList() {
  const el = $("#deck-delete-list");
  if (!el) return;
  const tops = [...new Set(app.decks.map((d) => d.name.split("::")[0]))];
  if (!tops.length) {
    el.innerHTML = `<p class="hint">読み込んでいるデッキはありません。</p>`;
    return;
  }
  el.innerHTML = tops
    .map((n) => {
      const p = deletionPlan(n);
      return `<div class="deck-del">
        <span class="name">${escapeHtml(n)}</span>
        <span class="muted">${p.cards.length}枚</span>
        <button class="btn small danger" data-del="${escapeHtml(n)}">削除</button>
      </div>`;
    })
    .join("");
}

/** 教科（一番上のデッキ）ごとに1日の新規上限を決められるようにする */
function renderDeckLimitEditor() {
  const el = $("#deck-limit-editor");
  if (!el) return;
  const tops = [...new Set(app.decks.map((d) => d.name.split("::")[0]))]
    .filter((n) => app.cards.some((c) => topDeckName(c.did) === n && c.state === State.New));
  if (tops.length < 2) {
    // 教科がひとつしか無いときは、全体の上限と同じ意味になるので出さない
    el.innerHTML = "";
    return;
  }
  const lim = app.settings.deckNewLimits || {};
  el.innerHTML =
    `<h3 class="sub">教科ごとの新規上限（1日）</h3>
     <p class="hint">空欄なら制限なし。合計は上のモードの「新規/日」を超えません。
       指定しなくても、複数の教科がある日は<strong>順番に1枚ずつ</strong>配ります。</p>` +
    tops
      .map(
        (n) => `<label class="field deck-limit">
        <span>${escapeHtml(n)}</span>
        <input type="number" min="0" max="999" data-deck="${escapeHtml(n)}"
               value="${lim[n] ?? ""}" placeholder="制限なし">
      </label>`
      )
      .join("");
}

function renderModeStrip() {
  $("#mode-strip").innerHTML = app.modes
    .map(
      (m) =>
        `<button class="mode-chip" data-id="${m.id}" aria-pressed="${m.id === app.modeId}">${m.emoji} ${escapeHtml(m.name)}</button>`
    )
    .join("");
}

// ---------------------------------------------------------------- 配線

function wireUI() {
  $("#btn-home").onclick = showHome;
  $("#btn-stats").onclick = showStats;
  $("#btn-settings").onclick = showSettings;
  $("#btn-study-all").onclick = async () => {
    autoBackupIfDue(); // このタップに相乗りして控えを保存する（待たせない）
    const more = $("#btn-study-all").dataset.more || "";
    if (more === "1") return studyMore();
    if (more.startsWith("switch:")) {
      app.modeId = more.slice(7);
      app.settings.modeId = app.modeId;
      await store.setMeta("settings", app.settings);
      renderModeStrip();
      return studyMore();
    }
    startStudy();
  };
  $("#btn-back-home").onclick = showHome;
  $("#btn-more").onclick = studyMore;
  $("#btn-show").onclick = async () => {
    app.revealed = true;
    await drawCard(true);
  };
  $$(".grade").forEach((b) => (b.onclick = () => grade(Number(b.dataset.rating))));
  $("#btn-undo").onclick = undo;
  $("#undo-now").onclick = () => {
    $("#undo-strip").classList.add("hidden");
    undo();
  };

  // 図はタップで拡大（小さい図が読めない問題への対処）
  $("#card-content").addEventListener("click", (e) => {
    const img = e.target.closest("img");
    if (!img) return;
    resetZoom();
    $("#img-viewer img").src = img.src;
    $("#img-viewer").classList.remove("hidden");
  });
  const closeViewer = () => {
    $("#img-viewer").classList.add("hidden");
    resetZoom();
  };
  // 拡大中に閉じないよう、背景の素押しだけで閉じる
  $("#img-viewer").onclick = (e) => { if (e.target.id === "img-viewer" && zoom.scale === 1) closeViewer(); };
  $("#img-close").onclick = closeViewer;
  setupPinchZoom();
  $("#btn-ai").onclick = openAI;
  $("#ai-close").onclick = () => $("#ai-panel").classList.add("hidden");
  $("#btn-suspend").onclick = async () => {
    const c = { ...app.current, suspended: true };
    await store.put("cards", c);
    const i = app.cards.findIndex((x) => x.id === c.id);
    if (i >= 0) app.cards[i] = c;
    app.qIndex++;
    toast("このカードを保留にしました");
    await nextCard();
  };
  $("#btn-flag").onclick = async () => {
    const c = { ...app.current, flags: app.current.flags ? 0 : 1 };
    await store.put("cards", c);
    app.current = c;
    $("#btn-flag").classList.toggle("on", !!c.flags);
  };

  $("#file-import").onchange = (e) => e.target.files[0] && importFile(e.target.files[0]);
  $("#file-import-empty").onchange = (e) => e.target.files[0] && importFile(e.target.files[0]);
  $("#btn-export").onclick = exportAll;
  $("#btn-export-2").onclick = exportAll;
  $("#btn-export-hist").onclick = exportHistory;
  $("#file-import-hist").onchange = (e) => e.target.files[0] && importHistory(e.target.files[0]);

  const askUrl = () =>
    importFromUrl(prompt("デッキ（.apkg）の直リンクURLを貼り付けてください", "https://"));
  if ($("#btn-import-url")) $("#btn-import-url").onclick = askUrl;
  $("#btn-import-url-empty").onclick = askUrl;

  // 通知帯
  $("#banners").addEventListener("click", (e) => {
    const x = e.target.closest("[data-close]");
    if (!x) return;
    const el = $("#" + x.dataset.close);
    el.classList.add("hidden");
    el.dataset.dismissed = "1"; // この起動中は出し直さない
  });
  $("#btn-reload").onclick = () => location.reload();
  $("#btn-install").onclick = doInstall;
  $("#btn-install-2").onclick = doInstall;
  $("#btn-backup-now").onclick = exportAll;
  $("#btn-collapse-all").onclick = toggleAllDecks;
  $("#btn-search").onclick = showSearch;
  let searchTimer = null;
  $("#search-input").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 180); // 打つたびに全件走らせない
  };
  $("#search-suspended").onchange = runSearch;
  $("#search-flagged").onchange = runSearch;
  $("#search-results").onclick = (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const hit = b.closest(".hit");
    searchAction(Number(hit.dataset.cid), b.dataset.act);
  };
  $("#btn-edit").onclick = () => openEditor(app.notes.get(app.current?.nid));
  $("#btn-new-card").onclick = openNewCard;
  $("#edit-close").onclick = () => $("#edit-panel").classList.add("hidden");
  $("#edit-save").onclick = saveEdit;
  $("#edit-revert").onclick = () => openEditor(editingNote);

  $("#btn-only-flagged").onclick = async () => {
    app.onlyFlagged = !app.onlyFlagged;
    app.selectedDeckIds = null;
    await showHome();
  };
  $("#btn-resume").onclick = resumeSession;
  $("#suspended-list").onclick = (e) => {
    const b = e.target.closest("[data-unsuspend]");
    if (!b) return;
    const c = app.cards.find((x) => x.id === Number(b.dataset.unsuspend));
    if (c) unsuspend([c]);
  };
  $("#btn-unsuspend-all").onclick = () => {
    const list = app.cards.filter((x) => x.suspended);
    if (list.length && confirm(`保留中の ${list.length} 枚をすべて解除します。よろしいですか？`)) unsuspend(list);
  };
  $("#deck-delete-list").onclick = (e) => {
    const b = e.target.closest("[data-del]");
    if (b) deleteDeck(b.dataset.del);
  };
  $("#set-backup-days").onchange = async (e) => {
    localStorage.setItem("backup.days", e.target.value);
    await refreshBackupBanner();
  };

  $("#deck-list").onclick = (e) => {
    // 三角は「たたむ/ひらく」専用。デッキの選択とは別扱いにする
    const tw = e.target.closest(".twist[data-twist]");
    if (tw) {
      const deck = app.decks.find((d) => d.id === Number(tw.dataset.twist));
      if (deck) toggleCollapse(deck.name);
      return;
    }
    const el = e.target.closest(".deck");
    if (!el) return;
    const id = Number(el.dataset.id);
    const deck = app.decks.find((d) => d.id === id);
    // 親を選んだら配下も対象にする
    const ids = app.decks.filter((d) => d.name === deck.name || d.name.startsWith(deck.name + "::")).map((d) => d.id);
    const same = app.selectedDeckIds && app.selectedDeckIds.length === ids.length && app.selectedDeckIds[0] === ids[0];
    app.selectedDeckIds = same ? null : ids;
    showHome();
  };

  $("#mode-strip").onclick = async (e) => {
    const b = e.target.closest(".mode-chip");
    if (!b) return;
    app.modeId = b.dataset.id;
    app.settings.modeId = app.modeId;
    await store.setMeta("settings", app.settings);
    renderModeStrip();
    if (!$("#view-study").classList.contains("hidden")) startStudy();
    else showHome();
  };

  $("#set-dr").oninput = (e) => ($("#set-dr-out").textContent = `${(e.target.value * 100).toFixed(0)}%`);
  $("#set-fontsize").oninput = (e) => ($("#set-fontsize-out").textContent = `${e.target.value}px`);
  $("#view-settings").addEventListener("change", async (e) => {
    if (e.target.id.startsWith("set-ai-")) {
      const key = e.target.id.replace("set-ai-", "");
      localStorage.setItem("ai." + key, e.target.value);
      toast("AI設定を保存しました");
      return;
    }
    await saveSettings();
    toast("保存しました");
  });
  $("#btn-wipe").onclick = async () => {
    if (!confirm("読み込んだデッキと学習履歴をすべて削除します。よろしいですか？")) return;
    await store.clearAll();
    await loadCollection();
    await showHome();
    toast("削除しました");
  };

  // キーボード（PCで使うとき）
  document.addEventListener("keydown", (e) => {
    if ($("#view-study").classList.contains("hidden")) return;
    if (e.target.matches("input,textarea")) return;
    if (e.code === "Space" || e.code === "Enter") {
      e.preventDefault();
      if (!app.revealed) $("#btn-show").click();
      else grade(Rating.Good);
    } else if (["1", "2", "3", "4"].includes(e.key) && app.revealed) {
      grade(Number(e.key));
    } else if (e.key === "u") undo();
  });
}

// ---------------------------------------------------------------- 小物

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function busy(text) {
  $("#busy-text").textContent = text;
  $("#busy").classList.remove("hidden");
}
const unbusy = () => $("#busy").classList.add("hidden");

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function registerSW() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  navigator.serviceWorker
    .register("sw.js")
    .then((reg) => {
      // 新しい版が入ったら知らせる。controller が居る＝2回目以降の起動なので、
      // 「初回インストール」と「本当の更新」を取り違えない。
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            if ($("#update-banner").dataset.dismissed !== "1") {
              $("#update-banner").classList.remove("hidden");
            }
          }
        });
      });
      // 画面に戻ってきたときに更新を確認する（開きっぱなしでも古いままにしない）
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    })
    .catch(() => {});
}

// デバッグ用（ブラウザのコンソールから状態を見る）
window.__app = app;
