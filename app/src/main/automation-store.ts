import type { z } from "zod";
import { readJson, writeJson } from "./storage";

export type AutomationHandler = <A extends z.ZodType, R>(
  channel: string, schema: A, run: (args: z.output<A>) => R
) => void;

/** Serialize read-modify-write operations, including results from background runs. */
export async function automationStore<T>(path: string, schema: z.ZodType<T[]>) {
  let items = await readJson(path, schema) ?? [];
  let pending = Promise.resolve();
  return {
    list: () => items,
    update(change: (items: T[]) => T[]) {
      const write = pending.then(async () => {
        const next = change(items);
        if (next !== items) {
          await writeJson(path, next);
          items = next;
        }
        return items;
      });
      pending = write.then(() => {}, () => {});
      return write;
    }
  };
}

export function replaceAutomation<T extends { id: string }>(items: T[], item: T) {
  return items.some(current => current.id === item.id)
    ? items.map(current => current.id === item.id ? item : current)
    : [...items, item];
}
