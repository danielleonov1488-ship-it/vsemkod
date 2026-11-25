export const DAY = 86_400_000;
export const SESSION_MS = 15 * 60_000;

type Claims = { ipHash: string; uaHash: string; exp: number; nonce: string };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utcDay(now: number): number {
  return Math.floor(now / DAY) * DAY;
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}

async function sha256(value: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function hashIp(ip: string, secret: string, now: number): Promise<string> {
  const salt = await sha256(`ip-salt\0${utcDay(now)}\0${secret}`);
  return sha256(`${ip}\0${salt}`);
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueToken(secret: string, ipHash: string, userAgent: string, now: number) {
  const claims: Claims = { ipHash, uaHash: await sha256(userAgent), exp: now + SESSION_MS, nonce: crypto.randomUUID() };
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return { token: `${payload}.${base64url(signature)}`, expiresAt: claims.exp };
}

export async function verifyToken(token: string, secret: string, ip: string, userAgent: string, now: number): Promise<boolean> {
  if (!/^[\w-]{1,512}\.[\w-]{43}$/.test(token)) return false;
  try {
    const [payload, signature] = token.split(".");
    const signatureBytes = fromBase64url(signature);
    if (base64url(signatureBytes) !== signature) return false;
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), signatureBytes, encoder.encode(payload)))) return false;
    const claims = JSON.parse(decoder.decode(fromBase64url(payload))) as Claims;
    if (!Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp > now + SESSION_MS) return false;
    // Use the issue day's salt so a 15-minute session can span midnight UTC.
    const [ipHash, uaHash] = await Promise.all([hashIp(ip, secret, claims.exp - SESSION_MS), sha256(userAgent)]);
    return claims.ipHash === ipHash && claims.uaHash === uaHash && typeof claims.nonce === "string";
  } catch {
    return false;
  }
}
