// Official plugins, bundled with the app from market/index.json (v1 market =
// official only). The frontend halves live on the device; nothing is fetched.
import index from '../../../market/index.json';
// Developer examples (market/policy.json `examples`): the prototype lists them so its tests reach
// every manifest feature; a release build drops this import (__PROTOTYPE__ is false there).
import examples from '../../../market/examples.json';
import type { ApiDemoManifest } from './frontend';

type Listing = { tier: number; manifest: unknown };
const listed: Listing[] = [...(index.plugins as Listing[]), ...(__PROTOTYPE__ ? (examples.plugins as Listing[]) : [])];

export const OFFICIAL: ApiDemoManifest[] = listed.map((p) => p.manifest as ApiDemoManifest);
export const MARKET_TIER: Record<string, number> = Object.fromEntries(listed.map((p) => [(p.manifest as { id: string }).id, p.tier]));
/**
 * Taken off the market (they were demos): a phone that had one installed drops it and its data.
 * They only ever lived in the page (no engine half, no skills, no tasks), so that is all there is.
 */
export const RETIRED = new Set(['@api-demo/session-stats', '@api-demo/notes-panel', '@api-demo/skin-paper', '@api-demo/layout-focus']);
/** 发现 › 精选, chosen by the market (market/policy.json `featured`), in order. */
export const FEATURED: string[] = ((index as { featured?: unknown }).featured as string[] | undefined) ?? [];
