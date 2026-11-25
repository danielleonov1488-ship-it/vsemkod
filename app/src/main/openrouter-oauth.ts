import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";

export function createPkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function page(res: ServerResponse, status: number, title: string, detail: string) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff"
  });
  res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · vsemkod</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1112;color:#edf0f0;font:16px system-ui}main{max-width:32rem;padding:2rem}strong{color:#3ddc97}h1{font-size:2rem}p{color:#aab1b3}</style>
<main><strong>vsemkod</strong><h1>${title}</h1><p>${detail}</p></main></html>`);
}

export async function openRouterKey(
  auth: { authorizeUrl: string; exchangeUrl: string },
  open: (url: string) => Promise<void>,
  cancel: AbortSignal,
  timeoutMs = 300_000
): Promise<string> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([cancel, deadline]);
  const { verifier, challenge } = createPkce();
  const state = randomBytes(24).toString("base64url");
  let receive!: (callback: { code?: string; res: ServerResponse }) => void;
  const callback = new Promise<{ code?: string; res: ServerResponse }>(resolve => { receive = resolve; });
  let port = 0;
  let claimed = false;
  const server = createServer({ headersTimeout: 5000, requestTimeout: 10_000, connectionsCheckingInterval: 1000 }, (req, res) => {
    if (claimed || req.method !== "GET" || req.headers.host !== "localhost:" + port || !req.url?.startsWith("/")) {
      res.writeHead(404).end();
      return;
    }
    const url = URL.parse(req.url, "http://localhost:" + port);
    if (!url) { res.writeHead(400).end(); return; }
    const codes = url.searchParams.getAll("code");
    const code = codes.length === 1 && /^[!-~]{1,4096}$/.test(codes[0]) ? codes[0] : undefined;
    const states = url.searchParams.getAll("state");
    if (url.pathname !== "/callback" || url.hostname !== "localhost" || states.length !== 1 ||
      states[0] !== state || (!code && !url.searchParams.has("error"))) {
      res.writeHead(400).end();
      return;
    }
    claimed = true;
    receive({ code, res });
  });
  let browserResponse: ServerResponse | undefined;
  let abort!: () => void;
  try {
    signal.throwIfAborted();
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Не удалось запустить локальный вход.");
    port = address.port;
    const url = new URL(auth.authorizeUrl);
    url.searchParams.set("callback_url", "http://localhost:" + port + "/callback");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("key_label", "vsemkod");
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    const result = await Promise.race([cancelled, Promise.resolve().then(() => open(url.href)).then(() => callback)]);
    browserResponse = result.res;
    if (!result.code) throw new Error("Вход в OpenRouter отклонён. Попробуйте ещё раз.");
    const response = await fetch(auth.exchangeUrl, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: result.code, code_verifier: verifier, code_challenge_method: "S256" })
    });
    if (!response.ok) {
      void response.body?.cancel();
      throw new Error("OpenRouter отклонил код входа. Попробуйте ещё раз.");
    }
    const resultKey = z.object({ key: z.string().min(1) }).safeParse(await response.json());
    if (!resultKey.success) throw new Error("OpenRouter не вернул ключ. Попробуйте ещё раз.");
    page(result.res, 200, "Готово, вернитесь в vsemkod", "Можно закрыть эту вкладку.");
    return resultKey.data.key;
  } catch (error) {
    if (browserResponse) page(browserResponse, 400, "Вход не завершён", "Вернитесь в vsemkod и повторите подключение.");
    if (deadline.aborted) throw new Error("Время входа истекло. Попробуйте ещё раз.");
    if (cancel.aborted) throw new Error("Вход отменён.");
    if (error instanceof TypeError || error instanceof SyntaxError) throw new Error("Не удалось связаться с OpenRouter. Проверьте соединение.");
    throw error;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    server.close();
    if (!browserResponse) server.closeAllConnections();
  }
}
