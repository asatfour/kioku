/**
 * アプリ本体。画面の組み立てと操作の受け付け。
 */
import * as store from "./store.js";
import { readApkg, writeApkg, toStudyCard } from "./apkg.js";
import { Fsrs, State, Rating, humanInterval, DEFAULT_PARAMETERS } from "./fsrs.js";
import { renderCard, resolveMedia } from "./render.js";
import { buildQueue, DEFAULT_MODES, todayStats, forecast, dayStart } from "./queue.js";
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
};

// ---------------------------------------------------------------- 起動

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
  window.scrollTo(0, 0);
}

async function showHome() {
  show("view-home");
  const has = app.cards.length > 0;
  $("#empty-state").classList.toggle("hidden", has);
  $("#home-body").classList.toggle("hidden", !has);
  await refreshBackupBanner();
  if (!has) return;

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
  $("#btn-study-all").textContent = q.counts.total
    ? `学習をはじめる（${q.counts.total}枚）`
    : "今日のぶんは終わりました";
  $("#btn-study-all").disabled = q.counts.total === 0;
}

function currentQueue() {
  const mode = app.modes.find((m) => m.id === app.modeId) || app.modes[1];
  return buildQueue({
    cards: app.cards,
    noteById: app.notes,
    notetypeById: app.notetypes,
    deckIds: app.selectedDeckIds,
    mode,
    now: Date.now(),
    rolloverHour: app.settings.rolloverHour,
  });
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
  $("#deck-list").innerHTML = sorted
    .map((d) => {
      const p = per.get(d.id) || { new: 0, learn: 0, rev: 0 };
      const depth = Math.min(3, d.name.split("::").length - 1);
      const leaf = d.name.split("::").pop();
      const num = (v, k) => `<span class="${v ? "n" + k : "zero"}">${v}</span>`;
      return `<div class="deck ${sel?.has(d.id) ? "selected" : ""}" data-id="${d.id}" data-depth="${depth}">
        <span class="name">${escapeHtml(leaf)}</span>
        <span class="nums">${num(p.new, 0)}${num(p.learn, 1)}${num(p.rev, 2)}</span>
      </div>`;
    })
    .join("");
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
  show("view-study");
  $("#finished").classList.add("hidden");
  $("#card-area").classList.remove("hidden");
  $("#answer-bar").classList.remove("hidden");
  $("#study-tools").classList.remove("hidden");
  nextCard();
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
      await showHome();
      finishScreen(q);
      show("view-study");
      return;
    }
  }
  app.current = app.queue[app.qIndex];
  app.revealed = false;
  app.shownAt = Date.now();
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
  area.innerHTML = `<style>${nt.css || ""}</style><div class="card">${html}</div>`;
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

  app.lastAnswer = { before: { ...c }, after: next, index: app.qIndex };
  showUndoStrip(rating);

  // 保存
  const idx = app.cards.findIndex((x) => x.id === c.id);
  if (idx >= 0) app.cards[idx] = next;
  await store.put("cards", next);
  await store.addRevlog({ ...log, cardId: c.id });

  // 学習中カードは同じセッションでもう一度出す
  app.qIndex++;
  if ((next.state === State.Learning || next.state === State.Relearning) && next.due <= now + 20 * 60000) {
    app.queue.splice(Math.min(app.qIndex + 2, app.queue.length), 0, next);
  }
  await nextCard();
}

