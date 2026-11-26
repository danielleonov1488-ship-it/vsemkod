// Встроенный браузер: общие типы и чистые функции (адресная строка, фильтр навигации, поиск localhost-адресов).

export type BrowserBounds = { x: number; y: number; width: number; height: number };
export type BrowserConsoleError = { message: string; source?: string; line?: number; at: number };
export type BrowserState = {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  errors: BrowserConsoleError[];
  /** Текст ошибки загрузки или запрета адреса. */
  failure?: string;
};
export type BrowserEvent = { type: "state"; state: BrowserState } | { type: "download"; name: string; path: string };

export type BrowserApi = {
  show(bounds: BrowserBounds): Promise<void>;
  hide(): Promise<void>;
  navigate(input: string, directory?: string): Promise<BrowserState>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  stop(): Promise<void>;
  external(): Promise<void>;
  devtools(): Promise<void>;
  clearData(): Promise<void>;
  clearErrors(): Promise<void>;
  reveal(path: string): Promise<void>;
  state(): Promise<BrowserState>;
  subscribe(listener: (event: BrowserEvent) => void): () => void;
};

export const emptyBrowserState: BrowserState = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, errors: [] };

const localHost = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i;

/** Превращает ввод адресной строки в URL. Пустой или явно опасный ввод — undefined. */
export function normalizeAddress(input: string): string | undefined {
  const text = input.trim();
  if (!text || /\s/.test(text)) return undefined;
  if (/^(?:https?|file):/i.test(text)) {
    try { return new URL(text).href; } catch { return undefined; }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !localHost.test(text) && !/^[^/:]+:\d{1,5}(?:[/?#]|$)/.test(text)) return undefined;
  const scheme = localHost.test(text) ? "http://" : "https://";
  try {
    const url = new URL(scheme + text);
    if (!url.hostname.includes(".") && !localHost.test(text)) return undefined;
    return url.href;
  } catch { return undefined; }
}

function normalizedPath(path: string, windows: boolean) {
  const slashes = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return windows ? slashes.toLowerCase() : slashes;
}

/** Путь file:-URL, если файл лежит внутри root; иначе undefined. */
export function fileInside(url: URL, root: string | undefined, windows = /^[a-z]:[\\/]/i.test(root ?? "")): string | undefined {
  if (url.protocol !== "file:" || !root || url.host) return undefined;
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return undefined; }
  if (windows) path = path.replace(/^\/([a-z]:)/i, "$1");
  if (path.split(/[\\/]/).includes("..")) return undefined;
  const base = normalizedPath(root, windows);
  const target = normalizedPath(path, windows);
  return target === base || target.startsWith(base + "/") ? path : undefined;
}

/** Разрешена ли навигация главного фрейма встроенного браузера. */
export function isAllowedNavigation(href: string, projectRoot?: string): boolean {
  let url: URL;
  try { url = new URL(href); } catch { return false; }
  if (url.protocol === "http:" || url.protocol === "https:") return !url.username && !url.password;
  if (url.protocol === "file:") return fileInside(url, projectRoot) !== undefined;
  return href === "about:blank";
}

const urlPattern = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s"'<>`)\]]*)?/gi;

/** Все localhost-адреса из текста (вывод терминала, ответ агента) без дублей, в порядке появления. */
export function findLocalUrls(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.replace(/\u001b\[[\d;]*m/g, "").matchAll(urlPattern)) {
    const value = match[0].replace(/[.,;:!?]+$/, "").replace("0.0.0.0", "localhost");
    try { found.add(new URL(value).href); } catch { /* не адрес */ }
  }
  return [...found];
}
