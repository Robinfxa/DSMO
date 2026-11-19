// DeepSeek account sign-in for the on-device engine (dsh-Go state/account_state.dart):
// the engine owns PKCE, the code exchange and the stored grant; the page starts
// an attempt (account/startSignIn with the engine's loopback origin as the
// callback), follows account/watch, opens the authorization page in the
// browser, and reads the display-safe profile and wallets.

import { signal } from '@preact/signals';
import { native } from '../bridge/native';
import { credential, getClient, showToast } from '../state/store';
import { engine, onLocalHost } from '../setup/state';

export type Phase = 'initializing' | 'waiting-browser' | 'exchanging' | 'committing' | 'succeeded' | 'cancelled' | 'expired' | 'failed';
export interface AccountView {
  signedIn: boolean;
  links?: { usageUrl: string; topUpUrl: string };
  attempt?: { id: string; phase: Phase; authorizeUrl?: string; errorCode?: string };
}
export interface Profile {
  name?: string;
  contact?: string;
  avatarUrl?: string;
}
export interface Wallet {
  currency: string;
  balance: string;
}

/**
 * 先隐藏: no way to start a DeepSeek account sign-in (first run, 账号管理, the
 * login panel). A phone already signed in still sees the account and can sign out.
 */
export const ACCOUNT_SIGN_IN = false;

export const accountView = signal<AccountView | null>(null);
export const profile = signal<Profile | null>(null);
export const balance = signal<{ recharge: Wallet[]; bonus: Wallet[] } | 'failed' | null>(null);

const o = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
function readView(v: unknown): AccountView {
  const m = o(v);
  const a = o(m.attempt);
  const l = o(m.links);
  return {
    signedIn: m.status === 'credential-stored',
    links: s(l.usageUrl) && s(l.topUpUrl) ? { usageUrl: s(l.usageUrl)!, topUpUrl: s(l.topUpUrl)! } : undefined,
    attempt: s(a.id) && s(a.phase) ? { id: s(a.id)!, phase: s(a.phase) as Phase, authorizeUrl: s(a.authorizeUrl), errorCode: s(a.errorCode) } : undefined,
  };
}

/** Sign-in works with this phone's own engine only: the browser must reach its /oauth/callback. */
export const canSignIn = () => onLocalHost.value && !!engine.value?.loopback;
export const isActive = (p?: Phase) => p === 'initializing' || p === 'waiting-browser' || p === 'exchanging' || p === 'committing';

let stopWatch: (() => void) | null = null;
let opened = new Set<string>();
let wasSignedIn = false;

function onView(v: AccountView) {
  accountView.value = v;
  const a = v.attempt;
  if (a?.phase === 'waiting-browser' && a.authorizeUrl && !opened.has(a.id)) {
    opened.add(a.id);
    void openBrowser(a.authorizeUrl);
  }
  if (v.signedIn && !wasSignedIn) {
    wasSignedIn = true;
    void refreshAccountDetails();
    // Signing in makes the account model route usable: the default model follows when no key is set.
    if (!credential.value?.configured) void getClient().initializeDefaultModel().catch(() => {});
  }
  if (!v.signedIn) {
    wasSignedIn = false;
    profile.value = null;
    balance.value = null;
  }
}

async function openBrowser(url: string) {
  if (__PROTOTYPE__) return showToast('（原型）登录页会在浏览器里打开');
  try {
    await native.openExternal(url);
  } catch {
    await navigator.clipboard?.writeText(url).catch(() => {});
    showToast('没能打开浏览器，网址已复制');
  }
}

/** Follows the account while the page is up (the on-device engine only). */
export function watchAccount() {
  stopWatch?.();
  stopWatch = null;
  if (!onLocalHost.value) return;
  stopWatch = getClient().watchAccount((v) => onView(readView(v)));
}

export async function refreshAccountDetails() {
  try {
    const p = await getClient().accountProfile();
    profile.value = p ? { name: s(o(p.value).name), contact: s(o(p.value).contact), avatarUrl: s(o(p.value).avatarUrl) } : null;
  } catch {
    /* kept */
  }
  try {
    const b = await getClient().accountBalance();
    if (!b) balance.value = null;
    else if (b.status !== 'ready') balance.value = 'failed';
    else {
      const w = (x: unknown) => (Array.isArray(x) ? x : []).map(o).filter((y) => s(y.currency) && typeof y.balance === 'string').map((y) => ({ currency: String(y.currency), balance: String(y.balance) }));
      balance.value = { recharge: w(b.value), bonus: w(b.bonusWallets) };
    }
  } catch {
    balance.value = 'failed';
  }
}

export async function signIn() {
  const origin = engine.value?.loopback;
  if (!origin) throw new Error('本机引擎还没有运行');
  opened = new Set();
  if (!stopWatch) watchAccount();
  onView(readView(await getClient().startSignIn(new URL(origin).origin)));
}
export async function cancelSignIn() {
  const id = accountView.value?.attempt?.id;
  if (id) onView(readView(await getClient().cancelSignIn(id)));
}
export function reopenBrowser() {
  const a = accountView.value?.attempt;
  if (a?.authorizeUrl) void openBrowser(a.authorizeUrl);
}
export async function signOut() {
  onView(readView(await getClient().signOut()));
}

/** 「5.0000000000000000」 → 「5.00」, 「0E-16」 → 「0.00」. */
export function money(b: string) {
  const n = Number(b);
  return Number.isFinite(n) ? n.toFixed(2) : b;
}
export const CURRENCY: Record<string, string> = { CNY: '¥', USD: '$' };

export const PHASE_TEXT: Record<Phase, string> = {
  initializing: '正在准备登录…',
  'waiting-browser': '在浏览器里完成登录后回到这里',
  exchanging: '正在确认登录…',
  committing: '正在保存登录…',
  succeeded: '已登录',
  cancelled: '已取消',
  expired: '登录超时了，再试一次',
  failed: '没能登录，再试一次',
};
