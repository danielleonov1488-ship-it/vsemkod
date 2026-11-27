import { useEffect, useRef, useState } from "react";
import type { CatalogState, ConnectionId, CustomProvider, Preferences, SubscriptionId } from "../shared/api";
import type { Model, Provider } from "../shared/catalog-schema";
import { nativeNames, personalProviders, type KeyId, type RemoteModel } from "../shared/providers";
import { customBaseUrl } from "../shared/model-tags";
import { providerPlan, type ProviderValue } from "../shared/provider-plan";
import { modelDisplayName } from "../shared/usage";
import { Icon } from "./icons";
import { WindowControls } from "./window-controls";

export type Connection =
  { name: string; model?: Model; community?: boolean } & (
    { id: KeyId; kind: "manual"; keyPageUrl?: string; keyPattern?: string; cloudflare?: boolean } |
    { id: KeyId; kind: "oauth" } |
    { id: SubscriptionId; kind: "subscription" }
  );

export function catalogConnection(provider: Provider, model?: Model): Connection {
  const common = { id: provider.id, name: provider.name, model, community: provider.trust === "community" };
  return provider.auth.type === "oauth_pkce" ? { ...common, kind: "oauth" } : {
    ...common, kind: "manual", cloudflare: provider.auth.type === "cloudflare", keyPageUrl: provider.keyPageUrl ?? provider.signupUrl, keyPattern: provider.keyPattern ?? undefined
  };
}

export function readableError(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : "Не удалось выполнить действие.";
}

