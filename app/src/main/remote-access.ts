import { z } from "zod";
import type { RemoteAccess } from "../shared/api";
import type { KeyStore } from "./key-store";
import { RemoteWeb } from "./remote-web";
import { TelegramBot, type TelegramChats } from "./telegram-bot";

type Handle = <Schema extends z.ZodType, Result>(name: string, schema: Schema, run: (args: z.output<Schema>) => Result) => void;

export function registerRemoteAccess(
  handle: Handle,
  publish: (channel: string, payload: RemoteAccess) => void,
  target: ConstructorParameters<typeof RemoteWeb>[0],
  keys: KeyStore,
  chats: TelegramChats
) {
  const web = new RemoteWeb(target);
  const telegram = new TelegramBot(keys, chats, notify);
  let webError: string | undefined;
  let pending = Promise.resolve();
  let closed = false;
  function state(): RemoteAccess {
    return { web: { ...web.state(), error: webError }, telegram: telegram.state() };
  }
  function notify() {
    const current = state();
    publish("remote:event", current);
    return current;
  }
  handle("remote:get", z.tuple([]), state);
  handle("remote:web", z.tuple([z.boolean()]), ([enabled]) => {
    const result = pending.then(async () => {
      if (closed) return state();
      webError = undefined;
      try {
        if (enabled) await web.start();
        else await web.stop();
      } catch (error) {
        webError = error instanceof Error ? error.message : "Не удалось открыть доступ в локальной сети.";
      }
      return notify();
    });
    pending = result.then(() => {}, () => {});
    return result;
  });
  handle("remote:telegram", z.tuple([z.string().trim().max(256).nullable(), z.string().min(1).max(32_768).optional()]), async ([token, project]) => {
    await telegram.configure(token, project);
    return state();
  });
  telegram.load();
  return {
    onChat: telegram.onChat.bind(telegram),
    webEnabled: () => web.enabled,
    close: async () => { closed = true; telegram.stop(); await pending; await web.stop(); }
  };
}
