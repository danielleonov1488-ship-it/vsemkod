import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { emptyBrowserState, type BrowserApi, type BrowserState } from "../shared/browser";
import "./panels.css";

const glyphs: Record<string, ReactNode> = {
  back: <path d="M9.5 3.5 5 8l4.5 4.5" />,
  forward: <path d="m6.5 3.5 4.5 4.5-4.5 4.5" />,
  reload: <><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2" /><path d="M12.5 2.5v3h-3" /></>,
  stop: <path d="m4.5 4.5 7 7m0-7-7 7" />,
  external: <><path d="M9 2.5h4.5V7" /><path d="M13.5 2.5 7.5 8.5" /><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></>,
  more: <path d="M3 8h.1M8 8h.1M13 8h.1" strokeWidth="2.5" />,
  globe: <><circle cx="8" cy="8" r="5.75" /><path d="M2.25 8h11.5M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8S6.4 3.85 8 2.25Z" /></>,
  file: <><path d="M9 2.5H4.5A1.5 1.5 0 0 0 3 4v8A1.5 1.5 0 0 0 4.5 13.5h7A1.5 1.5 0 0 0 13 12V6.5l-4-4Z" /><path d="M9 2.5v4h4" /></>
};

function Glyph({ name }: { name: keyof typeof glyphs }) {
  return <svg className="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">{glyphs[name]}</svg>;
}

/** Всплывающие элементы приложения, которые не должен перекрывать нативный слой браузера. */
let currentProject: string | undefined;

const overlaySelector = ".model-panel, .chat-menu, .composer-menu, dialog[open], [role=dialog], .modal, .tooltip, [data-overlay]";

function overlaps(a: DOMRect, b: DOMRect) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom && b.width > 0 && b.height > 0;
}

