import { useEffect, useRef, useState } from "react";
import type { CatalogState, ConnectionId, Preferences, SubscriptionId } from "../shared/api";
import type { Model, Provider } from "../shared/catalog-schema";
import { nativeNames, personalProviders, type KeyId, type RemoteModel } from "../shared/providers";
import { Icon } from "./icons";

export type Connection =
  { name: string; model?: Model } & (
    { id: KeyId; kind: "manual"; keyPageUrl?: string; keyPattern?: string } |
    { id: KeyId; kind: "oauth" } |
    { id: SubscriptionId; kind: "subscription" }
  );

export function catalogConnection(provider: Provider, model?: Model): Connection {
  const common = { id: provider.id, name: provider.name, model };
  return provider.auth.type === "oauth_pkce" ? { ...common, kind: "oauth" } : {
    ...common, kind: "manual", keyPageUrl: provider.keyPageUrl ?? provider.signupUrl, keyPattern: provider.keyPattern ?? undefined
  };
}

export function readableError(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "Не удалось выполнить действие.";
}

export function ConnectDialog({ connection, clipboard, close, connected }: {
  connection: Connection; clipboard: boolean; close: () => void; connected: (state: CatalogState) => void;
}) {
  const api = window.vsemkod;
  const dialog = useRef<HTMLDialogElement>(null);
  const [token] = useState(() => crypto.randomUUID());
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting" | "done">("idle");
  const [device, setDevice] = useState<{ code: string; url: string }>();
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [choices, setChoices] = useState<ModelChoice[]>();
  const [loadingModels, setLoadingModels] = useState(false);
  const [catchKey, setCatchKey] = useState(clipboard && connection.kind === "manual" && !!connection.keyPattern);
  const [clipboardStatus, setClipboardStatus] = useState("");
  const [error, setError] = useState("");
  const active = useRef(false);
  const resultTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = phase === "starting" || phase === "waiting";
  const manual = connection.kind === "manual";
  const copilot = connection.id === "github-copilot";
  const custom = connection.id === "custom-api";
  const title = "Подключить " + (connection.model?.name ?? connection.name);
  useEffect(() => {
    active.current = true;
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal();
    const unsubscribe = api.onConnect(event => {
      if (event.id !== token) return;
      if (event.type === "waiting") {
        if (event.code && event.url) setDevice({ code: event.code, url: event.url });
        setPhase("waiting");
      }
      if (event.type === "clipboard") {
        setKey(event.key);
        setClipboardStatus("Нашли ключ");
        setCatchKey(false);
      }
      if (event.type === "clipboard-expired") {
        setClipboardStatus("Время поиска истекло. Вставьте ключ вручную.");
        setCatchKey(false);
      }
    });
    return () => {
      active.current = false;
      clearTimeout(resultTimer.current);
      unsubscribe();
      void api.cancelConnection(token).catch(() => {});
      restoreFocus?.focus();
    };
  }, [api, token]);
  useEffect(() => {
    if (connection.kind === "manual" && connection.keyPattern) {
      void api.watchClipboard(token, connection.id, catchKey).catch(error => { if (active.current) setError(readableError(error)); });
    }
  }, [api, token, connection, catchKey]);

  function open(url: string) {
    void api.openExternal(url).catch(() => setError("Не удалось открыть системный браузер."));
  }

  async function connect() {
    if (phase !== "idle") return;
    setError("");
    setCatchKey(false);
    setPhase("starting");
    try {
      const state = await api.connect(token, connection.id, manual ? { key: key.trim(), baseUrl: custom ? baseUrl.trim() : undefined, models: custom ? choices?.filter(item => item.checked) : undefined } : undefined);
      if (!active.current) return;
      setKey("");
      setPhase("done");
      resultTimer.current = setTimeout(() => connected(state), 640);
    } catch (error) {
      if (!active.current) return;
      setPhase("idle");
      setDevice(undefined);
      setError(readableError(error));
    }
  }

  return <dialog ref={dialog} className="connect-dialog" aria-labelledby="connect-title" aria-describedby="connect-intro"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    <button autoFocus className="composer-control attach dialog-close" type="button" title="Закрыть" aria-label="Закрыть" onClick={close}><Icon name="close" /></button>
    <span className="monogram" aria-hidden="true">{(connection.model?.name || connection.name)[0]}</span>
    <h1 id="connect-title">{title}</h1>
    <p className="connect-intro" id="connect-intro">
      {connection.model && <>Бесплатно через {connection.name}. </>}
      {manual ? custom ? "Укажите адрес API и ключ. Список моделей загрузится с вашего сервера."
        : "Возьмите ключ API в личном кабинете провайдера."
        : copilot ? "Подтвердите вход кодом на GitHub, чтобы использовать свой план Copilot."
          : "Откройте браузер и войдите."}
    </p>
    {phase === "done" ? <p className="connect-status" role="status"><Icon name="check" />Подключено</p> :
      <form className="provider-actions" onSubmit={event => { event.preventDefault(); void connect(); }}>
        {manual && <>
          {connection.keyPageUrl && <button className="google-button" type="button"
            onClick={() => open(connection.keyPageUrl!)}>Открыть страницу ключей</button>}
          {custom && <label className="manual-field">Базовый URL<input type="url" value={baseUrl} required maxLength={4096}
            placeholder="https://example.com/v1" onChange={event => { setBaseUrl(event.target.value); setChoices(undefined); }} disabled={pending} /></label>}
          <label className="manual-field">Вставь ключ<input type="password" value={key} required maxLength={4096}
            autoComplete="off" spellCheck={false} placeholder="Ключ API" onChange={event => {
              setKey(event.target.value);
              setChoices(undefined);
              setClipboardStatus("");
            }} disabled={pending} /></label>
          {custom && <div className="custom-models">
            <button className="composer-control" type="button" disabled={pending || loadingModels || !key.trim() || !baseUrl.trim()} onClick={() => {
              setLoadingModels(true);
              setError("");
              void api.customModels({ key: key.trim(), baseUrl: baseUrl.trim() }).then(list => {
                if (active.current) setChoices(list.map(item => ({ ...item, checked: true })));
              }).catch(error => setError(readableError(error))).finally(() => setLoadingModels(false));
            }}>{loadingModels ? "Загружаем…" : "Загрузить список моделей"}</button>
            {choices?.length ? <CustomModelList choices={choices} update={setChoices} /> : choices && <p className="subtle">Сервер не вернул доступных моделей.</p>}
          </div>}
          {connection.keyPattern && <label className="manual-clipboard">
            <input className="switch" type="checkbox" role="switch" checked={catchKey} disabled={pending}
              onChange={event => { setCatchKey(event.target.checked); setClipboardStatus(""); }} />
            Поймать ключ из буфера обмена
          </label>}
          {clipboardStatus && <p className="connect-feedback" role="status">{clipboardStatus}</p>}
        </>}
        {phase === "idle" && <button className={manual ? "small-button connect-submit" : "google-button"} type="submit" disabled={loadingModels || (choices !== undefined && !choices.some(item => item.checked))}>
          {manual || copilot ? "Подключить" : connection.id === "openai" ? "Войти через ChatGPT" : "Продолжить в браузере"}
        </button>}
        {pending && <>
          <p className="connect-status" role="status"><span className="status-dot" />{manual ? "Проверяем ключ…" :
            phase === "starting" ? "Запускаем вход…" : "Ждём вход…"}</p>
          {device && <>
            <p className="device-instructions">Введите код <kbd>{device.code}</kbd> на github.com/login/device.</p>
            <button className="google-button" type="button" onClick={() => open(device.url)}>Открыть GitHub</button>
          </>}
          <button className="github-button" type="button" onClick={close}>Отмена</button>
        </>}
        {error && <p className="connect-feedback connect-error" role="alert">{error}</p>}
      </form>}
    <p className="privacy-note"><Icon name="lock" />{connection.kind === "subscription"
      ? "Данные входа хранит OpenCode на этом компьютере" : "Ключ хранится только на этом компьютере"}</p>
  </dialog>;
}

