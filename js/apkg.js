/**
 * .apkg（Ankiパッケージ）の読み書き。
 *
 * 読み: v3（collection.anki21b = zstd + schema18 + protobuf）と
 *       レガシー（collection.anki2 = schema11 + JSON）の両対応。
 * 書き: レガシー schema11（本家26.8が問題なく読めることを実測済み）。
 *
 * 依存は呼び出し側から注入する（ブラウザ／Node で同じコードを使うため）。
 *   deps = { SQL: 初期化済みsql.js, JSZip, zstdDecompress: (Uint8Array)=>Uint8Array }
 */
import * as pb from "./pb.js";
import { State } from "./fsrs.js";

const FIELD_SEP = "\x1f";
const DAY_MS = 86400000;
const DEC = new TextDecoder();

/** schema18 は独自照合順序 unicase を使う索引を持ち、それを使うクエリが落ちる。
 *  読み取り専用なのでスキーマ文から剥がして開き直す。 */
function openCollection(SQL, bytes) {
  let db = new SQL.Database(bytes);
  const hits = db.exec("select count(*) from sqlite_master where sql like '%unicase%'")[0]
    .values[0][0];
  if (hits) {
    db.run("PRAGMA writable_schema=ON");
    db.run(
      "UPDATE sqlite_master SET sql=replace(replace(sql,' COLLATE unicase',''),' collate unicase','') WHERE sql LIKE '%unicase%'"
    );
    db.run("PRAGMA writable_schema=OFF");
    const b2 = db.export();
    db.close();
    db = new SQL.Database(b2);
  }
  return db;
}

