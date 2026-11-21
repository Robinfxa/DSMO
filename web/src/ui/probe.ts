// 测试连接: the two checks a provider gets — 网络连通 (its model list, free) and 真实小额测试 (one tiny
// real message) — and how their results read, shared by 账号管理 and a provider's detail page.
import { useState } from 'preact/hooks';
import { probeNetwork, probeReply, type NetProbe, type ReplyProbe } from '../engine/providers';

export const COST_NOTE = '网络测试只读模型列表，不花钱。真实测试发一条很短的消息、按正常价格计费：引擎的系统提示会一起发出，输入大约几千 token，输出几个 token。';

const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} 秒`);
const n = (x?: number) => (x === undefined ? '?' : x.toLocaleString());

export function netLine(r: NetProbe): string {
  return r.ok ? `通 · ${secs(r.ms)} · 列出 ${r.models ?? 0} 个模型` : `不通：${r.error ?? '未知错误'}`;
}
export function replyLine(r: ReplyProbe): string {
  if (!r.ok) return `失败：${r.error ?? '未知错误'}`;
  const u = r.usage;
  const tokens = u && (u.input || u.output || u.total) ? ` · ${n(u.total ?? (u.input ?? 0) + (u.output ?? 0))} token（输入 ${n(u.input)} / 输出 ${n(u.output)}）` : '';
  return `成功 · ${secs(r.ms)} · 回复「${r.reply}」${tokens}`;
}

export function useProbe() {
  const [net, setNet] = useState<NetProbe | null>(null);
  const [reply, setReply] = useState<ReplyProbe | null>(null);
  const [running, setRunning] = useState<'net' | 'reply' | null>(null);
  return {
    net,
    reply,
    running,
    runNet: async (provider: string) => {
      setRunning('net');
      setNet(null);
      try {
        setNet(await probeNetwork(provider));
      } finally {
        setRunning(null);
      }
    },
    runReply: async (provider: string, model: string) => {
      setRunning('reply');
      setReply(null);
      try {
        setReply(await probeReply(provider, model));
      } finally {
        setRunning(null);
      }
    },
  };
}