const subscriptions = ["github-copilot", "openai"] as const;

export function ConnectionsPage({ state, close, connect }: {
  state?: CatalogState; close: () => void; connect: (value: Connection) => void;
}) {
  return <main className="workspace">
    <header className="chat-header"><h1>Свои подписки и ключи</h1>
      <button className="composer-control" type="button" onClick={close}>Назад</button>
    </header>
    <div className="settings-panel">
      <p className="settings-intro">Подключите свой аккаунт или ключ API. Модели появятся в меню «Мои подписки».</p>
      <section className="settings-group"><h2>Подписки</h2>
        {subscriptions.map(id => <ConnectionRow key={id} name={nativeNames[id]} active={state?.subscriptions.includes(id)}
          action={() => connect({ id, name: nativeNames[id], kind: "subscription" })} />)}
      </section>
      <section className="settings-group"><h2>Ключи API</h2>
        {personalProviders.map(provider => <ConnectionRow key={provider.id} name={provider.name} active={state?.personal.includes(provider.id)}
          action={() => connect({ ...provider, kind: "manual" })} />)}
      </section>
      {state?.catalog.providers.some(provider => provider.auth.type === "manual_key" || provider.auth.type === "oauth_pkce") &&
        <details className="settings-group catalog-providers"><summary>Бесплатные провайдеры<Icon name="chevron" className="chevron" /></summary>
          {state.catalog.providers.filter(provider => provider.auth.type === "manual_key" || provider.auth.type === "oauth_pkce")
            .map(provider => <ConnectionRow key={provider.id} name={provider.name} active={state.connected.includes(provider.id)}
              action={() => connect(catalogConnection(provider))} />)}
        </details>}
    </div>
  </main>;
}

