
import { emitKeypressEvents } from "node:readline";

export function promptKey(): Promise<string> {
  const input = process.stdin;
  const output = process.stderr;
  if (!input.isTTY) throw new Error("Для скрытого ввода нужен терминал. В CI задайте ключ переменной окружения.");

  output.write("Введите ключ: ");
  const wasRaw = input.isRaw;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    function finish(error?: Error) {
      input.off("keypress", onKey);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    }
    function onKey(text: string | undefined, key: { name?: string; ctrl?: boolean }) {
      if (key.ctrl && ["c", "d"].includes(key.name ?? "")) return finish(new Error("Ввод отменён."));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") value = value.slice(0, -1);
      else if (text && !key.ctrl && /^[!-~]+$/.test(text)) value += text;
    }
    input.on("keypress", onKey);
  });
}
