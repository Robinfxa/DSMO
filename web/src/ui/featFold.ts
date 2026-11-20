// The sidebar's feature entries (本机, 插件, 技能, DS Bot, plugins' own entries…) sit behind one plain
// 「功能」 row, so the sidebar opens looking like DeepSeek's own: search, the conversations, you.
// Tapping it unfolds the rows; every launch starts folded again (kept in memory only).

import { signal } from '@preact/signals';

export const featOpen = signal(false);
