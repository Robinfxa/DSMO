// SKILL.md as the 技能 editor reads and writes it.
import { describe, expect, it } from 'vitest';
import { parseSkillMd, skillMd } from '../src/skills/skillFile';

describe('SKILL.md', () => {
  it('reads name, description and the instructions, keeping other front matter', () => {
    const d = parseSkillMd('---\nname: pdf\ndescription: 读 PDF\nallowed-tools: Read, Bash\n---\n\n# PDF\n\n步骤\n', 'pdf');
    expect(d).toEqual({ name: 'pdf', description: '读 PDF', body: '# PDF\n\n步骤\n', extra: ['allowed-tools: Read, Bash'] });
    expect(skillMd(d)).toBe('---\nname: pdf\ndescription: 读 PDF\nallowed-tools: Read, Bash\n---\n\n# PDF\n\n步骤\n');
  });

  it('reads quoted and folded descriptions', () => {
    expect(parseSkillMd('---\nname: a\ndescription: "整理: 三段式"\n---\nx', 'a').description).toBe('整理: 三段式');
    expect(parseSkillMd("---\nname: a\ndescription: 'it''s'\n---\nx", 'a').description).toBe("it's");
    expect(parseSkillMd('---\nname: a\ndescription: >\n  第一行\n  第二行\n---\nx', 'a').description).toBe('第一行 第二行');
  });

  it('quotes a description only when plain YAML would read it differently', () => {
    const md = (description: string) => skillMd({ name: 'a', description, body: 'x', extra: [] }).split('\n')[2];
    expect(md('把周报写好')).toBe('description: 把周报写好');
    expect(md('整理: 三段式')).toBe('description: "整理: 三段式"');
    expect(md('# 不是注释')).toBe('description: "# 不是注释"');
    expect(md('true')).toBe('description: "true"');
    expect(md('两行\n合成一行')).toBe('description: 两行 合成一行');
    for (const v of ['整理: 三段式', '# 不是注释', 'say "hi"', 'a\\b']) expect(parseSkillMd(skillMd({ name: 'a', description: v, body: 'x', extra: [] }), 'a').description).toBe(v);
  });

  it('takes a file without front matter as all instructions, named after its folder', () => {
    expect(parseSkillMd('# 只有正文\n', 'notes')).toEqual({ name: 'notes', description: '', body: '# 只有正文\n', extra: [] });
  });
});
