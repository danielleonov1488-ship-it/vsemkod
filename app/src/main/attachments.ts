import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Attachment } from "../shared/api";
import { imageFile } from "../shared/workspace";

export const attachmentLimit = 2 * 1024 * 1024;
const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp" };

export class Attachments {
  private readonly paths = new Map<string, { directory: string; path: string; image: boolean }>();

  constructor(private readonly data: string) {}

  async add(directory: string, entry: { name: string; path?: string; data?: Uint8Array; mime: string }): Promise<Attachment> {
    const name = basename(entry.name).replace(/[^\p{L}\p{N}_. ()-]/gu, "_").slice(-140) || "Вложение";
    const source = entry.path ? await realpath(entry.path) : undefined;
    const info = source && await stat(source);
    if (info && (!info.isFile() || info.size > attachmentLimit)) throw new Error("Можно прикрепить файлы размером до 2 МБ.");
    const image = imageFile(name) || entry.mime.startsWith("image/");
    const mime = imageTypes[extname(name).toLowerCase()];
    if (image && !mime) throw new Error("Для изображений доступны PNG, JPEG, GIF и WebP.");
    const id = randomUUID();
    const bytes = entry.data ?? (image && source ? await readFile(source) : undefined);
    if (!source && !bytes?.length || bytes && bytes.length > attachmentLimit) throw new Error("Можно прикрепить файлы размером до 2 МБ.");
    let path = source;
    if (!path || bytes) {
      const folder = join(this.data, id);
      await mkdir(folder, { recursive: true });
      path = join(folder, name);
      await writeFile(path, bytes!, { mode: 0o600 });
    }
    this.paths.set(id, { directory, path, image });
    return { id, name, image, preview: mime && bytes ? "data:" + mime + ";base64," + Buffer.from(bytes).toString("base64") : undefined };
  }

  async resolve(directory: string, ids: string[], vision: boolean, origin?: string) {
    return Promise.all(ids.map(async id => {
      const entry = this.paths.get(id);
      if (!entry || (entry.directory !== directory && entry.directory !== origin) || await realpath(entry.path) !== entry.path) throw new Error("Вложение недоступно.");
      if (entry.image && !vision) throw new Error("Выбранная модель не принимает изображения. Выберите другую модель или уберите изображение.");
      const info = await stat(entry.path);
      if (!info.isFile() || info.size > attachmentLimit) throw new Error("Можно прикрепить файлы размером до 2 МБ.");
      return entry.path;
    }));
  }
}
