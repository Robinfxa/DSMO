// A skill's SKILL.md: YAML front matter (`name`, `description`, anything else
// kept as written) and the instructions below it. Written so that both DSH's
// YAML and dsh-Go's line reader (guest_fs.dart _frontMatter) read it back.

/** DSH's skill folder names (SharedSkill._name in dsh-Go). */
export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** One file's limit, as dsh-Go checks it (SharedSkill.maxFileChars). */
export const MAX_FILE_CHARS = 64 * 1024;

export interface SkillDoc {
  name: string;
  description: string;
  /** The instructions: everything after the front matter. */
  body: string;
  /** Other front-matter lines, kept as they were. */
  extra: string[];
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t[0] === '"' && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.length >= 2 && t[0] === "'" && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

export function parseSkillMd(text: string, folder: string): SkillDoc {
  const m = FENCE.exec(text);
  if (!m) return { name: folder, description: '', body: text.replace(/^\s*\n/, ''), extra: [] };
  const doc: SkillDoc = { name: folder, description: '', body: text.slice(m[0].length).replace(/^\s*\n/, ''), extra: [] };
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) {
      doc.extra.push(lines[i]);
      continue;
    }
    let value = kv[2];
    // a folded or literal block: `description: >` and indented lines
    if (/^[>|][+-]?\s*$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(kv[2].startsWith('>') ? ' ' : '\n');
    }
    if (kv[1] === 'name') doc.name = unquote(value) || folder;
    else doc.description = unquote(value);
  }
  return doc;
}

/** A YAML scalar on one line: plain when that reads back the same, else double-quoted. */
function scalar(v: string): string {
  const one = v.replace(/\s*\r?\n\s*/g, ' ').trim();
  const plain = one && !/^[-?:,[\]{}#&*!|>'"%@`\s]/.test(one) && !/:\s|\s#|:$/.test(one) && !/^(true|false|null|yes|no|~|[-+]?[\d.]+)$/i.test(one);
  return plain ? one : JSON.stringify(one);
}

export function skillMd(doc: SkillDoc): string {
  const head = [`name: ${scalar(doc.name)}`, `description: ${scalar(doc.description)}`, ...doc.extra.filter((l) => l.trim())];
  return `---\n${head.join('\n')}\n---\n\n${doc.body.replace(/^\s+/, '').replace(/\s*$/, '\n')}`;
}

export const SKILL_TEMPLATE = `# 什么时候用

（遇到什么样的请求时用这个技能）

# 怎么做

1.
2.
3.

# 注意

-
`;
