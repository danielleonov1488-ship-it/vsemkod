export type FileReference = { path: string; line?: number };

const executableExtensions = new Set((
  "exe bat cmd ps1 sh com msi scr js vbs jar app lnk desktop appimage " +
  "psm1 psd1 cjs mjs jse vb vbe wsf wsh hta pif cpl msc reg scf url " +
  "command bash zsh fish py pyw rb pl php run bin dll so dylib gadget application msix appx"
).split(" "));

export function fileExtension(path: string) {
  return /[.]([a-z\d]+)[. ]*$/i.exec(path)?.[1].toLowerCase() ?? "";
}

export function canOpenFile(path: string) {
  return Boolean(fileExtension(path)) && !executableExtensions.has(fileExtension(path));
}

export function fileReference(value: string): FileReference | undefined {
  const suffix = /:(\d+)$/.exec(value);
  const path = suffix ? value.slice(0, suffix.index) : value;
  if (/[\r\n\t]|:\/\/|^(?:www\.|[a-z][a-z\d+.-]*:(?![\\/]))/i.test(path)) return;
  if (!/[.]([\p{L}][\p{L}\d_-]{0,19})$/u.test(path) ||
      !/^(?:[a-z]:[\\/]|[/\\]|[\p{L}\d_.@-])/iu.test(path) ||
      /[<>|?*"#]|:(?![\\/])/.test(path)) return;
  const line = suffix ? Number(suffix[1]) : undefined;
  return { path, line: line && Number.isSafeInteger(line) ? line : undefined };
}

export function textFileReferences(text: string) {
  const candidates = /(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>"']+|["“«][^"”»\r\n]+["”»]|(?:[a-z]:[\\/]|\/)(?:[\p{L}\p{N}_.()@ -]+[\\/])*?[\p{L}\p{N}_.()@ -]+?\.[\p{L}][\p{L}\d_-]{0,19}(?::\d+)?(?=$|[\s.,;!?()[\]{}"”»])|[^\s<>"'“”«»()[\]{},;!?]+/giu;
  return [...text.matchAll(candidates)].flatMap(match => {
    const token = match[0].replace(/[.,;!?]+$/, "");
    const quoted = /^["“«]/.test(token);
    const value = quoted ? token.slice(1, -1) : token;
    const ref = fileReference(value);
    return ref ? [{ ...ref, start: match.index, end: match.index + token.length }] : [];
  });
}
