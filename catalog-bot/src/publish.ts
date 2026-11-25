import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { catalogChanged, compare, stableJson } from "./merge.js";
import { catalogSchema, changesSchema, offerKey } from "./schema.js";
import type { Catalog, Change } from "./schema.js";
import { newState, stateSchema } from "./state.js";
import type { State } from "./state.js";
import type { Config } from "./config.js";
import { providers } from "./registry/providers.js";
import { request } from "./sources/common.js";

const dataDir = "data";
const catalogFile = "catalog.json";
const changesFile = "changes.json";
const stateFile = "state.json";
const pendingFile = ".pending.json";

const pendingSchema = z.object({
  catalog: catalogSchema.optional(),
  changes: changesSchema.optional(),
  state: stateSchema.optional(),
});
type Pending = z.infer<typeof pendingSchema>;

async function read<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const content = await readFile(join(dataDir, file), "utf8");
    return schema.parse(JSON.parse(content));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(dataDir + "/" + file + ": не удалось прочитать или проверить JSON", { cause: error });
  }
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  const path = join(dataDir, file);
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, stableJson(data), { encoding: "utf8", flag: "wx" });
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function writePending(pending: Pending): Promise<void> {
  if (pending.changes) await writeAtomic(changesFile, pending.changes);
  if (pending.catalog) await writeAtomic(catalogFile, pending.catalog);
  if (pending.state) await writeAtomic(stateFile, pending.state);
}

export async function readCatalog(): Promise<Catalog | undefined> {
  return read(catalogFile, catalogSchema);
}

export async function readPublication(dryRun: boolean): Promise<{ catalog?: Catalog; changes: Change[]; state: State }> {
  const pending = await read(pendingFile, pendingSchema);
  if (pending && !dryRun) {
    await writePending(pending);
    await unlink(join(dataDir, pendingFile));
  }
  const [catalog, changes, state] = await Promise.all([
    pending?.catalog ?? readCatalog(),
    pending?.changes ?? read(changesFile, changesSchema),
    pending?.state ?? read(stateFile, stateSchema),
  ]);
  return { catalog, changes: changes ?? [], state: state ?? newState() };
}

export async function publish(
  previous: Awaited<ReturnType<typeof readPublication>>,
  catalog: Catalog, events: Change[], state: State, dryRun: boolean,
): Promise<boolean> {
  const changed = catalogChanged(previous.catalog, catalog);
  if (dryRun) return changed;
  const pending: Pending = {};
  if (changed) pending.catalog = catalog;
  if (events.length || !previous.catalog) {
    pending.changes = [...events, ...previous.changes].sort((a, b) =>
      Date.parse(b.date) - Date.parse(a.date) ||
      compare(a.type, b.type) || compare(a.modelId, b.modelId) ||
      compare(a.providerId ?? "", b.providerId ?? "") ||
      compare(a.providerModelId ?? "", b.providerModelId ?? ""),
    ).slice(0, 200);
  }
  if (stableJson(state) !== stableJson(previous.state) || !previous.catalog) pending.state = state;
  if (Object.keys(pending).length === 0) return changed;

  await mkdir(dataDir, { recursive: true });
  if (Object.keys(pending).length === 1) {
    await writePending(pending);
  } else {
    await writeAtomic(pendingFile, pending);
    await writePending(pending);
    await unlink(join(dataDir, pendingFile));
  }
  return changed;
}

export async function notifyTelegram(
  config: NonNullable<Config["telegram"]>, events: Change[], catalog: Catalog,
): Promise<boolean> {
  const models = new Map(catalog.models.filter(({ tier }) => tier === "top").map(({ id, name }) => [id, name]));
  const active = new Set(catalog.offers.filter(({ status }) => status === "active").map(offerKey));
  const lines = new Set<string>();
  for (const event of events) {
    const { providerId, providerModelId } = event;
    const model = models.get(event.modelId);
    if (event.type !== "offer_added" || !providerId || !providerModelId || !model ||
        !active.has(offerKey({ providerId, providerModelId }))) continue;
    lines.add(model + " бесплатно у " + providers[providerId].name);
  }
  if (!lines.size) return false;
  const text = lines.size === 1
    ? "🦛 Новая раздача: " + [...lines][0] + ". Подключить — в vsemkod"
    : "🦛 Новые раздачи\n" + [...lines].map((line) => "• " + line).join("\n").slice(0, 3700) + "\nПодключить — в vsemkod";
  const response = await request("https://api.telegram.org/bot" + config.token + "/sendMessage",
    (result) => result.json(), {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.chatId, text }),
    }, 0);
  if (!z.object({ ok: z.literal(true) }).safeParse(response).success) throw new Error("Telegram не подтвердил отправку");
  return true;
}