function ConnectionRow({ name, active, action }: { name: string; active?: boolean; action: () => void }) {
  return <div className="settings-row provider-row">
    <span>{name}</span>
    {active ? <span className="connection-label"><span className="status-dot" />Подключён</span> :
      <button className="composer-control connect-label" type="button" aria-label={"Подключить " + name} onClick={action}>Подключить</button>}
  </div>;
}

type ModelChoice = RemoteModel & { checked: boolean };

function CustomModelList({ choices, update }: { choices: ModelChoice[]; update: (next: ModelChoice[]) => void }) {
  const change = (id: string, patch: Partial<ModelChoice>) => update(choices.map(item => item.id === id ? { ...item, ...patch } : item));
  return <div className="custom-model-list">
    <div className="custom-model-head"><span>Модель</span><span>Контекст</span><span>Макс. вывод</span></div>
    {choices.map(item => <div className="custom-model-row" key={item.id}>
      <label title={item.id}><input type="checkbox" checked={item.checked} onChange={event => change(item.id, { checked: event.target.checked })} />{item.name}</label>
      {(["context", "output"] as const).map(field => <input className="field-control" type="number" min={1} max={100_000_000} step={1}
        key={field} aria-label={(field === "context" ? "Контекст " : "Макс. вывод ") + item.name}
        disabled={!item.checked} placeholder={field === "context" ? "32768" : "8192"} value={item[field] ?? ""}
        onChange={event => change(item.id, { [field]: event.target.value ? Number(event.target.value) : undefined })} />)}
    </div>)}
  </div>;
}

function CustomProviderModels({ enabled, onCatalog, onError }: { enabled: string[]; onCatalog: (state: CatalogState) => void; onError: (error: unknown) => void }) {
  const [choices, setChoices] = useState<ModelChoice[]>();
  const [pending, setPending] = useState(false);
  const submit = (run: () => Promise<unknown>) => {
    setPending(true);
    void run().catch(onError).finally(() => setPending(false));
  };
  return <div className="custom-models">
    <button type="button" className="composer-control" disabled={pending} onClick={() => submit(async () => {
      const list = await window.vsemkod.customModels();
      setChoices(list.map(item => ({ ...item, checked: enabled.includes(item.id) })));
    })}>Загрузить список моделей</button>
    {choices?.length ? <>
      <CustomModelList choices={choices} update={setChoices} />
      <button type="button" className="small-button" disabled={pending || !choices.some(item => item.checked)} onClick={() => submit(async () => {
        onCatalog(await window.vsemkod.saveCustomModels(choices.filter(item => item.checked)));
        setChoices(undefined);
      })}>Сохранить модели</button>
    </> : choices && <p className="subtle">Сервер не вернул доступных моделей.</p>}
  </div>;
}

