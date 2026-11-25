import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CatalogState, ChatEvent, ChatPart, ConnectionId, Conversation, DesktopApi, FileChange, InitialState, Notice, Permission, Preferences, UpdateReady } from "../shared/api";
import { Chat } from "./chat";
import { catalogConnection, ConnectDialog, ConnectionsPage, readableError, SettingsPage, type Connection } from "./connections";
import { Icon } from "./icons";
import { ModelPicker, modelOptions } from "./models";
import logo from "./assets/logo.svg";

declare global {
  interface Window { vsemkod: DesktopApi }
}

const api = window.vsemkod;
const suggestions = ["Создать лендинг", "Найти баг", "Объяснить код", "Написать тесты"];
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

function catalogAge(date?: string) {
  if (!date) return "Загружаем каталог моделей";
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60_000));
  if (minutes < 1) return "Каталог моделей обновлён только что";
  if (minutes < 60) return "Каталог моделей обновлён " + minutes + " мин назад";
  if (minutes < 24 * 60) return "Каталог моделей обновлён " + Math.floor(minutes / 60) + " ч назад";
  return "Каталог моделей обновлён " + new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(Date.parse(date));
}

function replacePart(parts: ChatPart[], part: ChatPart) {
  const index = parts.findIndex(item => item.id === part.id);
  if (index < 0) return [...parts, part];
  return parts.map((item, position) => position === index ? part : item);
}

