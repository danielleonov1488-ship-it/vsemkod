import { describe, expect, it } from "vitest";
import { chatMessages, readJson } from "../src/protocol";
import { DAY, SESSION_MS, hashIp, issueToken, verifyToken } from "../src/token";

const user = { role: "user", content: "Привет" };
const assistant = { role: "assistant", content: "Ответ" };

describe("тело /chat", () => {
  it("принимает до восьми сообщений и считает символы Unicode", () => {
    const messages = [assistant, user, assistant, user, assistant, user, assistant, user];
    expect(chatMessages({ messages })).toEqual(messages);
    expect(chatMessages({ messages: Array(4).fill({ ...user, content: "😀".repeat(2000) }) })).toHaveLength(4);
  });

  it.each(["tools", "functions", "model", "temperature", "response_format", "system", "max_tokens"])("отклоняет поле %s", (key) => {
    expect(chatMessages({ messages: [user], [key]: null })).toBeUndefined();
  });

  it("отклоняет неподдерживаемые роли, типы и лишние поля сообщений", () => {
    for (const item of [null, {}, { ...user, role: "system" }, { ...user, role: "tool" }, { ...user, content: 1 }, { ...user, name: "x" }]) {
      expect(chatMessages({ messages: [item, user] })).toBeUndefined();
    }
    expect(chatMessages({ messages: [user, assistant] })).toBeUndefined();
  });

  it("проверяет число сообщений, размер каждого и сумму", () => {
    expect(chatMessages({ messages: [] })).toBeUndefined();
    expect(chatMessages({ messages: Array(9).fill(user) })).toBeUndefined();
    expect(chatMessages({ messages: [{ ...user, content: "я".repeat(2001) }] })).toBeUndefined();
    expect(chatMessages({ messages: [...Array(4).fill({ ...user, content: "я".repeat(2000) }), user] })).toBeUndefined();
  });

  it("отклоняет слишком большие и испорченные HTTP-тела", async () => {
    expect(await readJson(new Response("{} ".repeat(100)), 100)).toBeUndefined();
    expect(await readJson(new Response("{ invalid"), 100)).toBeUndefined();
    expect(await readJson(new Response('{"ok":true}'), 100)).toEqual({ ok: true });
  });
});

describe("сессионный токен", () => {
  const secret = "unit-test-only";
  const ip = "192.0.2.40";
  const ua = "test-browser";
  const now = Date.UTC(2026, 10, 25, 23, 58);

  it("проверяет HMAC, срок, IP и User-Agent", async () => {
    const hash = await hashIp(ip, secret, now);
    const { token, expiresAt } = await issueToken(secret, hash, ua, now);
    expect(expiresAt).toBe(now + SESSION_MS);
    expect(await verifyToken(token, secret, ip, ua, now)).toBe(true);
    expect(await verifyToken(token, secret, ip, ua, expiresAt)).toBe(false);
    expect(await verifyToken(token, secret, ip, ua, now - 1)).toBe(false);
    expect(await verifyToken(token, secret, "192.0.2.41", ua, now)).toBe(false);
    expect(await verifyToken(token, secret, ip, "other-browser", now)).toBe(false);
    expect(await verifyToken(token, "different-secret", ip, ua, now)).toBe(false);
    const [payload, sig] = token.split(".");
    expect(await verifyToken(`${payload}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`, secret, ip, ua, now)).toBe(false);
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    expect(body).toEqual({ ipHash: hash, uaHash: expect.any(String), exp: expiresAt, nonce: expect.any(String) });
  });

  it("меняет соль в 00:00 UTC, сохраняя оставшийся срок токена", async () => {
    const ipHash = await hashIp(ip, secret, now);
    expect(await hashIp(ip, secret, now + 60_000)).toBe(ipHash);
    expect(await hashIp(ip, secret, now + DAY)).not.toBe(ipHash);
    expect(await hashIp(ip, "other-secret", now)).not.toBe(ipHash);
    const { token } = await issueToken(secret, ipHash, ua, now);
    expect(await verifyToken(token, secret, ip, ua, now + 180_000)).toBe(true);
  });
});