async function undo() {
  if (!app.lastAnswer) return toast("取り消せる操作がありません");
  const { before, index } = app.lastAnswer;
  const idx = app.cards.findIndex((x) => x.id === before.id);
  if (idx >= 0) app.cards[idx] = before;
  await store.put("cards", before);
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
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `記憶_${new Date().toISOString().slice(0, 10)}.apkg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
    if (note) {
      note.textContent = persisted
        ? "保存領域は保護されています（容量不足でも自動削除されません）。" + usage
        : "保存領域は保護されていません。容量不足のとき自動削除される場合があります。" + usage;
    }
  } catch {
    /* 対応していない端末では何もしない */
  }
}

// ------------------------------------------------ インストールと更新

let deferredInstall = null;

function setupInstall() {
  const note = $("#install-note");
  const btn2 = $("#btn-install-2");
  const standalone = matchMedia("(display-mode: standalone)").matches;

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

async function openAI() {
  if (!app.current) return;
  const panel = $("#ai-panel");
  panel.classList.remove("hidden");
  $("#ai-log").innerHTML = "";
  const ctx = buildContext(app.current, app.notes, app.notetypes, app.decks);
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

async function sendAI(prompt, ctx) {
  const log = $("#ai-log");
  log.insertAdjacentHTML("beforeend", `<div class="ai-msg me">${escapeHtml(prompt)}</div>`);
  const holder = document.createElement("div");
  holder.className = "ai-msg ai";
  holder.textContent = "…";
  log.appendChild(holder);
  log.scrollTop = log.scrollHeight;
  $("#ai-status").textContent = "考えています…";
  try {
    const answer = await askAI({ prompt, context: ctx, settings: aiSettings() });
    holder.textContent = answer;
    typeset(holder);
  } catch (e) {
    holder.textContent = "失敗しました: " + e.message;
  } finally {
    $("#ai-status").textContent = "";
    log.scrollTop = log.scrollHeight;
  }
}

const aiSettings = () => ({
  provider: localStorage.getItem("ai.provider") || "gemini",
  key: localStorage.getItem("ai.key") || "",
  model: localStorage.getItem("ai.model") || "",
  base: localStorage.getItem("ai.base") || "",
});

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

  $("#stats-body").innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="v">${st.reviews}</div><div class="k">今日の枚数</div></div>
      <div class="stat"><div class="v">${st.retention == null ? "—" : (st.retention * 100).toFixed(0) + "%"}</div><div class="k">今日の正答率</div></div>
      <div class="stat"><div class="v">${Math.round(st.timeMs / 60000)}分</div><div class="k">今日の時間</div></div>
      <div class="stat"><div class="v">${rev.length}</div><div class="k">のべ復習回数</div></div>
    </div>
    <div class="card-panel" style="margin-top:1rem">
      <h2>これから7日の予定</h2>
      <div class="bars">${fc.map((v) => `<div class="b" style="height:${(v / max) * 100}%"><span>${v || ""}</span></div>`).join("")}</div>
      <div class="bar-labels">${["今日", "明日", "3日", "4日", "5日", "6日", "7日"].map((l) => `<div>${l}</div>`).join("")}</div>
    </div>
    <div class="card-panel">
      <h2>カードの育ち具合</h2>
      <div class="stat-grid">
        <div class="stat"><div class="v" style="color:var(--good)">${mature}</div><div class="k">定着（21日以上）</div></div>
        <div class="stat"><div class="v" style="color:var(--warn)">${young}</div><div class="k">育成中</div></div>
        <div class="stat"><div class="v" style="color:var(--accent)">${fresh}</div><div class="k">未学習</div></div>
      </div>
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
  $("#btn-study-all").onclick = startStudy;
  $("#btn-back-home").onclick = showHome;
  $("#btn-more").onclick = () => {
    const m = app.modes.find((x) => x.id === app.modeId);
    m.limits = { new: m.limits.new + 20, review: m.limits.review + 50 };
    startStudy();
  };
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
    $("#img-viewer img").src = img.src;
    $("#img-viewer").classList.remove("hidden");
  });
  const closeViewer = () => $("#img-viewer").classList.add("hidden");
  $("#img-viewer").onclick = closeViewer;
  $("#img-close").onclick = closeViewer;
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

  const askUrl = () =>
    importFromUrl(prompt("デッキ（.apkg）の直リンクURLを貼り付けてください", "https://"));
  $("#btn-import-url").onclick = askUrl;
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
  $("#set-backup-days").onchange = async (e) => {
    localStorage.setItem("backup.days", e.target.value);
    await refreshBackupBanner();
  };

  $("#deck-list").onclick = (e) => {
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
