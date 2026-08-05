/**
 * 最小 protobuf リーダ。
 * Anki schema18 の BLOB 列（notetypes.config / templates.config / decks.kind / media）から
 * 必要なフィールドだけ取り出すために使う。スキーマ定義(.proto)は不要で、
 * ワイヤ形式（フィールド番号＋型）だけを頼りに読む。
 */

/**
 * @param {Uint8Array} buf
 * @returns {Object<number, Array<number|Uint8Array>>} フィールド番号 → 値の配列
 */
export function parse(buf) {
  const out = {};
  let i = 0;
  const varint = () => {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error("protobuf: 途中で終端");
      const b = buf[i++];
      v += (b & 0x7f) * Math.pow(2, shift); // 64bit対応のためビット演算を使わない
      if (!(b & 0x80)) return v;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    let val;
    if (wire === 0) val = varint();
    else if (wire === 2) {
      const len = varint();
      val = buf.subarray(i, i + len);
      i += len;
    } else if (wire === 5) {
      val = new DataView(buf.buffer, buf.byteOffset + i, 4).getFloat32(0, true);
      i += 4;
    } else if (wire === 1) {
      val = new DataView(buf.buffer, buf.byteOffset + i, 8).getFloat64(0, true);
      i += 8;
    } else {
      throw new Error(`protobuf: 未対応のワイヤ型 ${wire}`);
    }
    (out[field] ||= []).push(val);
  }
  return out;
}

const DEC = new TextDecoder();

/** フィールドを文字列として取り出す（無ければ既定値） */
export function str(msg, field, dflt = "") {
  const v = msg[field]?.[0];
  if (v == null) return dflt;
  return v instanceof Uint8Array ? DEC.decode(v) : String(v);
}

/** フィールドを数値として取り出す */
export function num(msg, field, dflt = 0) {
  const v = msg[field]?.[0];
  return typeof v === "number" ? v : dflt;
}

/** 入れ子メッセージとして取り出す */
export function sub(msg, field) {
  const v = msg[field]?.[0];
  return v instanceof Uint8Array ? parse(v) : null;
}

/** 繰り返し入れ子メッセージ */
export function subs(msg, field) {
  return (msg[field] || []).filter((v) => v instanceof Uint8Array).map(parse);
}