function shortUrl(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function BrowserPanel({ api, directory, active, quickLinks, projectIndex, initialUrl, request, onUrl, onSendErrors, onNotice, onDownload }: {
  api?: BrowserApi; directory: string; active: boolean; quickLinks: string[]; projectIndex?: string; initialUrl?: string; request?: { url: string };
  onDownload?: (name: string, path: string) => void;
  onUrl?: (url: string) => void; onSendErrors: (text: string) => void; onNotice: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserState>(emptyBrowserState);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<"" | "more" | "errors">("");
  const [covered, setCovered] = useState(false);
  const opened = useRef(false);
  const handled = useRef<typeof request>(undefined);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    void api.state().then(value => { if (alive && currentProject === directory) setState(value); });
    const stop = api.subscribe(event => {
      if (currentProject !== directory) return;
      if (event.type === "state") setState(event.state);
      if (event.type === "download") onDownload?.(event.name, event.path);
    });
    return () => { alive = false; stop(); };
  }, [api, directory, onDownload]);

  useEffect(() => { if (!editing) setAddress(state.url.startsWith("about:") ? "" : state.url); }, [state.url, editing]);
  useEffect(() => { if (state.url && !state.url.startsWith("about:")) onUrl?.(state.url); }, [state.url, onUrl]);

  const navigate = useCallback((value: string) => {
    if (!api || !value.trim()) return;
    setEditing(false);
    setMenu("");
    currentProject = directory;
    void api.navigate(value, directory).catch(() => onNotice("Не удалось открыть адрес."));
  }, [api, directory, onNotice]);

  // Восстановить последний адрес проекта при первом показе.
  useEffect(() => {
    if (!active) return;
    if (request && handled.current !== request) {
      opened.current = true;
      handled.current = request;
      navigate(request.url);
    } else if (!opened.current || currentProject !== directory) {
      opened.current = true;
      if (currentProject !== directory) setState(emptyBrowserState);
      if (initialUrl && currentProject !== directory) navigate(initialUrl);
    }
  }, [active, directory, initialUrl, request, navigate]);

  const showPage = Boolean(api && active && currentProject === directory && state.url && !state.url.startsWith("about:") && !state.loading && !menu && !covered);

  // Нативный слой следует за областью вкладки; прячется, когда поверх открыт любой попап приложения.
  useLayoutEffect(() => {
    if (!api) return;
    if (!showPage || !host.current) { void api.hide(); return; }
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = host.current?.getBoundingClientRect();
        if (rect && rect.width > 1 && rect.height > 1) void api.show({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
        else void api.hide();
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(host.current);
    window.addEventListener("resize", place);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", place); void api.hide(); };
  }, [api, showPage]);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const area = host.current?.getBoundingClientRect();
        if (!area) return;
        const blocking = [...document.querySelectorAll(overlaySelector)].some(element =>
          !host.current?.contains(element) && overlaps(area, element.getBoundingClientRect()));
        setCovered(blocking);
      });
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "class", "hidden"] });
    check();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [active]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".browser-popover, .browser-menu-button")) setMenu("");
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(""); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [menu]);

  if (!api) return <div className="browser-panel browser-panel--unavailable">
    <div className="browser-empty"><Glyph name="globe" /><h2>Встроенный браузер</h2>
      <p>Встроенный браузер доступен в приложении для компьютера</p>
      <a className="small-button" href="https://vsemkod.ru/" target="_blank" rel="noopener">Скачать</a>
    </div>
  </div>;

  const errors = state.errors;
  const errorWord = errors.length % 10 === 1 && errors.length % 100 !== 11 ? "ошибка"
    : [2, 3, 4].includes(errors.length % 10) && ![12, 13, 14].includes(errors.length % 100) ? "ошибки" : "ошибок";
  const sendErrors = () => {
    const text = "Ошибки в браузере (" + state.url + "):\n" + errors.map(error =>
      "- " + error.message + (error.source ? " (" + error.source.replace(/^.*\//, "") + (error.line ? ":" + error.line : "") + ")" : "")).join("\n");
    onSendErrors(text);
    setMenu("");
  };

  return <div className="browser-panel">
    <div className="browser-toolbar" role="toolbar" aria-label="Навигация браузера">
      <button type="button" className="browser-button" aria-label="Назад" title="Назад" disabled={!state.canGoBack} onClick={() => void api.back()}><Glyph name="back" /></button>
      <button type="button" className="browser-button" aria-label="Вперёд" title="Вперёд" disabled={!state.canGoForward} onClick={() => void api.forward()}><Glyph name="forward" /></button>
      {state.loading
        ? <button type="button" className="browser-button" aria-label="Остановить" title="Остановить" onClick={() => void api.stop()}><Glyph name="stop" /></button>
        : <button type="button" className="browser-button" aria-label="Обновить" title="Обновить" disabled={!state.url} onClick={() => void api.reload()}><Glyph name="reload" /></button>}
      <form className="browser-address" onSubmit={event => { event.preventDefault(); navigate(address); }}>
        <input value={address} spellCheck={false} placeholder="Адрес или localhost:5173" aria-label="Адрес страницы"
          onFocus={event => { setEditing(true); event.currentTarget.select(); }} onBlur={() => setEditing(false)}
          onChange={event => setAddress(event.target.value)}
          onKeyDown={event => { if (event.key === "Escape") { setAddress(state.url); event.currentTarget.blur(); } }} />
      </form>
      {errors.length > 0 && <button type="button" className="browser-errors browser-menu-button" aria-expanded={menu === "errors"}
        onClick={() => setMenu(value => value === "errors" ? "" : "errors")}>● {errors.length} {errorWord}</button>}
      <button type="button" className="browser-button" aria-label="Открыть во внешнем браузере" title="Открыть во внешнем браузере"
        disabled={!state.url} onClick={() => void api.external()}><Glyph name="external" /></button>
      <button type="button" className="browser-button browser-menu-button" aria-label="Ещё" aria-expanded={menu === "more"}
        onClick={() => setMenu(value => value === "more" ? "" : "more")}><Glyph name="more" /></button>
      {state.loading && <span className="browser-progress" aria-hidden="true" />}
    </div>
    {state.failure && <p className="browser-failure" role="alert">{state.failure}</p>}
    <div ref={host} className="browser-host">
      {menu === "more" && <div className="browser-popover browser-popover--menu model-panel" data-overlay>
        <button type="button" className="model-option" disabled={!state.url} onClick={() => { setMenu(""); void api.devtools(); }}>Инструменты разработчика</button>
        <button type="button" className="model-option" disabled={!state.url} onClick={() => { setMenu(""); void api.clearData(); }}>Очистить данные сайта</button>
      </div>}
      {menu === "errors" && <div className="browser-popover browser-popover--errors model-panel" data-overlay>
        <header><strong>Ошибки консоли</strong><button type="button" className="text-link" onClick={() => { void api.clearErrors(); setMenu(""); }}>Очистить</button></header>
        <ol>{errors.map((error, index) => <li key={index + "-" + error.at}>
          <code>{error.message}</code>
          {error.source && <span className="subtle">{error.source.replace(/^.*\//, "")}{error.line ? ":" + error.line : ""}</span>}
        </li>)}</ol>
        <button type="button" className="small-button" onClick={sendErrors}>Отправить агенту</button>
      </div>}
      {(!state.url || state.url.startsWith("about:")) && <div className="browser-empty">
        <Glyph name="globe" />
        <h2>Браузер</h2>
        <p>Откройте адрес или сайт из проекта.</p>
        {(quickLinks.length > 0 || projectIndex) && <div className="browser-quick">
          {quickLinks.slice(0, 4).map(link => <button type="button" key={link} className="browser-chip" onClick={() => navigate(link)}><Glyph name="globe" />{shortUrl(link)}</button>)}
          {projectIndex && <button type="button" className="browser-chip" onClick={() => navigate(projectIndex)}><Glyph name="file" />index.html</button>}
        </div>}
      </div>}
    </div>
  </div>;
}
