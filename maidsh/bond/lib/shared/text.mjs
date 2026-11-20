// 记忆用的文本小工具：中文按二元组切、英文按词切；相似度；BM25。零依赖。

const CJK = /[㐀-鿿豈-﫿]/;

/** 切词：连续汉字切成二元组（单字成词时保留单字），字母数字按词，其余丢弃。 */
export function tokens(text) {
  const out = [];
  const s = String(text ?? '').toLowerCase();
  let run = '';
  let word = '';
  const flushRun = () => {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    run = '';
  };
  const flushWord = () => {
    if (word) out.push(word);
    word = '';
  };
  for (const ch of s) {
    if (CJK.test(ch)) {
      flushWord();
      run += ch;
    } else if (/[a-z0-9]/.test(ch)) {
      flushRun();
      word += ch;
    } else {
      flushRun();
      flushWord();
    }
  }
  flushRun();
  flushWord();
  return out;
}

/** 两段文字的二元组 Jaccard 相似度（0–1）。 */
export function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 是不是在说同一件事：二元组 Jaccard ≥ 0.7，或短的那句几乎整个包含在长的那句里（「养了一只猫」⊂「养了一只猫叫团子」）。 */
export function sameThing(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  if (inter / (A.size + B.size - inter) >= 0.7) return true;
  const small = Math.min(A.size, B.size);
  return small >= 4 && inter / small >= 0.9;
}

/** a 的二元组有多大比例出现在 b 里（0–1）：a 被 b「说到」了多少。 */
export function covered(a, b) {
  const A = new Set(tokens(a));
  if (!A.size) return 0;
  const B = new Set(tokens(b));
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / A.size;
}

/** 信息量：不同二元组的个数（去重时保留信息多的说法）。 */
export const information = (text) => new Set(tokens(text)).size;

/** 去掉空白和标点，用来判断原话是否真的出现在对方的话里。 */
export const squash = (s) => String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/**
 * 一个小 BM25 索引（k1 = 1.2，b = 0.75）。docs：[{ id, text }]。
 * score(query) → Map(id → 分数)。
 */
export function bm25(docs, { k1 = 1.2, b = 0.75 } = {}) {
  const tf = new Map();
  const df = new Map();
  let total = 0;
  for (const d of docs) {
    const counts = new Map();
    const ts = tokens(d.text);
    for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    tf.set(d.id, { counts, len: ts.length });
    total += ts.length;
  }
  const n = docs.length;
  const avg = n ? total / n : 0;
  return {
    size: n,
    score(query) {
      const q = [...new Set(tokens(query))];
      const out = new Map();
      if (!n || !q.length) return out;
      for (const [id, { counts, len }] of tf) {
        let s = 0;
        for (const t of q) {
          const f = counts.get(t);
          if (!f) continue;
          const d = df.get(t);
          const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
          s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / (avg || 1)));
        }
        if (s > 0) out.set(id, s);
      }
      return out;
    },
  };
}
