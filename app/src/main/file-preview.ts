import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canOpenFile, fileExtension } from "../shared/file-links";
import type { FileInfo, FilePreview } from "../shared/api";
import { projectPath } from "./engine/revert-files";

const imageTypes = new Map([
  ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"],
  ["gif", "image/gif"], ["webp", "image/webp"], ["svg", "image/svg+xml"]
]);
const textLimit = 512 * 1024;
const imageLimit = 8 * 1024 * 1024;

export async function checkedFile(directory: string, path: string) {
  const root = await realpath(directory);
  const requested = resolve(root, path);
  const relativePath = relative(root, requested);
  if (!relativePath || isAbsolute(relativePath) || relativePath === ".." ||
      relativePath.startsWith(".." + sep) || (process.platform === "win32" && relativePath.includes(":"))) {
    throw new Error("Путь находится за пределами проекта.");
  }
  const target = await projectPath(root, requested);
  const metadata = await stat(target);
  if (!metadata.isFile()) throw new Error("Файл не найден.");
  const extension = fileExtension(target);
  const name = basename(requested);
  const folder = dirname(relativePath);
  const mime = imageTypes.get(extension);
  const info: FileInfo = {
    path: target, relativePath, name, directory: folder === "." ? "" : folder,
    image: Boolean(mime), svg: extension === "svg",
    html: /^(?:html|htm)$/.test(extension) && /^(?:html|htm)$/.test(fileExtension(requested)),
    canOpen: canOpenFile(requested) && canOpenFile(target) && (process.platform === "win32" || (metadata.mode & 0o111) === 0)
  };
  return { info, metadata, mime };
}

export async function previewFile(directory: string, path: string): Promise<FilePreview> {
  const { info, metadata, mime } = await checkedFile(directory, path);
  if (mime && metadata.size > imageLimit) throw new Error("Изображение превышает 8 МБ.");
  const handle = await open(info.path, "r");
  try {
    const current = await handle.stat();
    if (current.dev !== metadata.dev || current.ino !== metadata.ino || !current.isFile()) {
      throw new Error("Файл изменился. Откройте просмотр снова.");
    }
    const limit = mime ? imageLimit : textLimit;
    if (mime && current.size > limit) throw new Error("Изображение превышает 8 МБ.");
    const buffer = Buffer.alloc(Math.min(current.size, limit));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const data = buffer.subarray(0, offset);
    const text = info.svg || !mime ? new TextDecoder().decode(data.subarray(0, textLimit)) : undefined;
    if (!mime && data.includes(0)) throw new Error("Просмотр этого формата недоступен.");
    return { info, text, truncated: text === undefined ? undefined : current.size > textLimit,
      image: mime ? "data:" + mime + ";base64," + data.toString("base64") : undefined };
  } finally { await handle.close(); }
}
