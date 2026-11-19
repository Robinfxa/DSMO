// Official plugins, bundled with the app from market/index.json (v1 market =
// official only). The frontend halves live on the device; nothing is fetched.
import index from '../../../market/index.json';
import type { ApiDemoManifest } from './frontend';

export const OFFICIAL: ApiDemoManifest[] = (index.plugins as { manifest: unknown }[]).map((p) => p.manifest as ApiDemoManifest);
export const MARKET_TIER: Record<string, number> = Object.fromEntries((index.plugins as { tier: number; manifest: { id: string } }[]).map((p) => [p.manifest.id, p.tier]));
