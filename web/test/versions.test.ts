import { describe, expect, it, beforeEach } from 'vitest';
import { activeVersion, addVersion, bumpedForkTitle, familyMembers, hiddenVersions, setActiveVersion, siblingsFor, versionEntries } from '../src/state/versions';

const exists = () => true;

describe('versions: edit / regenerate stay one conversation', () => {
  beforeEach(() => {
    versionEntries.value = {};
    activeVersion.value = {};
  });

  it('lists only the active version of a family', () => {
    addVersion('B', 'A', 10, 'edit');
    expect(familyMembers('B')).toEqual(['A', 'B']);
    expect([...hiddenVersions(exists)]).toEqual(['A']);
    setActiveVersion('A');
    expect([...hiddenVersions(exists)]).toEqual(['B']);
    // the shown version was deleted: the newest remaining one is listed
    expect([...hiddenVersions((id) => id !== 'A')]).toEqual([]);
  });

  it('editing the same message again makes siblings, not a chain', () => {
    addVersion('B', 'A', 10, 'edit');
    addVersion('C', 'B', 10, 'edit');
    expect(versionEntries.value.C.parent).toBe('A');
    const users = [3, 12, 30];
    const s = siblingsFor('C', users, exists).get(12)!;
    expect(s).toEqual({ ids: ['A', 'B', 'C'], index: 2, kind: 'edit' });
    expect(siblingsFor('A', users, exists).get(12)!.index).toBe(0);
  });

  it('a later edit in a version branches from that version', () => {
    addVersion('B', 'A', 10, 'edit');
    addVersion('D', 'B', 25, 'regen');
    const m = siblingsFor('B', [3, 12, 30], exists);
    expect(m.get(12)!.ids).toEqual(['A', 'B']);
    expect(m.get(30)).toEqual({ ids: ['B', 'D'], index: 0, kind: 'regen' });
    expect(familyMembers('D')).toEqual(['A', 'B', 'D']);
  });

  it('names explicit forks like dsh-Go', () => {
    expect(bumpedForkTitle('SSH 隧道')).toBe('SSH 隧道 (1)');
    expect(bumpedForkTitle('SSH 隧道 (1)')).toBe('SSH 隧道 (2)');
  });
});