export function ConnectDialog({ connection, clipboard, close, connected, guided = false }: {
  guided?: boolean; connection: Connection; clipboard: boolean; close: () => void; connected: (state: CatalogState) => void;
}) {
  const api = window.vsemkod;
  const dialog = useRef<HTMLDialogElement>(null);
  const [token] = useState(() => crypto.randomUUID());
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting" | "done">("idle");
  const [device, setDevice] = useState<{ code: string; url: string }>();
  const [key, setKey] = useState("");
  const [clipboardCandidate, setClipboardCandidate] = useState<string>();
  const [baseUrl, setBaseUrl] = useState("");
  const [accountId, setAccountId] = useState("");
  const [choices, setChoices] = useState<ModelChoice[]>();
  const [loadingModels, setLoadingModels] = useState(false);
  const [catchKey, setCatchKey] = useState(!guided && clipboard && connection.kind === "manual" && !!connection.keyPattern);
  const [clipboardStatus, setClipboardStatus] = useState("");
  const [error, setError] = useState("");
  const active = useRef(false);
  const connecting = useRef(false);
  const resultTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = phase === "starting" || phase === "waiting";
  const manual = connection.kind === "manual";
  const cloudflare = manual && connection.cloudflare;
  const copilot = connection.id === "github-copilot";
  const grok = connection.id === "xai";
  const plan = manual && personalProviders.some(provider => provider.id === connection.id && provider.kind === "plan");
  const custom = connection.id === "custom-api";
  const title = "Подключить " + (connection.model?.name ?? connection.name);
  useEffect(() => {
    active.current = true;
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal();
    if (guided && connection.kind === "manual" && !connection.cloudflare) void api.clipboardKey?.(connection.id)
      .then(value => { if (active.current) setClipboardCandidate(value); }).catch(() => {});
    const unsubscribe = api.onConnect(event => {
      if (event.id !== token) return;
      if (event.type === "waiting") {
        if (event.code && event.url) setDevice({ code: event.code, url: event.url });
        setPhase("waiting");
      }
      if (event.type === "clipboard") {
        setKey(event.key);
        setClipboardStatus("Нашли ключ");
        if (guided) { setClipboardCandidate(undefined); void connect(true, event.key); }
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

  async function connect(fromClipboard = false, providedKey = key) {
    if (connecting.current || !fromClipboard && phase !== "idle") return;
    connecting.current = true;
    setError("");
    setCatchKey(false);
    setPhase("starting");
    try {
      const state = await api.connect(token, connection.id, manual ? { key: providedKey.trim(), baseUrl: custom ? baseUrl.trim() : undefined, models: custom ? choices?.filter(item => item.checked) : undefined, accountId: cloudflare ? accountId.trim() : undefined } : undefined);
      if (!active.current) return;
      setKey("");
      setPhase("done");
      resultTimer.current = setTimeout(() => connected(state), 640);
    } catch (error) {
      if (!active.current) return;
      setPhase("idle");
      setDevice(undefined);
      setError(readableError(error));
    } finally { connecting.current = false; }
  }

  return <dialog ref={dialog} className="connect-dialog" aria-labelledby="connect-title" aria-describedby="connect-intro"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    <WindowControls floating />
    <button autoFocus className="composer-control attach dialog-close" type="button" title="Закрыть" aria-label="Закрыть" onClick={close}><Icon name="close" /></button>
    <span className="monogram" aria-hidden="true">{(connection.model?.name || connection.name)[0]}</span>
    <h1 id="connect-title">{title}</h1>
    <p className="connect-intro" id="connect-intro">
      {connection.model && <>Бесплатно через {connection.name}. </>}
      {manual ? custom ? "Укажите адрес API и ключ. Список моделей загрузится с вашего сервера."
        : cloudflare ? "Откройте дашборд Cloudflare → Workers AI → Use REST API и скопируйте Account ID и API-токен."
        : plan ? "Возьмите ключ кодинг-плана в личном кабинете " + connection.name + ". Обычный ключ с оплатой за токены сюда не подойдёт."
        : "Возьмите ключ API в личном кабинете провайдера."
        : copilot ? "Подтвердите вход кодом на GitHub, чтобы использовать свой план Copilot."
          : grok ? "Подтвердите вход кодом на x.ai, чтобы использовать свою подписку SuperGrok или X Premium."
          : "Откройте браузер и войдите."}
    </p>
    {connection.community && phase !== "done" && <p className="connect-warning" role="note">Новый сервис из сообщества: запросы видит его владелец. Не отправляйте через него пароли, ключи и личные данные.</p>}
    {phase === "done" ? <p className="connect-status" role="status"><Icon name="check" />Подключено</p> :
      <form className="provider-actions" onSubmit={event => { event.preventDefault(); void connect(); }}>
        {manual && <>
          {connection.keyPageUrl && <button className="google-button" type="button"
            onClick={() => { open(connection.keyPageUrl!); if (guided && connection.keyPattern) {
              setCatchKey(true);
              setClipboardStatus("Жду ключ… скопируйте его, и я подставлю сам");
            } }}>{guided ? "Открыть страницу ключа" : "Открыть страницу ключей"}</button>}
          {guided && clipboardCandidate && <button className="composer-control" type="button" disabled={pending} onClick={() => {
            const value = clipboardCandidate;
            setClipboardCandidate(undefined);
            setKey(value);
            void connect(true, value);
          }}>Использовать ключ из буфера</button>}
          {custom && <label className="manual-field">Базовый URL<input type="url" value={baseUrl} required maxLength={4096}
            placeholder="https://example.com/v1" onChange={event => { setBaseUrl(event.target.value); setChoices(undefined); }} disabled={pending} /></label>}
          {cloudflare && <label className="manual-field">Account ID<input value={accountId} required maxLength={32}
            pattern="[0-9a-fA-F]{32}" spellCheck={false} autoComplete="off" onChange={event => setAccountId(event.target.value)} disabled={pending} /></label>}
          <label className="manual-field">{cloudflare ? "API-токен" : "Вставь ключ"}<input type="password" value={key} required maxLength={4096}
            autoComplete="off" spellCheck={false} placeholder={cloudflare ? "API-токен" : "Ключ API"} onChange={event => {
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
          {manual || copilot || grok ? "Подключить" : connection.id === "openai" ? "Войти через ChatGPT" : "Продолжить в браузере"}
        </button>}
        {pending && <>
          <p className="connect-status" role="status"><span className="status-dot" />{manual ? "Проверяем ключ…" :
            phase === "starting" ? "Запускаем вход…" : "Ждём вход…"}</p>
          {device && <>
            <p className="device-instructions">{grok ? <>Подтвердите код <kbd>{device.code}</kbd> на странице x.ai.</>
              : <>Введите код <kbd>{device.code}</kbd> на github.com/login/device.</>}</p>
            <button className="google-button" type="button" onClick={() => open(device.url)}>{grok ? "Открыть x.ai" : "Открыть GitHub"}</button>
          </>}
          <button className="github-button" type="button" onClick={close}>Отмена</button>
        </>}
        {error && <p className="connect-feedback connect-error" role="alert">{error}</p>}
      </form>}
    <p className="privacy-note"><Icon name="lock" />{connection.kind === "subscription"
      ? "Данные входа хранит OpenCode на этом компьютере" : "Ключ хранится только на этом компьютере"}</p>
  </dialog>;
}

const subscriptions = ["openai", "github-copilot", "xai"] as const;
const subscriptionDetails: Record<SubscriptionId, string> = {
  openai: "Вход через ChatGPT", "github-copilot": "Код подтверждения на GitHub", xai: "SuperGrok или X Premium, вход через x.ai"
};
const planDetails: Partial<Record<string, string>> = {
  "zai-coding": "GLM по подписке", "kimi-code": "Kimi по подписке", "alibaba-coding": "Qwen, GLM и Kimi по подписке",
  "opencode-go": "GLM, Kimi, Qwen и DeepSeek по подписке", synthetic: "Открытые модели по подписке", "ollama-cloud": "Облачные модели Ollama"
};

/** Свои поставщики из состояния; для старой версии без customProviders показываем единственный custom-api. */
export function customProvidersOf(state?: CatalogState): CustomProvider[] {
  if (state?.customProviders) return state.customProviders;
  if (!state?.personal.includes("custom-api")) return [];
  return [{ id: "custom-api", name: "Свой OpenAI-совместимый", baseUrl: state.customProviderUrl ?? "",
    models: state.personalModels.filter(model => model.providerId === "custom-api").map(model => ({ ...model, id: model.upstreamId ?? model.id })) }];
}

export function ConnectionsPage({ state, close, connect, openWizard, onCatalog, onError }: {
  state?: CatalogState; close: () => void; connect: (value: Connection) => void; openWizard?: () => void;
  onCatalog: (state: CatalogState) => void; onError: (error: unknown) => void;
}) {
  const plans = personalProviders.filter(provider => provider.kind === "plan");
  const keys = personalProviders.filter(provider => provider.kind === "api" && provider.id !== "custom-api");
  return <main className="workspace">
    <header className="chat-header"><h1>Подписки и ключи</h1>
      <button className="composer-control" type="button" onClick={close}>Назад</button>
    </header>
    <div className="settings-panel connections-page">
      {openWizard && <button type="button" className="small-button" onClick={openWizard}>Подключить всё за пару минут</button>}
      <p className="settings-intro">Модели подписок и ключей появятся во вкладке «Мои» в меню моделей. Бесплатные модели никогда не переключаются на платные.</p>
      <section className="settings-group"><h2>Подписки</h2>
        <p className="settings-hint">Вход в аккаунт или ключ кодинг-плана. Эти сервисы официально разрешают сторонние агенты.</p>
        {subscriptions.map(id => <ConnectionRow key={id} name={nativeNames[id]} detail={subscriptionDetails[id]} active={state?.subscriptions.includes(id)}
          action={() => connect({ id, name: nativeNames[id], kind: "subscription" })} />)}
        {plans.map(provider => <ConnectionRow key={provider.id} name={provider.name} detail={planDetails[provider.id] ?? "Ключ кодинг-плана"}
          active={state?.personal.includes(provider.id)} action={() => connect({ ...provider, kind: "manual" })} />)}
      </section>
      <CustomProviders state={state} onCatalog={onCatalog} onError={onError} />
      <section className="settings-group"><h2>Ключи API</h2>
        <p className="settings-hint">Оплата за токены у самого провайдера.</p>
        {keys.map(provider => <ConnectionRow key={provider.id} name={provider.name} active={state?.personal.includes(provider.id)}
          detail={provider.id === "google-api" ? "Из России может понадобиться VPN" : undefined}
          action={() => connect({ ...provider, kind: "manual" })} />)}
      </section>
      {state && <FreeSources state={state} connect={connect} />}
    </div>
  </main>;
}

function ConnectionRow({ name, detail, active, action }: { name: string; detail?: string; active?: boolean; action: () => void }) {
  return <div className="settings-row provider-row">
    <span className="provider-copy"><span>{name}</span>{detail && <span className="subtle">{detail}</span>}</span>
    {active ? <span className="connection-label"><span className="status-dot" />Подключён</span> :
      <button className="composer-control connect-label" type="button" aria-label={"Подключить " + name} onClick={action}>Подключить</button>}
  </div>;
}

const modelWord = (count: number) => ({ one: "модель", few: "модели" } as Record<string, string>)[new Intl.PluralRules("ru").select(count)] ?? "моделей";

/** «Свои поставщики»: любой OpenAI-совместимый сервер. Список, «Изменить», «Удалить» и «Добавить поставщика». */
export function CustomProviders({ state, onCatalog, onError }: {
  state?: CatalogState; onCatalog: (state: CatalogState) => void; onError: (error: unknown) => void;
}) {
  const api = window.vsemkod;
  const [editing, setEditing] = useState<CustomProvider | "new">();
  const [confirm, setConfirm] = useState<string>();
  const [working, setWorking] = useState<string>();
  const providers = customProvidersOf(state);
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(undefined), 4000);
    return () => clearTimeout(timer);
  }, [confirm]);
  const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
  return <section className="settings-group"><h2>Свои поставщики</h2>
    <p className="settings-hint">Любой сервер с OpenAI-совместимым API: адрес, ключ и нужные модели.</p>
    {providers.map(provider => <div className="settings-row provider-row" key={provider.id}>
      <span className="provider-copy"><span>{provider.name}</span>
        <span className="subtle">{[host(provider.baseUrl), provider.models.length + " " + modelWord(provider.models.length)].filter(Boolean).join(" · ")}</span></span>
      <div className="settings-actions">
        <button className="composer-control" type="button" disabled={!!working || !api.saveCustomProvider} onClick={() => setEditing(provider)}>Изменить</button>
        <button className="composer-control danger-control" type="button" disabled={!!working}
          aria-label={confirm === provider.id ? "Точно удалить " + provider.name : "Удалить " + provider.name} onClick={() => {
            if (confirm !== provider.id) { setConfirm(provider.id); return; }
            setConfirm(undefined);
            setWorking(provider.id);
            void api.disconnect(provider.id).then(onCatalog).catch(onError).finally(() => setWorking(undefined));
          }}>{confirm === provider.id ? "Точно удалить?" : "Удалить"}</button>
      </div>
    </div>)}
    <button type="button" className="add-provider" disabled={!api.saveCustomProvider} onClick={() => setEditing("new")}><Icon name="plus" />Добавить поставщика</button>
    {editing && <CustomProviderDialog provider={editing === "new" ? undefined : editing} close={() => setEditing(undefined)}
      saved={next => { setEditing(undefined); onCatalog(next); }} />}
  </section>;
}

function CustomProviderDialog({ provider, close, saved }: {
  provider?: CustomProvider; close: () => void; saved: (state: CatalogState) => void;
}) {
  const api = window.vsemkod;
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef(true);
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [choices, setChoices] = useState<ModelChoice[]>(() => provider?.models.map(model => ({ ...model, checked: true })) ?? []);
  const [manual, setManual] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  useEffect(() => {
    active.current = true;
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal();
    return () => { active.current = false; restoreFocus?.focus(); };
  }, []);
  const url = customBaseUrl(baseUrl);
  const canLoad = !!url && (!!key.trim() || !!provider);
  const selected = choices.filter(item => item.checked);

  function load() {
    if (!api.customProviderModels) return;
    setLoading(true);
    setError("");
    setHint("");
    const input = key.trim() || !provider ? { baseUrl: url, key: key.trim() } : { id: provider.id };
    void api.customProviderModels(input).then(list => {
      if (!active.current) return;
      const known = new Map(choices.map(item => [item.id, item]));
      const many = list.length > 12;
      const next = list.map(item => known.get(item.id) ?? { ...item, checked: !many && !provider });
      setChoices([...next, ...choices.filter(item => !list.some(entry => entry.id === item.id))]);
      if (!list.length) { setHint("Сервер не вернул ни одной модели. Впишите id модели вручную."); setManualOpen(true); }
      else if (many && !provider) setHint("Отметьте модели, которые нужны в меню.");
    }).catch(failure => {
      if (!active.current) return;
      const message = readableError(failure);
      if (/вручную/i.test(message)) { setHint(message); setManualOpen(true); } else setError(message);
    }).finally(() => { if (active.current) setLoading(false); });
  }

  function addManual() {
    const id = manual.trim();
    if (!id) return;
    setChoices(items => items.some(item => item.id === id) ? items.map(item => item.id === id ? { ...item, checked: true } : item)
      : [...items, { id, name: id, checked: true }]);
    setManual("");
  }

  function save() {
    if (!api.saveCustomProvider || saving) return;
    setSaving(true);
    setError("");
    void api.saveCustomProvider({ id: provider?.id, name: name.trim(), baseUrl: url, key: key.trim() || undefined,
      models: selected.map(({ checked: _checked, ...model }) => model) })
      .then(state => { if (active.current) saved(state); })
      .catch(failure => { if (active.current) setError(readableError(failure)); })
      .finally(() => { if (active.current) setSaving(false); });
  }

  return <dialog ref={dialog} className="connect-dialog custom-provider-dialog" aria-labelledby="custom-title"
    onCancel={event => { event.preventDefault(); close(); }}>
    <WindowControls floating />
    <button className="composer-control attach dialog-close" type="button" title="Закрыть" aria-label="Закрыть" onClick={close}><Icon name="close" /></button>
    <h1 id="custom-title">{provider ? "Изменить «" + provider.name + "»" : "Добавить поставщика"}</h1>
    <p className="connect-intro">Любой сервер с OpenAI-совместимым API. Если поставщик дал две ссылки, нужна та, что для OpenAI: обычно она оканчивается на /v1. Ссылка для Anthropic не подойдёт.</p>
    <form className="provider-actions" onSubmit={event => { event.preventDefault(); save(); }}>
      <label className="manual-field">Название<input value={name} required maxLength={60} autoFocus={!provider}
        placeholder="Например, Qwen у партнёра" onChange={event => setName(event.target.value)} disabled={saving} /></label>
      <label className="manual-field">Базовый URL<input type="url" value={baseUrl} required maxLength={4096} spellCheck={false}
        placeholder="https://api.example.com/v1" onChange={event => setBaseUrl(event.target.value)}
        onBlur={() => setBaseUrl(value => customBaseUrl(value))} disabled={saving} /></label>
      <label className="manual-field">Ключ API<input type="password" value={key} required={!provider} maxLength={4096}
        autoComplete="off" spellCheck={false} placeholder={provider ? "Оставьте пустым, чтобы не менять" : "Ключ API"}
        onChange={event => setKey(event.target.value)} disabled={saving} /></label>
      <div className="custom-models">
        <span className="custom-models-title">Модели</span>
        <div className="custom-model-actions">
          <button className="composer-control" type="button" disabled={saving || loading || !canLoad || !api.customProviderModels} onClick={load}>
            {loading ? "Загружаем…" : choices.length ? "Обновить список с сервера" : "Загрузить с сервера"}</button>
          {!manualOpen && <button className="composer-control" type="button" disabled={saving} onClick={() => setManualOpen(true)}>Вписать вручную</button>}
        </div>
        {hint && <p className="settings-hint">{hint}</p>}
        {manualOpen && <div className="custom-manual">
          <input className="field-control" value={manual} maxLength={200} spellCheck={false} aria-label="id модели"
            placeholder="id модели, например qwen3.8-plus" onChange={event => setManual(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); addManual(); } }} disabled={saving} />
          <button className="composer-control" type="button" disabled={saving || !manual.trim()} onClick={addManual}>Добавить</button>
        </div>}
        {choices.length > 0 && <CustomModelList choices={choices} update={setChoices} />}
      </div>
      <button className="small-button connect-submit" type="submit"
        disabled={saving || !name.trim() || !url || (!provider && !key.trim()) || !selected.length || !api.saveCustomProvider}>
        {saving ? "Проверяем ключ…" : provider ? "Сохранить" : "Добавить"}</button>
      {error && <p className="connect-feedback connect-error" role="alert">{error}</p>}
    </form>
    <p className="privacy-note"><Icon name="lock" />Ключ хранится только на этом компьютере</p>
  </dialog>;
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

export function ModelSettings({ state, prefs, update, subscriptionsPage, connect, disconnect, onCatalog, onError, openWizard }: {
  state?: CatalogState; prefs?: Preferences;
  update: (patch: Partial<Preferences>) => void; subscriptionsPage: () => void; openWizard?: () => void;
  connect: (value: Connection) => void; disconnect: (id: ConnectionId) => Promise<void>;
  onCatalog: (state: CatalogState) => void; onError: (error: unknown) => void;
}) {
  const api = window.vsemkod;
  const [working, setWorking] = useState<ConnectionId>();
  const [refreshing, setRefreshing] = useState(false);
  const openRouter = state?.catalog.providers.find(provider => provider.id === "openrouter" && provider.auth.type === "oauth_pkce");
  const providers = [
    ...state?.catalog.providers.filter(provider => state.connected.includes(provider.id)).map(provider =>
      ({ id: provider.id, name: provider.name, public: provider.auth.type === "none" })) ?? [],
    ...personalProviders.filter(provider => provider.id !== "custom-api" && state?.personal.includes(provider.id)),
    ...subscriptions.filter(id => state?.subscriptions.includes(id)).map(id => ({ id, name: nativeNames[id] }))
  ];
  return <>
      <section className="settings-group"><h2>Провайдеры и подписки</h2>
        {openWizard && <button type="button" className="small-button" onClick={openWizard}>Подключить всё за пару минут</button>}
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
        <button className="composer-control subscription-link" type="button" onClick={subscriptionsPage}><Icon name="plus" />Подписки и ключи</button>
      </section>
      {api.saveCustomProvider ? <CustomProviders state={state} onCatalog={onCatalog} onError={onError} />
        : state?.personal.includes("custom-api") && <section className="settings-group"><h2>Свой OpenAI-совместимый</h2>
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

/** Строка источника: что он даёт и сколько. Общая для мастера и страницы «Подписки и ключи». */
export function ProviderValueRow({ value, connected, connect, index }: {
  value: ProviderValue; connected: boolean; connect: (connection: Connection) => void; index?: number;
}) {
  const { provider, models, limit } = value;
  const names = models.map(model => modelDisplayName(model.name));
  const vpn = /VPN/i.test(provider.freeLimits.note ?? "") || /VPN/i.test(provider.notes);
  return <li className="provider-value">
    {index !== undefined && <span className="provider-value-index" aria-hidden="true">{index}</span>}
    <span className="provider-value-copy">
      <strong>{provider.name}</strong>
      <span className="provider-value-models">{names.slice(0, 3).join(", ")}{names.length > 3 && " и ещё " + (names.length - 3)}</span>
      {(limit || vpn) && <span className="provider-value-meta">{[limit, vpn && "из России — с VPN"].filter(Boolean).join(" · ")}</span>}
    </span>
    {connected ? <span className="connection-label"><span className="status-dot" />Подключён</span> :
      <button type="button" className="composer-control connect-label" aria-label={"Подключить " + provider.name}
        onClick={() => connect(catalogConnection(provider))}>Подключить</button>}
  </li>;
}

/** Бесплатные источники: сначала те несколько, что открывают все сильные модели, остальные свёрнуты. */
function FreeSources({ state, connect }: { state: CatalogState; connect: (value: Connection) => void }) {
  const plan = providerPlan(state.catalog, state.benchmarks);
  if (!plan.recommended.length) return null;
  return <section className="settings-group"><h2>Бесплатные источники моделей</h2>
    <p className="settings-hint">Подключите эти {plan.recommended.length}: этого хватит для всех сильных бесплатных моделей. Остальные только добавляют лимиты.</p>
    <ol className="provider-values">{plan.recommended.map((value, position) => <ProviderValueRow key={value.provider.id} value={value} index={position + 1}
      connected={state.connected.includes(value.provider.id)} connect={connect} />)}</ol>
    {plan.others.length > 0 && <details className="provider-values-more">
      <summary>Ещё источники · дополнительные лимиты ({plan.others.length})<Icon name="chevron" className="chevron" /></summary>
      <ul className="provider-values">{plan.others.map(value => <ProviderValueRow key={value.provider.id} value={value}
        connected={state.connected.includes(value.provider.id)} connect={connect} />)}</ul>
    </details>}
  </section>;
}
