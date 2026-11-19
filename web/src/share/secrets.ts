// Recognisable credentials, the same families dsh-Go masks in sent text
// (app/lib/ui/chat/secret_mask.dart, after DeepSeek's chat client): sk-…,
// Google, GitHub, GitLab, npm, Hugging Face, AWS / Aliyun / Tencent keys,
// Slack, Stripe, webhook secrets, JWTs, private key blocks, passwords in URLs.
// Bounded quantifiers only.

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/,
  /\bsk-(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{20,200}/,
  /\bAIza[A-Za-z0-9_-]{35}/,
  /\bghp_[A-Za-z0-9]{36,80}/,
  /\bgh[ousr]_[A-Za-z0-9]{36,80}/,
  /\bgithub_pat_\w{22,255}/,
  /\bglpat-[A-Za-z0-9_-]{20,80}/,
  /\bnpm_[A-Za-z0-9]{36,80}/,
  /\bhf_[A-Za-z0-9]{30,80}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bLTAI[A-Za-z0-9]{12,30}/,
  /\bAKID[A-Za-z0-9]{13,40}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,200}/,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,200}/,
  /\bwhsec_[A-Za-z0-9]{24,200}/,
  /\beyJ[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,2048}/,
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@?#]{1,200}:[^\s/@?#]{1,200}@/,
];

export const containsSecret = (text: string) => PATTERNS.some((p) => p.test(text));
