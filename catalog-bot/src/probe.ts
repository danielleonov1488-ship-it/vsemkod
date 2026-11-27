import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList } from "node:net";
import { z } from "zod";
import type { Discovered, DiscoveredInput } from "./schema.js";
import { isZeroPrice } from "./sources/common.js";
import { isFreeId, isModelId, providerBase } from "./sources/discovery.js";

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) privateAddresses.addSubnet(address, prefix);
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  privateAddresses.addSubnet(address, prefix, "ipv6");
}
const publicIpv6 = new BlockList();
publicIpv6.addSubnet("2000::", 3, "ipv6");

export function publicAddress(address: string, family: number) {
  if (family === 4) return !privateAddresses.check(address);
  return family === 6 && publicIpv6.check(address, "ipv6") && !privateAddresses.check(address, "ipv6");
}

type ProbeResponse = { status: number; data?: unknown };
type ProbeRequest = (url: string, init: { key?: string; body?: unknown }) => Promise<ProbeResponse>;

const requestPublic: ProbeRequest = (value, { key, body }) => new Promise((resolve, reject) => {
  const url = new URL(value);
  if (key && url.protocol !== "https:") throw new Error("Для ключа нужен HTTPS");
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = request(url, {
    agent: false, method: payload ? "POST" : "GET", signal: AbortSignal.timeout(12_000),
    headers: {
      accept: "application/json",
      ...(key ? { authorization: "Bearer " + key } : {}),
      ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
    },
    // Validate the addresses used by this connection. Redirects are never followed.
    lookup(host, _options, callback) {
      lookup(host, { all: true }, (error, addresses) => {
        if (error || !addresses.length || addresses.some(({ address, family }) => !publicAddress(address, family))) {
          callback(error ?? new Error("Непубличный адрес провайдера"), "", 4);
        } else if (_options.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      });
    },
  }, res => {
    const status = res.statusCode ?? 0;
    if (status !== 200) {
      res.destroy();
      resolve({ status });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4_000_000) req.destroy(new Error("Слишком большой ответ проверки"));
      else chunks.push(chunk);
    });
    res.on("error", reject);
    res.on("end", () => {
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* HTTP 200 with invalid JSON */ }
      resolve({ status, data });
    });
  });
  req.on("error", reject);
  req.end(payload);
});

const price = z.union([z.string(), z.number()]).nullish();
const modelList = z.object({
  data: z.array(z.object({
    id: z.string().refine(isModelId), free: z.boolean().optional(),
    pricing: z.object({ free: z.boolean().optional(), prompt: price, completion: price, input: price, output: price }).optional().catch(undefined),
    input_price: price, output_price: price,
  }).passthrough().nullable().catch(null)),
});
const completion = z.object({
  choices: z.array(z.object({
    message: z.object({ tool_calls: z.array(z.object({ function: z.object({ name: z.string() }) })).optional().nullable() }),
  })).min(1),
});

export async function probeCandidate(
  candidate: DiscoveredInput, at: string, key?: string, transport: ProbeRequest = requestPublic,
): Promise<Pick<Discovered, "probe" | "probedModel">> {
  const result = (status: Discovered["probe"]["status"], tools: boolean | null = null, probedModel?: string) =>
    ({ probe: { at, status, tools, authenticated: key ? true : undefined }, probedModel });
  const base = candidate.baseUrl;
  if (!base || !providerBase(base) && transport === requestPublic) return result("unreachable");
  const modelsUrl = base + "/models";
  let status: Discovered["probe"]["status"] = "unreachable";
  let modelId: string | undefined;
  try {
    const anonymous = await transport(modelsUrl, {});
    if (anonymous.status === 401 || anonymous.status === 403) status = "key-required";
    else if (anonymous.status === 200) status = "available";
    else if (!key) return result(status);
    const listing = key ? await transport(modelsUrl, { key }) : anonymous;
    if (listing.status !== 200) return result(key ? "unreachable" : status);

    const parsed = modelList.safeParse(listing.data);
    if (!parsed.success) return result("unreachable");
    const models = parsed.data.data.filter(model => model !== null).filter(model => model.free !== false &&
      !/(?:embed|rerank|image|tts|moderation|whisper|router\/free)/i.test(model.id));
    const free = models.filter(model => model.free || model.pricing?.free || isFreeId(model.id) ||
      isZeroPrice(model.pricing?.prompt ?? model.pricing?.input ?? model.input_price) &&
      isZeroPrice(model.pricing?.completion ?? model.pricing?.output ?? model.output_price));
    const mentioned = models.filter(model => candidate.models.includes(model.id));
    modelId = free.find(model => candidate.models.includes(model.id))?.id ?? free[0]?.id ??
      mentioned[0]?.id ?? (key ? undefined : models[0]?.id);
    if (!modelId) return result(status);
    const chat = await transport(base + "/chat/completions", {
      key,
      body: {
        model: modelId, max_tokens: 16, stream: false,
        messages: [{ role: "user", content: "Call the probe tool now." }],
        tools: [{ type: "function", function: { name: "probe", parameters: { type: "object", properties: {} } } }],
        tool_choice: { type: "function", function: { name: "probe" } },
      },
    });
    if ([401, 403].includes(chat.status) && !key) return result("key-required", null, modelId);
    // 400/422 can mean tools are unsupported even when the API is available.
    if ([400, 422].includes(chat.status)) return result("available", false, modelId);
    const answer = completion.safeParse(chat.data);
    if (chat.status !== 200 || !answer.success) return result("unreachable", null, modelId);
    return result("available", answer.data.choices.some(choice =>
      choice.message.tool_calls?.some(call => call.function.name === "probe")), modelId);
  } catch { return result("unreachable", null, modelId); }
}
