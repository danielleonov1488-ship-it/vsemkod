// Поиск ключей и паролей в тексте сообщения перед отправкой бесплатному провайдеру.

export type SecretMatch = { kind: string; start: number; end: number };

const patterns: [string, RegExp][] = [
  ["Приватный ключ", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g],
  ["Ключ Anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["Ключ OpenAI / OpenRouter / DeepSeek", /\bsk-(?:proj-|or-v1-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ["Ключ Groq", /\bgsk_[A-Za-z0-9]{20,}/g],
  ["Ключ Google", /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ["Токен GitHub", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["Токен Slack", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["Ключ AWS", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Ключ Hugging Face", /\bhf_[A-Za-z0-9]{30,}/g],
  ["Ключ Artificial Analysis", /\baa_[A-Za-z0-9]{30,}/g],
  ["Пароль", /\b(?:password|passwd|pwd|пароль)\s*[:=]\s*["']?[^\s"']{4,}/gi],
  ["Токен", /\b(?:api[_-]?key|secret|token|bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{16,}/gi],
];

/** Найденные секреты без пересечений, по порядку. */
export function findSecrets(text: string): SecretMatch[] {
  const found: SecretMatch[] = [];
  for (const [kind, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (found.some(item => start < item.end && item.start < end)) continue;
      found.push({ kind, start, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Заменяет найденные секреты на «***», оставляя имя поля у пар «password=…». */
export function maskSecrets(text: string): string {
  let result = "";
  let cursor = 0;
  for (const { start, end } of findSecrets(text)) {
    const value = text.slice(start, end);
    const field = /^([^:=]*[:=]\s*["']?)/.exec(value);
    const keep = /^(?:-----BEGIN|sk-|gsk_|AIza|gh|github_pat_|xox|AKIA|hf_|aa_)/.test(value) ? "" : field?.[1] ?? "";
    result += text.slice(cursor, start) + keep + "***";
    cursor = end;
  }
  return result + text.slice(cursor);
}
