// 读模型给的 JSON：容忍外面包了 ```json、前后有字，以及输出到一半被截断（max-tokens）。
// 截断时保留已经写完整的部分：在最后一个完整的元素之后截断，补上没闭合的括号。
// 打包时复制进每个包，源文件只有这一份。

/** 尝试把一段（可能被截断的）JSON 读成对象；读不出返回 null。 */
export function parseLenient(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const body = raw.slice(start);
  try {
    const v = JSON.parse(body);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    /* 下面按截断处理 */
  }
  // 一遍扫描：记下每个「可以在这里截断」的位置（一个完整元素之后）和那时还没闭合的括号
  const stack = [];
  let inString = false;
  let escape = false;
  let cut = null; // { at, closers }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (!stack.length) {
        // 第一个完整的顶层对象就到这里；后面的字不要
        try {
          return JSON.parse(body.slice(0, i + 1));
        } catch {
          return null;
        }
      }
      cut = { at: i + 1, closers: [...stack].reverse().join('') };
    } else if (ch === ',') cut = { at: i, closers: [...stack].reverse().join('') };
  }
  if (!cut) return null;
  try {
    const v = JSON.parse(body.slice(0, cut.at) + cut.closers);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