function App() {
  const [initial, setInitial] = useState<InitialState>();
  const [catalog, setCatalog] = useState<CatalogState>();
  const [prefs, setPrefs] = useState<Preferences>();
  const [directory, setDirectory] = useState("");
  const [sessions, setSessions] = useState<Conversation[]>([]);
  const [chat, setChat] = useState<Conversation>();
  const [settings, setSettings] = useState(false);
  const [subscriptions, setSubscriptions] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [parts, setParts] = useState<ChatPart[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [model, setModel] = useState<string>();
  const [routeProvider, setRouteProvider] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [updateReady, setUpdateReady] = useState<UpdateReady>();
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [connection, setConnection] = useState<Connection>();
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const activeChat = useRef<string | undefined>(undefined);
  const requestPending = useRef(false);
  const preferenceRevision = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const liveCatalog = useRef(catalog);
  const lastRoute = useRef<string | undefined>(undefined);
  liveCatalog.current = catalog;

  const notify = useCallback((next: Notice) => {
    setNotice(next);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(undefined), next.connect ? 12_000 : 6500);
  }, []);
  const showError = useCallback((error: unknown) => notify({ text: readableError(error), tone: "error" }), [notify]);

  useEffect(() => {
    let mounted = true;
    let live = false;
    let liveUpdate = false;
    const stopCatalog = api.onCatalog(state => { live = true; setCatalog(state); });
    const stopNotice = api.onNotice(notify);
    const stopUpdate = api.onUpdate(update => { liveUpdate = true; setUpdateReady(update); });
    void api.initial().then(info => {
      if (!mounted) return;
      setInitial(info);
      if (!live) setCatalog(info);
      if (!liveUpdate) setUpdateReady(info.update);
      setPrefs(info.preferences);
      setDirectory(info.preferences.directory);
    }).catch(showError);
    return () => { mounted = false; stopCatalog(); stopNotice(); stopUpdate(); clearTimeout(noticeTimer.current); };
  }, [notify, showError]);

  useEffect(() => api.onChat((event: ChatEvent) => {
    if (event.sessionId !== activeChat.current) return;
    if (event.type === "part") setParts(value => replacePart(value, event.part));
    if (event.type === "delta") setParts(value => {
      const part = value.find(part => part.id === event.partId);
      return replacePart(value, { id: event.partId, kind: "text", text: (part?.kind === "text" ? part.text : "") + event.delta });
    });
    if (event.type === "permission") setPermissions(value => [...value.filter(item => item.id !== event.permission.id), event.permission]);
    if (event.type === "permission-resolved") setPermissions(value => value.filter(item => item.id !== event.id));
    if (event.type === "route") {
      setRouteProvider(event.providerId);
      if (event.previousModelId && lastRoute.current !== event.modelId) {
        const names = liveCatalog.current?.catalog.models;
        const next = names?.find(model => model.id === event.modelId)?.name ?? event.modelId;
        const previous = names?.find(model => model.id === event.previousModelId)?.name ?? event.previousModelId;
        notify({ text: "Переключился на " + next + (event.reason === "quota"
          ? " — у модели " + previous + " кончилась квота" : " — модель " + previous + " временно недоступна") });
      }
      lastRoute.current = event.modelId;
    }
  }), [notify]);

  useEffect(() => {
    if (!directory) return;
    let current = true;
    setSessions([]);
    void api.sessions(directory).then(list => {
      if (current) setSessions(previous => [...new Map([...list, ...previous].map(item => [item.id, item])).values()]
        .sort((a, b) => b.updatedAt - a.updatedAt));
    }).catch(error => { if (current) showError(error); });
    return () => { current = false; };
  }, [directory, showError]);

  const options = catalog ? modelOptions(catalog) : [];
  const personal = catalog?.personalModels ?? [];
  const zen = catalog?.zenModels ?? [];
  const ownModels = [...personal, ...zen];
  const available = options.filter(item => item.available.length);
  const ownModel = ownModels.find(item => item.id === model);
  const selected = available.find(item => item.model.id === model) ?? available.find(item => item.model.tier !== "new");
  const modelId = ownModel?.id ?? selected?.model.id;
  const provider = routeProvider
    ? catalog?.catalog.providers.find(provider => provider.id === routeProvider)
    : selected?.available[0]?.provider;

  function resetChat() {
    activeChat.current = undefined;
    setChat(undefined);
    setSettings(false);
    setSubscriptions(false);
    setParts([]);
    setChanges([]);
    setPermissions([]);
    setFiles([]);
    setDraft("");
    setRouteProvider(undefined);
  }

  async function chooseDirectory(asDefault = false) {
    try {
      const chosen = await api.chooseDirectory();
      if (!chosen) return;
      if (asDefault) {
        setPrefs(await api.preferences({ directory: chosen }));
        if (!chat) {
          setDirectory(chosen);
          setFiles([]);
        }
      } else {
        if (chat) resetChat();
        else setFiles([]);
        setDirectory(chosen);
      }
    } catch (error) { showError(error); }
  }

  async function chooseFiles() {
    try {
      const added = await api.chooseFiles(directory);
      setFiles(current => [...new Set([...current, ...added])].slice(0, 10));
    } catch (error) { showError(error); }
  }

  async function checkUpdates() {
    setCheckingUpdates(true);
    try {
      const result = await api.checkUpdates();
      if (typeof result === "object") {
        setNotice(undefined);
        setUpdateReady(result);
      } else {
        const messages = {
          disabled: "Проверка обновлений доступна в установленном приложении.",
          current: "У вас последняя версия.",
          downloading: "Обновление загружается в фоне."
        };
        notify({ text: messages[result] });
      }
    } catch { notify({ text: "Не удалось проверить обновления.", tone: "error" }); }
    finally { setCheckingUpdates(false); }
  }

  async function openChat(session: Conversation) {
    if (busy || loadingChat) return;
    setLoadingChat(true);
    try {
      const history = await api.history(session.id);
      resetChat();
      activeChat.current = session.id;
      setChat(session);
      setModel(session.modelId);
      setParts(history.parts);
      setChanges(history.changes);
    } catch (error) { showError(error); }
    finally { setLoadingChat(false); }
  }

  async function send() {
    const message = draft.trim();
    if (!message || !modelId || !directory || requestPending.current) return;
    requestPending.current = true;
    setBusy(true);
    setDraft("");
    setFiles([]);
    lastRoute.current = undefined;
    let session = chat;
    try {
      if (!session) {
        const title = message.replace(/\s+/g, " ").split(/(?<=[.!?])\s/, 1)[0].slice(0, 72);
        session = await api.create(directory, title);
        activeChat.current = session.id;
        setChat(session);
      }
      const current = { ...session, modelId, updatedAt: Date.now() };
      setChat(current);
      setSessions(list => [current, ...list.filter(item => item.id !== current.id)]);
      setParts(list => [...list, { id: crypto.randomUUID(), kind: "user", text: message, files: files.map(folderName) }]);
      const result = await api.send(session.id, message, modelId, files);
      setChanges(result.changes);
      if (result.stopped) notify({ text: "Ответ остановлен" });
    } catch (error) {
      showError(error);
      if (!session) { setDraft(value => value || message); setFiles(files); }
      else {
        try {
          const history = await api.history(session.id);
          setChanges(history.changes);
          const sent = history.parts.some(part => part.kind === "user" && part.text === message);
          if (!sent) { setParts(history.parts); setDraft(value => value || message); setFiles(files); }
        } catch { /* Keep the visible conversation if the engine is offline. */ }
      }
    } finally {
      setPermissions([]);
      setBusy(false);
      requestPending.current = false;
    }
  }

  function updatePrefs(patch: Partial<Preferences>) {
    const revision = ++preferenceRevision.current;
    setPrefs(current => current && { ...current, ...patch });
    void api.preferences(patch).then(saved => {
      if (revision === preferenceRevision.current) setPrefs(saved);
    }).catch(error => {
      showError(error);
      void api.initial().then(info => {
        if (revision === preferenceRevision.current) setPrefs(info.preferences);
      }).catch(() => {});
    });
  }

  async function disconnect(id: ConnectionId) {
    try {
      setCatalog(await api.disconnect(id));
      setRouteProvider(undefined);
    } catch (error) { showError(error); }
  }

  function connectFromNotice() {
    if (!notice?.connect || !catalog) return;
    const { modelId, providerId } = notice.connect;
    const model = catalog.catalog.models.find(model => model.id === modelId);
    const provider = catalog.catalog.providers.find(provider => provider.id === providerId);
    if (model && provider) {
      if (catalog.connected.includes(provider.id)) {
        setModel(model.id);
        setRouteProvider(undefined);
      }
      else setConnection(catalogConnection(provider, model));
      setNotice(undefined);
    }
  }

  const composer = <form className={"composer" + (chat ? "" : " composer--home")} onSubmit={event => { event.preventDefault(); void send(); }}>
    <textarea ref={draftInput} className="composer-input" value={draft} rows={1} aria-label="Сообщение агенту" maxLength={100_000}
      placeholder={chat ? "Что сделать дальше?" : "Опиши задачу — агент сам напишет код"}
      onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
      }} />
    {files.length > 0 && <ul className="attachments" aria-label="Прикреплённые файлы">
      {files.map(file => <li key={file}><button type="button" className="composer-control folder-chip" title={"Убрать " + folderName(file)}
        onClick={() => setFiles(list => list.filter(item => item !== file))}><span>{folderName(file)}</span><Icon name="close" /></button></li>)}
    </ul>}
    <div className="composer-toolbar">
      <div className="composer-controls">
        <button className="composer-control attach" type="button" aria-label="Прикрепить файл" title="Прикрепить файл" disabled={!directory || busy}
          onClick={() => void chooseFiles()}><Icon name="plus" /></button>
        <button className="composer-control folder-chip" type="button" title={directory || "Выбрать папку проекта"}
          disabled={!prefs || busy} onClick={() => void chooseDirectory()}>
          <Icon name="folder" /><span>{directory ? folderName(directory) : "Папка проекта"}</span><Icon name="chevron" className="chevron" />
        </button>
      </div>
      <div className="composer-controls composer-controls--right">
        <ModelPicker selected={modelId} options={options} personal={personal} zen={zen} auto={prefs?.auto ?? true}
          onSelect={id => { setModel(id); setRouteProvider(undefined); }} onAuto={auto => updatePrefs({ auto })} onConnect={setConnection}
          onSubscriptions={() => setSubscriptions(true)} />
        {busy ? <button className="send" type="button" title="Стоп" aria-label="Стоп"
          disabled={!chat} onClick={() => { if (chat) void api.stop(chat.id).catch(showError); }}><Icon name="stop" /></button>
          : <button className="send" type="submit" title="Отправить" aria-label="Отправить" disabled={!modelId || !directory || loadingChat}><Icon name="send" /></button>}
      </div>
    </div>
  </form>;

  return <>
    <div className="app">
      <header className="titlebar" onDoubleClick={() => void api.windowAction("maximize")}>
        <span className="window-name"><img src={logo} width="14" height="14" alt="" />vsemkod</span>
        <div className="window-controls">
          <button className="window-control" type="button" aria-label="Свернуть" onClick={() => void api.windowAction("minimize")}><Icon name="minus" /></button>
          <button className="window-control" type="button" aria-label="Развернуть или восстановить" onClick={() => void api.windowAction("maximize")}><Icon name="maximize" /></button>
          <button className="window-control window-close" type="button" aria-label="Закрыть окно" onClick={() => void api.windowAction("close")}><Icon name="close" /></button>
        </div>
      </header>
      <aside className="sidebar" aria-label="Чаты и настройки">
        <button type="button" className="wordmark" disabled={busy || loadingChat} onClick={resetChat}>
          <img src={logo} width="18" height="18" alt="" /><span>vsem<span className="wordmark-suffix">kod</span></span>
        </button>
        <button className="sidebar-row sidebar-row--new" type="button" disabled={busy || loadingChat} onClick={resetChat}><Icon name="newChat" />Новый чат</button>
        <label className="sidebar-row search">
          <Icon name="search" /><input type="search" value={query} aria-label="Поиск чатов" placeholder="Поиск чатов" onChange={event => setQuery(event.target.value)} />
        </label>
        <nav className="recent" aria-label="Недавние чаты">
          <h2>Недавние</h2>
          <ul>{sessions.filter(item => item.title.toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru"))).map(item =>
            <li key={item.id}><button className="sidebar-row conversation" type="button" aria-current={!settings && !subscriptions && chat?.id === item.id ? "page" : undefined}
              title={item.title} disabled={busy || loadingChat} onClick={() => void openChat(item)}><span>{item.title}</span></button></li>)}</ul>
        </nav>
        <div className="sidebar-end">
          <button type="button" className="sidebar-row" aria-current={settings || subscriptions ? "page" : undefined} disabled={loadingChat}
            onClick={() => { setSettings(subscriptions || !settings); setSubscriptions(false); }}><Icon name="settings" />Настройки</button>
          <p className="catalog-note">{catalogAge(catalog?.catalog.generatedAt)}</p>
        </div>
      </aside>
      {subscriptions ? <ConnectionsPage state={catalog} close={() => setSubscriptions(false)} connect={setConnection} />
        : settings ? <SettingsPage state={catalog} prefs={prefs} version={initial?.version} choose={() => void chooseDirectory(true)}
          update={updatePrefs} subscriptionsPage={() => setSubscriptions(true)} connect={setConnection} disconnect={disconnect}
          checkUpdates={() => void checkUpdates()} checkingUpdates={checkingUpdates}
          open={url => void api.openExternal(url).catch(showError)} />
        : chat ? <Chat key={chat.id} title={chat.title} parts={parts} permissions={permissions} changes={changes} busy={busy}
        answer={(id, decision) => api.answer(chat.id, id, decision)}>
        {composer}{ownModel ? <p className="provider-note">{ownModel.providerId === "opencode" ? "Бесплатно · " : ""}{ownModel.providerName}</p>
          : provider && <p className="provider-note">Бесплатно · модель от {provider.name}</p>}
      </Chat> : <main className="workspace workspace--home">
        <div className="home">
          <h1>Чем займёмся?</h1>
          {composer}
          <div className="suggestions" aria-label="Подсказки">
            {suggestions.map(suggestion => <button type="button" className="suggestion" key={suggestion} onClick={() => {
              setDraft(suggestion);
              draftInput.current?.focus();
            }}>{suggestion}</button>)}
          </div>
        </div>
      </main>}
    </div>
    {connection && <ConnectDialog key={connection.id + "/" + (connection.model?.id ?? "")} connection={connection}
      clipboard={prefs?.clipboard ?? false} close={() => setConnection(undefined)} connected={state => {
        setCatalog(state);
        if (connection.model) setModel(connection.model.id);
        setRouteProvider(undefined);
        setConnection(undefined);
        notify({ text: "Подключено: " + connection.name });
      }} />}
    {(notice || updateReady) && <div className={"toast" + (notice?.tone === "error" ? " toast--error" : "")}
      role={notice?.tone === "error" ? "alert" : "status"}><span className="status-dot" />
      <span>{notice?.text ?? (updateReady?.action === "download" ? "Вышла новая версия" : "Доступна версия " + updateReady?.version)}</span>
      {notice?.connect && <button type="button" className="connect-label" onClick={connectFromNotice}>Подключить</button>}
      {!notice && updateReady && <button type="button" className="connect-label"
        onClick={() => void api.applyUpdate().catch(showError)}>{updateReady.action === "download" ? "Скачать" : "Перезапустить"}</button>}
      <button className="composer-control attach" type="button" aria-label="Закрыть уведомление" onClick={() => {
        if (notice) setNotice(undefined);
        else setUpdateReady(undefined);
      }}><Icon name="close" /></button>
    </div>}
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
