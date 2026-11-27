export const cloudflareAccountId = /^[0-9a-f]{32}$/i;
export const cloudflareProbeModel = "@cf/openai/gpt-oss-120b";

export function cloudflareBaseUrl(template: string, accountId?: string): string | undefined {
  if (!accountId || !cloudflareAccountId.test(accountId)) return;
  if (template !== "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1") return;
  return template.replace("{account_id}", accountId);
}