export function ModelSettings({ state, prefs, update, subscriptionsPage, connect, disconnect, onCatalog, onError }: {
  state?: CatalogState; prefs?: Preferences;
  update: (patch: Partial<Preferences>) => void; subscriptionsPage: () => void;
  connect: (value: Connection) => void; disconnect: (id: ConnectionId) => Promise<void>;
  onCatalog: (state: CatalogState) => void; onError: (error: unknown) => void;
}) {
  const [working, setWorking] = useState<ConnectionId>();
  const [refreshing, setRefreshing] = useState(false);
  const openRouter = state?.catalog.providers.find(provider => provider.id === "openrouter" && provider.auth.type === "oauth_pkce");
  const providers = [
    ...state?.catalog.providers.filter(provider => state.connected.includes(provider.id)).map(provider =>
      ({ id: provider.id, name: provider.name, public: provider.auth.type === "none" })) ?? [],
    ...personalProviders.filter(provider => state?.personal.includes(provider.id)),
    ...subscriptions.filter(id => state?.subscriptions.includes(id)).map(id => ({ id, name: nativeNames[id] }))
  ];
  return <>
      <section className="settings-group"><h2>Провайдеры и подписки</h2>
        {providers.length === 0 && <p className="settings-intro">Нет подключённых провайдеров.</p>}
        {providers.map(provider => <div className="settings-row provider-row" key={provider.id}>
          <span>{provider.name}</span>
          <div className="settings-actions">
            {"public" in provider && provider.public ? <span className="subtle">Доступен без ключа</span> : <>
              <span className="connection-label"><span className="status-dot" />Подключён</span>
              <button className="composer-control" type="button" disabled={working !== undefined}
                aria-label={"Отключить " + provider.name} onClick={() => {
                  setWorking(provider.id);
                  void disconnect(provider.id).finally(() => setWorking(undefined));
                }}>Отключить</button>
            </>}
          </div>
        </div>)}
        {openRouter && !state?.connected.includes(openRouter.id) && <ConnectionRow name={openRouter.name}
          action={() => connect(catalogConnection(openRouter))} />}
        <button className="composer-control subscription-link" type="button" onClick={subscriptionsPage}><Icon name="plus" />Свои подписки и ключи</button>
      </section>
      {state?.personal.includes("custom-api") && <section className="settings-group"><h2>Свой OpenAI-совместимый</h2>
        <CustomProviderModels enabled={state.personalModels.filter(model => model.providerId === "custom-api").map(model => model.upstreamId ?? model.id)}
          onCatalog={onCatalog} onError={onError} />
      </section>}
      <section className="settings-group"><h2>Поведение приложения</h2>
        <PreferenceSwitch title="Автовыбор модели" detail="Переключаться на другую бесплатную модель при сбое" value={prefs?.auto ?? true} toggle={auto => update({ auto })} />
        <PreferenceSwitch title="Ловить ключ из буфера" detail="Искать ключ только в открытом мастере подключения, до 5 минут" value={prefs?.clipboard ?? false} toggle={clipboard => update({ clipboard })} />
        <PreferenceSwitch title="Проверять обновления каталога" detail="Проверять новые раздачи каждые 30 минут" value={prefs?.catalogUpdates ?? true} toggle={catalogUpdates => update({ catalogUpdates })} />
        <button type="button" className="composer-control" disabled={refreshing} onClick={() => {
          setRefreshing(true);
          void window.vsemkod.refreshCatalog().then(onCatalog).catch(onError).finally(() => setRefreshing(false));
        }}>{refreshing ? "Обновляем…" : "Обновить каталог"}</button>
      </section>
  </>;
}

export function PreferenceSwitch({ title, detail, value, toggle }: {
  title: string; detail: string; value: boolean; toggle: (value: boolean) => void;
}) {
  return <label className="settings-row preference-row">
    <span>{title}<span className="subtle">{detail}</span></span>
    <input className="switch" type="checkbox" role="switch" aria-label={title} checked={value}
      onChange={event => toggle(event.currentTarget.checked)} />
  </label>;
}