function rows(db, sql) {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

/**
 * .apkg を読み込んで正規化した中身を返す。
 * @param {Uint8Array} bytes .apkg のバイト列
 * @param {object} deps
 * @returns {Promise<object>}
 */
export async function readApkg(bytes, deps) {
  const { SQL, JSZip, zstdDecompress } = deps;
  const zip = await JSZip.loadAsync(bytes);

  let pkgVersion = 1;
  if (zip.file("meta")) {
    const meta = pb.parse(await zip.file("meta").async("uint8array"));
    pkgVersion = pb.num(meta, 1, 1);
  }

  let colBytes;
  let zstdUsed = false;
  if (zip.file("collection.anki21b")) {
    colBytes = zstdDecompress(await zip.file("collection.anki21b").async("uint8array"));
    zstdUsed = true;
  } else if (zip.file("collection.anki21")) {
    colBytes = await zip.file("collection.anki21").async("uint8array");
  } else if (zip.file("collection.anki2")) {
    colBytes = await zip.file("collection.anki2").async("uint8array");
  } else {
    throw new Error("collection ファイルが見つかりません（.apkg ではない可能性）");
  }

  const db = openCollection(SQL, colBytes);
  try {
    const col = rows(db, "select id,crt,mod,scm,ver,conf,models,decks,dconf from col")[0];
    const ver = col.ver;
    const result = {
      packageVersion: pkgVersion,
      schemaVersion: ver,
      zstd: zstdUsed,
      crt: col.crt * 1000, // コレクション作成日（エポックms）
      notetypes: [],
      decks: [],
      notes: [],
      cards: [],
      revlog: [],
      media: new Map(),
    };

    if (ver <= 11) readLegacyStructure(db, col, result);
    else readModernStructure(db, result);
    ensureParentDecks(result.decks);

    // ---- ノート ----
    for (const r of rows(db, "select id,guid,mid,mod,tags,flds from notes")) {
      result.notes.push({
        id: r.id,
        guid: r.guid,
        mid: r.mid,
        mod: r.mod,
        tags: String(r.tags || "").trim().split(/\s+/).filter(Boolean),
        fields: String(r.flds).split(FIELD_SEP),
      });
    }

    // ---- カード ----
    for (const r of rows(
      db,
      "select id,nid,did,ord,mod,type,queue,due,ivl,factor,reps,lapses,left,odid,flags,data from cards"
    )) {
      result.cards.push({
        id: r.id,
        nid: r.nid,
        did: r.odid || r.did, // フィルタデッキ中なら元のデッキへ戻す
        ord: r.ord,
        mod: r.mod,
        ankiType: r.type,
        ankiQueue: r.queue,
        ankiDue: r.due,
        ivl: r.ivl,
        factor: r.factor,
        reps: r.reps,
        lapses: r.lapses,
        left: r.left,
        flags: r.flags,
        suspended: r.queue === -1,
        buried: r.queue === -2 || r.queue === -3,
        memory: parseCardData(r.data),
      });
    }

    // ---- 学習履歴 ----
    for (const r of rows(
      db,
      "select id,cid,ease,ivl,lastIvl,factor,time,type from revlog order by id"
    )) {
      result.revlog.push({
        id: r.id,
        reviewedAt: r.id, // revlog.id はエポックms
        cid: r.cid,
        rating: r.ease,
        ivl: r.ivl,
        lastIvl: r.lastIvl,
        factor: r.factor,
        durationMs: r.time,
        type: r.type,
      });
    }

    // ---- メディア ----
    await readMedia(zip, result, zstdDecompress);
    return result;
  } finally {
    db.close();
  }
}

/** cards.data の JSON から FSRS の記憶状態を取り出す */
function parseCardData(data) {
  if (!data) return null;
  try {
    const d = JSON.parse(data);
    if (d && typeof d.s === "number" && typeof d.d === "number") {
      return { stability: d.s, difficulty: d.d, desiredRetention: d.dr ?? null };
    }
  } catch {
    /* 旧版は空文字や非JSONのことがある */
  }
  return null;
}

/** schema11: ノートタイプ・デッキは col 行の JSON */
function readLegacyStructure(db, col, out) {
  const models = JSON.parse(col.models || "{}");
  for (const m of Object.values(models)) {
    out.notetypes.push({
      id: Number(m.id),
      name: m.name,
      css: m.css || "",
      isCloze: m.type === 1,
      latexPre: m.latexPre || "",
      latexPost: m.latexPost || "",
      fields: (m.flds || []).map((f) => ({ ord: f.ord, name: f.name })),
      templates: (m.tmpls || []).map((t) => ({
        ord: t.ord,
        name: t.name,
        qfmt: t.qfmt,
        afmt: t.afmt,
      })),
    });
  }
  const decks = JSON.parse(col.decks || "{}");
  for (const d of Object.values(decks)) {
    out.decks.push({
      id: Number(d.id),
      name: String(d.name).replace(/\x1f/g, "::"),
      path: String(d.name).split(/::|\x1f/),
      dyn: !!d.dyn,
    });
  }
}

/** schema18: 専用テーブル＋protobuf */
function readModernStructure(db, out) {
  const ntRows = rows(db, "select id,name,config from notetypes");
  const fieldRows = rows(db, "select ntid,ord,name from fields");
  const tmplRows = rows(db, "select ntid,ord,name,config from templates");

  for (const nt of ntRows) {
    const cfg = pb.parse(nt.config);
    const fields = fieldRows
      .filter((f) => f.ntid === nt.id)
      .sort((a, b) => a.ord - b.ord)
      .map((f) => ({ ord: f.ord, name: f.name }));
    const templates = tmplRows
      .filter((t) => t.ntid === nt.id)
      .sort((a, b) => a.ord - b.ord)
      .map((t) => {
        const tc = pb.parse(t.config);
        return { ord: t.ord, name: t.name, qfmt: pb.str(tc, 1), afmt: pb.str(tc, 2) };
      });
    out.notetypes.push({
      id: nt.id,
      name: nt.name,
      css: pb.str(cfg, 3),
      // 穴埋め(Cloze)は kind=1。protobuf 上は f1 に入る（既定0は省略される）
      isCloze: pb.num(cfg, 1, 0) === 1,
      latexPre: pb.str(cfg, 5),
      latexPost: pb.str(cfg, 6),
      fields,
      templates,
    });
  }

  for (const d of rows(db, "select id,name,kind from decks")) {
    const path = String(d.name).split("\x1f");
    out.decks.push({
      id: d.id,
      name: path.join("::"),
      path,
      dyn: !!pb.sub(pb.parse(d.kind), 2), // f1=通常 f2=フィルタ
    });
  }
}

/** zstd フレームの魔法数 28 b5 2f fd で始まるか */
function hasZstdMagic(b) {
  return b.length > 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;
}

/**
 * 「A::B::C」だけがあって A や A::B の行が無いパッケージがある
 * （genanki は葉デッキしか作らない）。本家も取り込み時に補うので、同じことをする。
 * これが無いと階層表示もデッキ単位の集計も崩れる。
 */
function ensureParentDecks(decks) {
  const byName = new Map(decks.map((d) => [d.name, d]));
  let seq = 0;
  const nextId = () => Date.now() + ++seq;
  for (const d of [...decks]) {
    const parts = d.name.split("::");
    for (let i = 1; i < parts.length; i++) {
      const name = parts.slice(0, i).join("::");
      if (byName.has(name)) continue;
      const parent = { id: nextId(), name, path: parts.slice(0, i), dyn: false, synthesized: true };
      byName.set(name, parent);
      decks.push(parent);
    }
  }
  decks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function readMedia(zip, out, zstdDecompress) {
  const mf = zip.file("media");
  if (!mf) return;
  const raw = await mf.async("uint8array");
  const isZstd = hasZstdMagic(raw);

  /** @type {Array<string>} 添字＝zip内の数字ファイル名 */
  let names = [];
  if (isZstd) {
    const entries = pb.parse(zstdDecompress(raw))[1] || [];
    names = entries.map((e) => pb.str(pb.parse(e), 1));
  } else {
    const map = JSON.parse(DEC.decode(raw)); // {"0":"a.png", "1":"b.png"}
    const maxIdx = Math.max(-1, ...Object.keys(map).map(Number));
    names = new Array(maxIdx + 1);
    for (const [k, v] of Object.entries(map)) names[Number(k)] = v;
  }

  for (let i = 0; i < names.length; i++) {
    const f = zip.file(String(i));
    if (!f || !names[i]) continue;
    let blob = await f.async("uint8array");
    // v3 では実体ファイルも1つずつ zstd 圧縮されている（実測で確認）
    if (hasZstdMagic(blob)) blob = zstdDecompress(blob);
    out.media.set(names[i], blob);
  }
}

// ---------------------------------------------------------------------------
// Anki のカード状態 → 自前の学習カードへの変換
// ---------------------------------------------------------------------------

/**
 * Anki のカード行を FSRS 用のカードへ変換する。
 * @param {object} c readApkg が返した cards の1件
 * @param {number} crtMs コレクション作成時刻(ms)
 * @param {number|null} lastReviewMs revlog から求めた最終復習時刻
 */
export function toStudyCard(c, crtMs, lastReviewMs = null) {
  const stateMap = {
    0: State.Learning, // 新規（未学習）は Learning step0 として扱う
    1: State.Learning,
    2: State.Review,
    3: State.Relearning,
  };
  const state = c.ankiType === 0 ? State.New : stateMap[c.ankiType] ?? State.Learning;

  let due;
  if (c.ankiType === 0) {
    due = crtMs; // 新規は順番待ち。実際の並びは ankiDue（位置）で決める
  } else if (c.ankiQueue === 1 || c.ankiQueue === 4) {
    due = c.ankiDue * 1000; // 学習中はエポック秒
  } else {
    due = crtMs + c.ankiDue * DAY_MS; // 復習は「コレクション作成日からの日数」
  }

  return {
    id: c.id,
    nid: c.nid,
    did: c.did,
    ord: c.ord,
    state,
    step: state === State.Review ? null : 0,
    stability: c.memory?.stability ?? null,
    difficulty: c.memory?.difficulty ?? null,
    due,
    lastReview: lastReviewMs,
    reps: c.reps,
    lapses: c.lapses,
    suspended: c.suspended,
    buried: c.buried,
    flags: c.flags,
    newPos: c.ankiType === 0 ? c.ankiDue : 0,
    // 旧SM-2の値。FSRSの記憶状態が無いカードの初期推定に使う
    legacyIvl: c.ivl,
    legacyFactor: c.factor,
  };
}

// ---------------------------------------------------------------------------
// 書き出し（レガシー schema11）
// ---------------------------------------------------------------------------

const SCHEMA11 = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null,
  scm integer not null, ver integer not null, dty integer not null, usn integer not null,
  ls integer not null, conf text not null, models text not null, decks text not null,
  dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null,
  mod integer not null, usn integer not null, tags text not null, flds text not null,
  sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null,
  ord integer not null, mod integer not null, usn integer not null, type integer not null,
  queue integer not null, due integer not null, ivl integer not null, factor integer not null,
  reps integer not null, lapses integer not null, left integer not null, odue integer not null,
  odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null,
  ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null,
  time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

/** Anki が notes.csum に入れる値: 先頭フィールドの SHA1 先頭8桁を数値化 */
async function fieldChecksum(text) {
  const stripped = text.replace(/<[^>]+>/g, "");
  const buf = new TextEncoder().encode(stripped);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return parseInt(hex.slice(0, 8), 16);
}

/**
 * 自前のデータを .apkg（schema11）として書き出す。
 * @returns {Promise<Uint8Array>} zip のバイト列
 */
export async function writeApkg(data, deps) {
  const { SQL, JSZip } = deps;
  const db = new SQL.Database();
  db.run(SCHEMA11);

  const crtSec = Math.floor((data.crt ?? Date.now()) / 1000);
  const nowSec = Math.floor(Date.now() / 1000);

  const models = {};
  for (const nt of data.notetypes) {
    models[String(nt.id)] = {
      id: nt.id,
      name: nt.name,
      type: nt.isCloze ? 1 : 0,
      mod: nowSec,
      usn: -1,
      sortf: 0,
      did: null,
      css: nt.css || "",
      latexPre: nt.latexPre || "",
      latexPost: nt.latexPost || "",
      latexsvg: false,
      req: nt.templates.map((t) => [t.ord, "any", [0]]),
      flds: nt.fields.map((f) => ({
        name: f.name,
        ord: f.ord,
        sticky: false,
        rtl: false,
        font: "Arial",
        size: 20,
        media: [],
      })),
      tmpls: nt.templates.map((t) => ({
        name: t.name,
        ord: t.ord,
        qfmt: t.qfmt,
        afmt: t.afmt,
        did: null,
        bqfmt: "",
        bafmt: "",
      })),
      tags: [],
      vers: [],
    };
  }

  const decks = {};
  for (const d of data.decks) {
    decks[String(d.id)] = {
      id: d.id,
      name: d.name.replace(/\x1f/g, "::"),
      mod: nowSec,
      usn: -1,
      collapsed: false,
      browserCollapsed: false,
      desc: "",
      dyn: 0,
      conf: 1,
      extendNew: 0,
      extendRev: 0,
      newToday: [0, 0],
      revToday: [0, 0],
      lrnToday: [0, 0],
      timeToday: [0, 0],
    };
  }

  const dconf = {
    1: {
      id: 1,
      name: "Default",
      mod: 0,
      usn: 0,
      maxTaken: 60,
      autoplay: true,
      timer: 0,
      replayq: true,
      new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
      rev: { bury: false, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 200 },
      lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 },
      dyn: false,
    },
  };

  const conf = {
    activeDecks: [1],
    addToCur: true,
    collapseTime: 1200,
    curDeck: 1,
    curModel: String(data.notetypes[0]?.id ?? 1),
    dueCounts: true,
    estTimes: true,
    newBury: true,
    newSpread: 0,
    nextPos: 1,
    sortBackwards: false,
    sortType: "noteFld",
    timeLim: 0,
    schedVer: 2,
  };

  db.run(
    `insert into col values (1,?,?,?,11,0,-1,0,?,?,?,?,'{}')`,
    [crtSec, nowSec * 1000, nowSec * 1000, JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf)]
  );

  const insNote = db.prepare(
    "insert into notes values (?,?,?,?,-1,?,?,?,?,0,'')"
  );
  for (const n of data.notes) {
    const flds = n.fields.join(FIELD_SEP);
    insNote.run([
      n.id,
      // 取り込んだノートには必ずあるが、アプリ内で作ったものには無いことがある。
      // ここが undefined だと書き出し全体が落ちるので、無ければその場で作る。
      n.guid ?? "k" + n.id.toString(36),
      n.mid,
      n.mod ?? nowSec,
      n.tags.length ? " " + n.tags.join(" ") + " " : "",
      flds,
      n.fields[0] ?? "",
      await fieldChecksum(n.fields[0] ?? ""),
    ]);
  }
  insNote.free();

  const insCard = db.prepare("insert into cards values (?,?,?,?,?,-1,?,?,?,?,?,?,?,?,0,0,?,?)");
  for (const c of data.cards) {
    insCard.run([
      c.id,
      c.nid,
      c.did,
      c.ord,
      nowSec,
      c.ankiType ?? 0,
      c.ankiQueue ?? 0,
      c.ankiDue ?? 0,
      c.ivl ?? 0,
      c.factor ?? 0,
      c.reps ?? 0,
      c.lapses ?? 0,
      c.left ?? 0,
      c.flags ?? 0,
      c.data ?? "",
    ]);
  }
  insCard.free();

  const insLog = db.prepare("insert into revlog values (?,?,-1,?,?,?,?,?,?)");
  for (const r of data.revlog || []) {
    insLog.run([r.id, r.cid, r.rating, r.ivl ?? 0, r.lastIvl ?? 0, r.factor ?? 0, r.durationMs ?? 0, r.type ?? 0]);
  }
  insLog.free();

  const bytes = db.export();
  db.close();

  const zip = new JSZip();
  zip.file("collection.anki2", bytes);
  const mediaMap = {};
  let i = 0;
  for (const [name, blob] of data.media || []) {
    mediaMap[String(i)] = name;
    zip.file(String(i), blob);
    i++;
  }
  zip.file("media", JSON.stringify(mediaMap));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
