/**
 * FSRS-6 スケジューラ（自前実装）
 *
 * 出典: 公開されているFSRS-6の数式仕様（fsrs-rs / py-fsrs 6.3.1 の挙動を基準として検証）。
 * 本家Anki(AGPL)/AnkiDroid(GPL)のコードは一切流用していない。
 * 検証: test/fsrs.test.mjs が py-fsrs 6.3.1 から採取した基準ベクタと突き合わせる。
 *
 * 時刻はすべて「エポックミリ秒」で扱う。学習ステップは「秒」で持つ。
 */

export const FSRS_DEFAULT_DECAY = 0.1542;

/** FSRS-6 既定パラメータ（w0..w20 の21個） */
export const DEFAULT_PARAMETERS = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  FSRS_DEFAULT_DECAY,
]);

export const State = Object.freeze({
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3,
});

export const Rating = Object.freeze({ Again: 1, Hard: 2, Good: 3, Easy: 4 });

const STABILITY_MIN = 0.001;
const DIFFICULTY_MIN = 1.0;
const DIFFICULTY_MAX = 10.0;
const DAY_MS = 86400000;

/** 間隔のばらつき（同じ日に大量のカードが集中するのを防ぐ） */
const FUZZ_RANGES = [
  { start: 2.5, end: 7.0, factor: 0.15 },
  { start: 7.0, end: 20.0, factor: 0.1 },
  { start: 20.0, end: Infinity, factor: 0.05 },
];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** 新規カードの初期状態 */
export function newCard(id = null) {
  return {
    id,
    state: State.Learning, // FSRSでは「未学習」も Learning(step=0) から始まる
    step: 0,
    stability: null,
    difficulty: null,
    due: Date.now(),
    lastReview: null,
  };
}

export class Fsrs {
  /**
   * @param {object} opts
   * @param {number[]} [opts.parameters]        w0..w20
   * @param {number}   [opts.desiredRetention]  目標保持率（既定0.9）
   * @param {number[]} [opts.learningSteps]     学習ステップ（秒）既定 [60, 600]
   * @param {number[]} [opts.relearningSteps]   再学習ステップ（秒）既定 [600]
   * @param {number}   [opts.maximumInterval]   最大間隔（日）
   * @param {boolean}  [opts.enableFuzz]        間隔のばらつきを入れるか
   * @param {()=>number} [opts.random]          乱数源（テスト用に差し替え可）
   */
  constructor(opts = {}) {
    this.parameters = [...(opts.parameters ?? DEFAULT_PARAMETERS)];
    if (this.parameters.length !== 21) {
      throw new Error(`FSRS-6 は21個のパラメータが必要です（受領: ${this.parameters.length}）`);
    }
    this.desiredRetention = opts.desiredRetention ?? 0.9;
    this.learningSteps = opts.learningSteps ?? [60, 600];
    this.relearningSteps = opts.relearningSteps ?? [600];
    this.maximumInterval = opts.maximumInterval ?? 36500;
    this.enableFuzz = opts.enableFuzz ?? true;
    this.random = opts.random ?? Math.random;

    this.DECAY = -this.parameters[20];
    this.FACTOR = Math.pow(0.9, 1 / this.DECAY) - 1;
  }

  // ---------- 記憶モデル ----------

  /** 想起率 R: いま思い出せる確率 */
  retrievability(card, nowMs = Date.now()) {
    if (card.lastReview == null || card.stability == null) return 0;
    const elapsedDays = Math.max(0, Math.floor((nowMs - card.lastReview) / DAY_MS));
    return Math.pow(1 + (this.FACTOR * elapsedDays) / card.stability, this.DECAY);
  }

  _initialStability(rating) {
    return Math.max(this.parameters[rating - 1], STABILITY_MIN);
  }

  _initialDifficulty(rating, doClamp = true) {
    const d = this.parameters[4] - Math.exp(this.parameters[5] * (rating - 1)) + 1;
    return doClamp ? clamp(d, DIFFICULTY_MIN, DIFFICULTY_MAX) : d;
  }

  /** 難易度の更新: 評価による増減 → 線形減衰 → 平均回帰 */
  _nextDifficulty(difficulty, rating) {
    const deltaD = -(this.parameters[6] * (rating - 3));
    const damped = difficulty + ((10.0 - difficulty) * deltaD) / 9.0;
    const target = this._initialDifficulty(Rating.Easy, false);
    const reverted = this.parameters[7] * target + (1 - this.parameters[7]) * damped;
    return clamp(reverted, DIFFICULTY_MIN, DIFFICULTY_MAX);
  }

