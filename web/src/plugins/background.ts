// A chat background from a plugin (permission `background`). The panel never handles the picture
// itself: it asks the app to pick one (apiDemo.background.pick), the app shrinks it, keeps it in the
// plugin's own data on this device (so 「管理」 shows its size and clears it, and uninstalling removes
// it) and shows it behind the chat with a veil and an optional blur; the panel only gets a small
// thumbnail back and sets how strong the veil and blur are.
//
// Safe by construction: it's only an image painted behind the chat, under everything else — the
// protected areas stay above it — and a veil of at least 15 % keeps the text readable. Skins still
// can't use url(); this is the one way a picture gets in.

import { computed, signal } from '@preact/signals';
import { native } from '../bridge/native';
import { findPlugin, installed, pluginDataGet, pluginDataSet } from './frontend';

export interface BgStyle {
  /** The veil over the picture, 15–90 (%). */
  dim: number;
  /** Blur, 0–20 (px). */
  blur: number;
}
export const DEFAULT_STYLE: BgStyle = { dim: 45, blur: 0 };
const MAX_SIDE = 1600;
const MAX_CHARS = 900 * 1024;
const THUMB_SIDE = 240;
const K = { image: 'bg.image', thumb: 'bg.thumb', style: 'bg.style' } as const;

/** The enabled plugin that sets the background (the first one, if more are on). */
export const backgroundPlugin = computed(() => installed.value.find((x) => x.enabled && findPlugin(x.id)?.permissions.includes('background'))?.id ?? null);

/** What's painted: an object URL and the style; null when there's none. */
export const background = signal<{ url: string; style: BgStyle } | null>(null);

const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d);
export const styleOf = (raw: unknown): BgStyle => {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { dim: clamp(o.dim, 15, 90, DEFAULT_STYLE.dim), blur: clamp(o.blur, 0, 20, DEFAULT_STYLE.blur) };
};

let shown = '';
let shownSrc = '';
let loading = 0;
/** Reads the active plugin's picture and style and paints them (or clears). */
export async function refreshBackground() {
  const id = backgroundPlugin.value;
  const ticket = ++loading;
  const [image, style] = id ? await Promise.all([pluginDataGet(id, K.image), pluginDataGet(id, K.style)]) : [null, null];
  if (ticket !== loading) return;
  if (!image || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
    if (shown) URL.revokeObjectURL(shown);
    shown = shownSrc = '';
    background.value = null;
    return;
  }
  const s = styleOf(safeJson(style));
  // the same picture: just the style
  if (shown && shownSrc === image) return void (background.value = { url: shown, style: s });
  const blob = await (await fetch(image)).blob();
  if (ticket !== loading) return;
  if (shown) URL.revokeObjectURL(shown);
  shown = URL.createObjectURL(blob);
  shownSrc = image;
  background.value = { url: shown, style: s };
}
const safeJson = (s: string | null) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

/** Keeps the painted background in step with which plugin is on and its data. */
export function watchBackground() {
  let last: string | null | undefined;
  const off = backgroundPlugin.subscribe((id) => {
    if (id === last) return;
    last = id;
    void refreshBackground();
  });
  const onData = (e: Event) => (e as CustomEvent<string>).detail === backgroundPlugin.value && void refreshBackground();
  window.addEventListener('api-demo:plugin-data', onData);
  return () => (off(), window.removeEventListener('api-demo:plugin-data', onData));
}

// ---------------------------------------------------------------- pictures

async function scaled(blob: Blob, side: number, quality: number): Promise<string> {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', quality);
}

/** A picture made small enough to keep: JPEG, at most 1600 px on a side and ~900 KB as text. */
export async function shrink(blob: Blob): Promise<{ image: string; thumb: string }> {
  let side = MAX_SIDE;
  let q = 0.82;
  let image = await scaled(blob, side, q);
  while (image.length > MAX_CHARS && side > 600) {
    if (q > 0.6) q -= 0.1;
    else side = Math.round(side * 0.8);
    image = await scaled(blob, side, q);
  }
  return { image, thumb: await scaled(blob, THUMB_SIDE, 0.7) };
}

/** Lets the person pick a picture, keeps it for [id] and paints it. null: nothing picked. */
export async function pickBackground(id: string): Promise<{ thumb: string } | null> {
  const [f] = await native.pickDocuments(['image/*', '.jpg', '.jpeg', '.png', '.webp']);
  if (!f) return null;
  try {
    if (f.size > 30 * 1024 * 1024) throw new Error('图片太大了（上限 30 MB）');
    const r = new Response(f.stream());
    const blob = await r.blob();
    let out: { image: string; thumb: string };
    try {
      out = await shrink(blob);
    } catch {
      throw new Error('读不出这张图片，换一张 JPG 或 PNG 试试');
    }
    await pluginDataSet(id, K.image, out.image);
    await pluginDataSet(id, K.thumb, out.thumb);
    if (!(await pluginDataGet(id, K.style))) await pluginDataSet(id, K.style, JSON.stringify(DEFAULT_STYLE));
    return { thumb: out.thumb };
  } finally {
    f.release?.();
  }
}

export async function readBackground(id: string) {
  const thumb = await pluginDataGet(id, K.thumb);
  return { thumb: thumb || null, ...styleOf(safeJson(await pluginDataGet(id, K.style))) };
}
export const setBackgroundStyle = (id: string, s: unknown) => pluginDataSet(id, K.style, JSON.stringify(styleOf(s)));
export async function clearBackground(id: string) {
  await pluginDataSet(id, K.image, null);
  await pluginDataSet(id, K.thumb, null);
}