  /** 正答時の安定度 */
  _recallStability(difficulty, stability, r, rating) {
    const hard = rating === Rating.Hard ? this.parameters[15] : 1;
    const easy = rating === Rating.Easy ? this.parameters[16] : 1;
    return (
      stability *
      (1 +
        Math.exp(this.parameters[8]) *
          (11 - difficulty) *
          Math.pow(stability, -this.parameters[9]) *
          (Math.exp((1 - r) * this.parameters[10]) - 1) *
          hard *
          easy)
    );
  }

  /** 失敗（Again）時の安定度 */
  _forgetStability(difficulty, stability, r) {
    const longTerm =
      this.parameters[11] *
      Math.pow(difficulty, -this.parameters[12]) *
      (Math.pow(stability + 1, this.parameters[13]) - 1) *
      Math.exp((1 - r) * this.parameters[14]);
    const shortTerm = stability / Math.exp(this.parameters[17] * this.parameters[18]);
    return Math.min(longTerm, shortTerm);
  }

  /** 同日中の再学習（1日未満で再度出したとき） */
  _shortTermStability(stability, rating) {
    let inc =
      Math.exp(this.parameters[17] * (rating - 3 + this.parameters[18])) *
      Math.pow(stability, -this.parameters[19]);
    if (rating === Rating.Good || rating === Rating.Easy) inc = Math.max(inc, 1.0);
    return Math.max(stability * inc, STABILITY_MIN);
  }

  _nextStability(difficulty, stability, r, rating) {
    const s =
      rating === Rating.Again
        ? this._forgetStability(difficulty, stability, r)
        : this._recallStability(difficulty, stability, r, rating);
    return Math.max(s, STABILITY_MIN);
  }

  /** 安定度から次回間隔（日）を出す */
  nextIntervalDays(stability) {
    const raw =
      (stability / this.FACTOR) * (Math.pow(this.desiredRetention, 1 / this.DECAY) - 1);
    return clamp(Math.round(raw), 1, this.maximumInterval);
  }

  _fuzzDays(intervalDays) {
    if (!this.enableFuzz || intervalDays < 2.5) return intervalDays;
    let delta = 1.0;
    for (const fr of FUZZ_RANGES) {
      delta += fr.factor * Math.max(Math.min(intervalDays, fr.end) - fr.start, 0.0);
    }
    let minIvl = Math.round(intervalDays - delta);
    let maxIvl = Math.round(intervalDays + delta);
    minIvl = Math.max(2, minIvl);
    maxIvl = Math.min(maxIvl, this.maximumInterval);
    minIvl = Math.min(minIvl, maxIvl);
    const fuzzed = this.random() * (maxIvl - minIvl + 1) + minIvl;
    return Math.min(Math.round(fuzzed), this.maximumInterval);
  }

  // ---------- 状態遷移 ----------

  /**
   * カードを1回復習する。
   * @returns {{card: object, log: object}} 新しいカードと復習ログ
   */
  review(card, rating, nowMs = Date.now(), reviewDurationMs = null) {
    const c = { ...card };
    const daysSince =
      c.lastReview != null ? Math.floor((nowMs - c.lastReview) / DAY_MS) : null;
    const sameDay = daysSince != null && daysSince < 1;

    const log = {
      cardId: c.id,
      rating,
      reviewedAt: nowMs,
      state: c.state,
      step: c.step,
      prevStability: c.stability,
      prevDifficulty: c.difficulty,
      elapsedDays: daysSince,
      durationMs: reviewDurationMs,
    };

    let intervalSec = null; // 秒単位の次回間隔（学習ステップ用）
    let intervalDays = null; // 日単位（復習用）

    const graduate = () => {
      c.state = State.Review;
      c.step = null;
      intervalDays = this.nextIntervalDays(c.stability);
    };

    if (c.state === State.Learning || c.state === State.New) {
      if (c.state === State.New) {
        c.state = State.Learning;
        c.step = 0;
      }
      // 記憶状態の更新
      if (c.stability == null || c.difficulty == null) {
        c.stability = this._initialStability(rating);
        c.difficulty = this._initialDifficulty(rating);
      } else if (sameDay) {
        c.stability = this._shortTermStability(c.stability, rating);
        c.difficulty = this._nextDifficulty(c.difficulty, rating);
      } else {
        const r = this.retrievability(c, nowMs);
        c.stability = this._nextStability(c.difficulty, c.stability, r, rating);
        c.difficulty = this._nextDifficulty(c.difficulty, rating);
      }

      // 次回の予定
      if (
        this.learningSteps.length === 0 ||
        (c.step >= this.learningSteps.length && rating !== Rating.Again)
      ) {
        graduate();
      } else if (rating === Rating.Again) {
        c.step = 0;
        intervalSec = this.learningSteps[0];
      } else if (rating === Rating.Hard) {
        if (c.step === 0 && this.learningSteps.length === 1) {
          intervalSec = this.learningSteps[0] * 1.5;
        } else if (c.step === 0 && this.learningSteps.length >= 2) {
          intervalSec = (this.learningSteps[0] + this.learningSteps[1]) / 2.0;
        } else {
          intervalSec = this.learningSteps[c.step];
        }
      } else if (rating === Rating.Good) {
        if (c.step + 1 === this.learningSteps.length) {
          graduate();
        } else {
          c.step += 1;
          intervalSec = this.learningSteps[c.step];
        }
      } else {
        graduate(); // Easy
      }
    } else if (c.state === State.Review) {
      if (sameDay) {
        c.stability = this._shortTermStability(c.stability, rating);
      } else {
        const r = this.retrievability(c, nowMs);
        c.stability = this._nextStability(c.difficulty, c.stability, r, rating);
      }
      c.difficulty = this._nextDifficulty(c.difficulty, rating);

      if (rating === Rating.Again) {
        if (this.relearningSteps.length === 0) {
          intervalDays = this.nextIntervalDays(c.stability);
        } else {
          c.state = State.Relearning;
          c.step = 0;
          intervalSec = this.relearningSteps[0];
        }
      } else {
        intervalDays = this.nextIntervalDays(c.stability);
      }
    } else {
      // Relearning
      if (sameDay) {
        c.stability = this._shortTermStability(c.stability, rating);
      } else {
        const r = this.retrievability(c, nowMs);
        c.stability = this._nextStability(c.difficulty, c.stability, r, rating);
      }
      c.difficulty = this._nextDifficulty(c.difficulty, rating);

      if (
        this.relearningSteps.length === 0 ||
        (c.step >= this.relearningSteps.length && rating !== Rating.Again)
      ) {
        graduate();
      } else if (rating === Rating.Again) {
        c.step = 0;
        intervalSec = this.relearningSteps[0];
      } else if (rating === Rating.Hard) {
        if (c.step === 0 && this.relearningSteps.length === 1) {
          intervalSec = this.relearningSteps[0] * 1.5;
        } else if (c.step === 0 && this.relearningSteps.length >= 2) {
          intervalSec = (this.relearningSteps[0] + this.relearningSteps[1]) / 2.0;
        } else {
          intervalSec = this.relearningSteps[c.step];
        }
      } else if (rating === Rating.Good) {
        if (c.step + 1 === this.relearningSteps.length) {
          graduate();
        } else {
          c.step += 1;
          intervalSec = this.relearningSteps[c.step];
        }
      } else {
        graduate(); // Easy
      }
    }

    if (intervalDays != null) {
      const days = this._fuzzDays(intervalDays);
      c.due = nowMs + days * DAY_MS;
      log.scheduledDays = days;
    } else {
      c.due = nowMs + intervalSec * 1000;
      log.scheduledSeconds = intervalSec;
    }
    c.lastReview = nowMs;

    log.newState = c.state;
    log.newStability = c.stability;
    log.newDifficulty = c.difficulty;
    log.due = c.due;
    return { card: c, log };
  }

  /**
   * 4つの評価それぞれで次にいつ出るかを先読みする（ボタンに残り時間を出すため）。
   * fuzz は掛けない（表示がブレるため）。
   */
  preview(card, nowMs = Date.now()) {
    const saved = this.enableFuzz;
    this.enableFuzz = false;
    const out = {};
    for (const r of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
      const { card: next } = this.review(card, r, nowMs);
      out[r] = next.due - nowMs;
    }
    this.enableFuzz = saved;
    return out;
  }
}

/** 経過ミリ秒を「10分」「3日」のような日本語表記にする */
export function humanInterval(ms) {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}秒`;
  if (s < 3600) return `${Math.round(s / 60)}分`;
  if (s < 86400) return `${Math.round(s / 3600)}時間`;
  const d = s / 86400;
  if (d < 30) return `${Math.round(d)}日`;
  if (d < 365) return `${(d / 30.44).toFixed(1)}か月`;
  return `${(d / 365.25).toFixed(1)}年`;
}
