import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CatalogState, ConnectionId, ReplySpeed, RequestQuota, RouterStats, Usage } from "../shared/api";
import { activeOffers, rankedModels } from "../shared/catalog";
import { nativeNames, personalProviders, type KeyId } from "../shared/providers";
import { catalogConnection, type Connection } from "./connections";
import { Icon } from "./icons";

const numbers = new Intl.NumberFormat("ru-RU");
const compact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });
const decimal = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const plural = new Intl.PluralRules("ru-RU");
const periods = { hour: "в час", day: "сегодня", minute: "в минуту" };
const usageUrls = {
  openai: "https://chatgpt.com/codex/settings/usage",
  "github-copilot": "https://github.com/settings/copilot",
  opencode: "https://opencode.ai/zen"
};

function Metric({ children, tip, kind, panel, expanded, toggle }: {
  children: ReactNode; tip?: string; kind: string; panel?: string; expanded?: boolean;
  toggle?: (button: HTMLButtonElement) => void;
}) {
  const tooltipId = useId();
  const [dismissed, setDismissed] = useState(false);
  const description = tip && !expanded ? tooltipId : undefined;
  return <div className={"metric-wrap metric-wrap--" + kind} data-dismissed={dismissed || undefined}
    onPointerLeave={() => setDismissed(false)} onBlur={() => setDismissed(false)}
    onKeyDown={event => { if (event.key === "Escape" && description) setDismissed(true); }}>
    {toggle ? <button className="status-metric" type="button" aria-expanded={expanded} aria-controls={panel}
      aria-describedby={description} onClick={event => toggle(event.currentTarget)}>{children}</button>
      : <span className="status-metric" tabIndex={tip ? 0 : undefined} aria-describedby={description}>{children}</span>}
    {description && <span className="metric-tooltip" id={tooltipId} role="tooltip">{tip}</span>}
  </div>;
}

export function Ring({ percent }: { percent: number }) {
  return <svg className="icon context-ring" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" />
    {percent > 0 && <circle cx="8" cy="8" r="6.5" pathLength="100" strokeDasharray={percent + " 100"} />}
  </svg>;
}

function width(percent: number) { return Math.min(100, Math.max(0, percent)) + "%"; }

function ContextPanel({ id, usage, used, capacity, percent, compactContext }: {
  id: string; usage: Usage; used: number; capacity: number; percent: number; compactContext?: () => void;
}) {
  const breakdown = usage.breakdown;
  const rows = breakdown ? [
    ["Системная подсказка", breakdown.system, "mint"], ["Инструменты", breakdown.tools, "amber"], ["Сообщения", breakdown.messages, "gray"]
  ] : [
    ["Вход", usage.input, "mint"], ["Выход", usage.output, "gray"], ["Рассуждения", usage.reasoning, "amber"],
    ["Кэш (чтение/запись)", numbers.format(usage.cache.read) + " / " + numbers.format(usage.cache.write), "outline"]
  ];
  return <section id={id} className="model-panel status-panel context-panel" aria-label="Контекст">
    <div className="status-panel-heading"><h2>Контекст · {percent}%</h2><span>{compact.format(used)} / {compact.format(capacity)}</span></div>
    <div className="status-meter" aria-hidden="true"><span data-tone="mint" style={{ width: width(capacity ? used / capacity * 100 : 0) }} /></div>
    <dl className="context-breakdown">{rows.map(([label, value, color]) => <div key={label}>
      <dt><span className="quota-dot" data-tone={color} />{label}</dt>
      <dd>{typeof value === "number" ? numbers.format(value) : value}</dd>
    </div>)}</dl>
    {compactContext && <div className="context-actions">
      <button className="small-button" type="button" onClick={compactContext}>Сжать контекст</button>
      <p>Движок сам сжимает контекст, когда окно почти заполнено</p>
    </div>}
  </section>;
}

type ProviderRow = { id: ConnectionId | "opencode"; name: string; badge?: string; url?: string; note?: string; disconnect?: ConnectionId; subscription?: boolean };

function providerRows(state: CatalogState): ProviderRow[] {
  return [
    ...state.catalog.providers.filter(provider => state.connected.includes(provider.id) || provider.auth.type === "none").map(provider => ({
      id: provider.id, name: provider.name, badge: provider.id === "kilo" ? "Kilo" : undefined,
      url: provider.keyPageUrl ?? provider.signupUrl, note: provider.freeLimits.note,
      disconnect: provider.auth.type === "none" || provider.id === "kilo" ? undefined : provider.id
    })),
    ...personalProviders.filter(provider => state.personal.includes(provider.id)).map(provider => ({
      id: provider.id, name: provider.name, url: provider.keyPageUrl ?? (provider.id === "custom-api" ? state.customProviderUrl : undefined),
      disconnect: provider.id
    })),
    ...state.subscriptions.map(id => ({
      id, name: nativeNames[id], badge: id === "openai" ? "ChatGPT" : undefined,
      url: usageUrls[id], disconnect: id, subscription: true
    })),
    ...(state.zenModels.length ? [{ id: "opencode" as const, name: nativeNames.opencode, url: usageUrls.opencode }] : [])
  ];
}

type DisplayQuota = RequestQuota & { unit?: "tokens" };

function displayQuota(info?: RouterStats[KeyId]): DisplayQuota | undefined {
  if (info?.requests) return info.requests;
  const tokens = info?.tokens;
  if (tokens?.limit && tokens.remaining !== undefined) {
    return { limit: tokens.limit, remaining: Math.min(tokens.remaining, tokens.limit), resetAt: tokens.resetAt, source: "headers", unit: "tokens" };
  }
}

function remainingText(quota?: DisplayQuota) {
  if (!quota) return "";
  return numbers.format(quota.remaining) + " из " + numbers.format(quota.limit) +
    (quota.period ? " " + periods[quota.period] : quota.unit === "tokens" ? " токенов" : " запросов");
}

function resetText(quota: RequestQuota | undefined, now: number) {
  if (quota?.resetAt === undefined || quota.resetAt <= now) return "";
  const minutes = Math.ceil((quota.resetAt - now) / 60_000);
  if (minutes < 60) return "через " + minutes + " мин";
  return "через " + Math.floor(minutes / 60) + " ч" + (minutes % 60 ? " " + minutes % 60 + " мин" : "");
}

function quotaFraction(quota?: RequestQuota) { return quota ? quota.remaining / quota.limit : undefined; }
function tone(fraction?: number) {
  if (fraction === undefined) return "gray";
  return fraction > 0.3 ? "mint" : fraction < 0.1 ? "red" : "amber";
}
function quotaTooltip(provider: ProviderRow | undefined, quota: DisplayQuota | undefined, now: number) {
  if (!provider) return "Лимиты появятся после выбора провайдера.";
  if (provider.subscription) return "Лимиты " + (provider.badge ?? provider.name) + " доступны в кабинете провайдера.";
  if (!quota) return "Провайдер не сообщил размер квоты. Подробности доступны в карточке.";
  const interval = quota.period === "day" ? "в сутки" : quota.period ? periods[quota.period] : "";
  const name = provider.badge ?? provider.name;
  const reset = resetText(quota, now);
  return (provider.note ? "Бесплатная квота " : "Квота ") + name + ": " + numbers.format(quota.limit) +
    (quota.unit === "tokens" ? " токенов" : " запросов") + (interval ? " " + interval : "") + (provider.id === "kilo" ? " с вашего IP" : "") + "." +
    (reset ? " Сброс " + reset + "." : "") + (quota.source === "local" ? " По нашим подсчётам." : "");
}

function suggestions(state: CatalogState) {
  const available = state.catalog.providers.filter(provider => !state.connected.includes(provider.id) &&
    (provider.auth.type === "manual_key" || provider.auth.type === "oauth_pkce"));
  const ranked = rankedModels(state.catalog).filter(model => model.tier === "top" || model.tier === "good")
    .flatMap(model => activeOffers(state.catalog, model.id).map(({ provider }) => provider))
    .filter(provider => available.includes(provider));
  // Сначала то, что подключается быстрее всего (OpenRouter — в один клик), затем по силе моделей.
  const order = [...new Set([...ranked, ...available])];
  return order.sort((a, b) => (a.clicksToConnect ?? 9) - (b.clicksToConnect ?? 9) || order.indexOf(a) - order.indexOf(b)).slice(0, 3);
}

function LimitsPanel({ id, state, providers, stats, now, onConnect, onDisconnect, onOpen, onSettings, onWizard }: {
  id: string; state?: CatalogState; providers: ProviderRow[]; stats?: RouterStats; now: number;
  onConnect: (connection: Connection) => void; onDisconnect: (id: ConnectionId) => Promise<void>;
  onOpen: (url: string) => void; onSettings: () => void; onWizard?: () => void;
}) {
  const [menu, setMenu] = useState<ProviderRow["id"]>();
  const [pending, setPending] = useState<ConnectionId>();
  const options = state ? suggestions(state) : [];
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const section = useRef<HTMLElement>(null);
  return <section ref={section} id={id} className="model-panel status-panel limits-panel" aria-label="Подписки и лимиты"
    onKeyDown={event => {
      if (event.key === "Escape" && menu) { event.preventDefault(); setMenu(undefined); menuButton.current?.focus(); }
    }}
    onClick={event => { if (!(event.target as Element).closest(".quota-row-actions")) setMenu(undefined); }}>
    <div className="status-panel-heading"><h2>Подписки и лимиты</h2></div>
    {providers.length === 0 && <p className="status-note">Подключений пока нет</p>}
    <ul className="quota-list">{providers.map(provider => {
      const info = stats?.[provider.id as KeyId];
      const quota = displayQuota(info);
      const credits = info?.credits;
      const fraction = quotaFraction(quota);
      const reset = resetText(quota, now);
      const creditLimit = credits?.limit;
      const creditText = credits ? "Кредиты ключа: " + decimal.format(credits.usage) +
        (typeof creditLimit === "number" ? " из " + decimal.format(creditLimit) : "") + " USD" +
        (credits.isFreeTier ? " · бесплатный тариф" : " · платный тариф") : "";
      const actionsId = id + "-" + provider.id;
      return <li className="quota-row" key={provider.id}>
        <Icon name={provider.subscription ? "subscription" : "provider"} />
        <div className="quota-copy">
          <strong>{provider.name}</strong>
          <p>{quota ? remainingText(quota) + (reset ? " · сброс " + reset : "") : provider.subscription ? "По тарифу" : "Лимит неизвестен"}</p>
          {fraction !== undefined && <div className="status-meter quota-meter" aria-hidden="true">
            <span data-tone={tone(fraction)} style={{ width: width(fraction * 100) }} />
          </div>}
          {quota?.source === "local" && <p className="status-note">По нашим подсчётам</p>}
          {provider.note && <p className="status-note">{provider.note}</p>}
          {creditText && <p className="status-note">{creditText}</p>}
        </div>
        {(provider.url || provider.disconnect) && <div className="quota-row-actions">
          <button type="button" className="composer-control quota-more" aria-label={"Действия · " + provider.name}
            aria-expanded={menu === provider.id} aria-controls={actionsId} onClick={event => {
              menuButton.current = event.currentTarget;
              setMenu(value => value === provider.id ? undefined : provider.id);
              if (menu !== provider.id) requestAnimationFrame(() => section.current?.querySelector<HTMLElement>("[id='" + actionsId + "']")?.scrollIntoView({ block: "nearest" }));
            }}><Icon name="more" /></button>
          {menu === provider.id && <div className="quota-actions" id={actionsId}>
            {provider.disconnect && <button className="model-option danger-action" type="button" disabled={pending !== undefined} onClick={async () => {
              if (!provider.disconnect) return;
              setPending(provider.disconnect);
              try { await onDisconnect(provider.disconnect); }
              finally { setPending(undefined); setMenu(undefined); section.current?.querySelector<HTMLElement>(".quota-settings")?.focus(); }
            }}>Отключить</button>}
            {provider.url && <button className="model-option" type="button" onClick={() => {
              onOpen(provider.url!); setMenu(undefined); menuButton.current?.focus();
            }}>Открыть кабинет провайдера</button>}
          </div>}
        </div>}
      </li>;
    })}</ul>
    {options.length > 0 && <section className="quota-suggestions">
      <h3>Можно подключить</h3>
      <ul className="quota-list">{options.map(provider => <li key={provider.id}>
        <Icon name="provider" /><span>{provider.name}{provider.clicksToConnect <= 1 && <small> · в один клик</small>}</span>
        <button className="quota-connect" type="button" aria-label={"Подключить " + provider.name}
          onClick={() => onConnect(catalogConnection(provider))}>Подключить</button>
      </li>)}</ul>
    </section>}
    {onWizard && <button type="button" className="small-button" onClick={onWizard}>Подключить всё за пару минут</button>}
    <button className="text-link quota-settings" type="button" onClick={onSettings}>Все подключения в настройках</button>
  </section>;
}

export function ComposerStatus({ state, providerId, usage, capacity, speed, typical, cache, stats, demo, demoRemaining,
  onCompact, onConnect, onDisconnect, onOpen, onSettings, contextSignal, routeSwitch, onWizard }: {
  state?: CatalogState; providerId?: string; usage?: Usage; capacity?: number; speed?: ReplySpeed; typical?: { value: number; estimated: boolean }; cache?: number;
  stats?: RouterStats; demo: boolean; demoRemaining?: number; contextSignal?: number; routeSwitch?: string; onWizard?: () => void;
  onCompact?: () => void; onConnect: (connection: Connection) => void; onDisconnect: (id: ConnectionId) => Promise<void>;
  onOpen: (url: string) => void; onSettings: () => void;
}) {
  const [open, setOpen] = useState<"context" | "limits">();
  const [now, setNow] = useState(Date.now);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const contextId = useId();
  const limitsId = useId();
  const providers = !demo && state ? providerRows(state) : [];
  const provider = providers.find(row => row.id === providerId);
  const quota = providerId ? displayQuota(stats?.[providerId as KeyId]) : undefined;
  const used = usage ? usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write : 0;
  const percent = usage && capacity ? Math.min(100, Math.round(used / capacity * 100)) : undefined;
  const tokensPerSecond = speed ? Math.round(speed.tokensPerSecond) : undefined;
  const speedText = tokensPerSecond === undefined ? undefined : numbers.format(tokensPerSecond);
  const tokenWord = tokensPerSecond === undefined ? "" : { one: "токен", few: "токена" }[plural.select(tokensPerSecond) as "one" | "few"] ?? "токенов";
  // 0% — это шум (провайдер без кэша или первый запрос), показываем только реальное попадание.
  const cacheText = cache === undefined || cache < 0.5 ? undefined : decimal.format(cache) + "%";
  const messages = demoRemaining === undefined ? "" : (plural.select(demoRemaining) === "one" ? "сообщение осталось"
    : plural.select(demoRemaining) === "few" ? "сообщения осталось" : "сообщений осталось");

  useEffect(() => { if (contextSignal) setOpen("context"); }, [contextSignal]);

  function close() {
    setOpen(undefined);
    trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(undefined); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close(); }
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  useEffect(() => {
    if (demo) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [demo]);

  function toggle(which: typeof open, button: HTMLButtonElement) {
    trigger.current = button;
    setNow(Date.now());
    setOpen(value => value === which ? undefined : which);
  }
  return <div className="composer-status" ref={root} aria-label="Статистика чата">
    {!speed && typical && <Metric kind="typical-speed" tip={"Обычно " + numbers.format(Math.round(typical.value)) + " ток/с у этой модели"}>
      <Icon name="bolt" /><span>{typical.estimated ? "~" : ""}{numbers.format(Math.round(typical.value))} ток/с</span>
    </Metric>}
    {speed && speedText !== undefined && <Metric kind="speed"
      tip={"Скорость ответа: " + speedText + " " + tokenWord + " в секунду. Первый токен пришёл через " + decimal.format(speed.firstTokenMs / 1000) + " с." +
         (speed.estimated ? " Провайдер не сообщил точное число токенов — оценка по тексту" : "")}>
      <Icon name="bolt" /><span>{speed.estimated ? "≈ " : ""}{speedText} ток/с</span>
    </Metric>}
    {!demo && cacheText !== undefined && <Metric kind="cache"
      tip={cacheText + " запроса взято из кэша провайдера — так быстрее и экономнее для квоты. Кэш держится, пока вы работаете с той же моделью."}>
      <Icon name="cache" /><span>Кэш {cacheText}</span>
    </Metric>}
    {usage && capacity && percent !== undefined && <>
      <Metric kind="context" expanded={open === "context"} panel={contextId}
        tip={percent + "% окна модели занято: " + compact.format(used) + " из " + compact.format(capacity) + " токенов. Нажмите для подробностей."}
        toggle={button => toggle("context", button)}>
        <Ring percent={percent} /><span><span className="sr-only">Контекст </span>{percent}%</span>
      </Metric>
    </>}
    {open === "context" && <ContextPanel id={contextId} usage={usage ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }}
      used={used} capacity={capacity ?? 0} percent={percent ?? 0} compactContext={onCompact && (() => { close(); onCompact(); })} />}
    {routeSwitch && <span className="subtle route-switch" role="status">{routeSwitch}</span>}
    {demo ? <Metric kind="limits"><span className="quota-dot" data-tone={demoRemaining === 0 ? "red" : "gray"} />
      <span>Демо{demoRemaining === undefined ? "" : " · " + demoRemaining + " " + messages}</span>
    </Metric> : <>
      <Metric kind="limits" expanded={open === "limits"} panel={limitsId}
        tip={quotaTooltip(provider, quota, now)} toggle={button => toggle("limits", button)}>
        <span className="quota-dot" data-tone={tone(quotaFraction(quota))} />
        <span>{provider ? (provider.badge ?? provider.name) + " · " : ""}{quota ? remainingText(quota) :
          provider?.subscription ? "по тарифу" : provider ? "лимит неизвестен" : "Лимиты"}</span>
      </Metric>
      {open === "limits" && <LimitsPanel id={limitsId} state={state} providers={providers} stats={stats} now={now}
        onConnect={connection => { close(); onConnect(connection); }} onDisconnect={onDisconnect}
        onOpen={onOpen} onWizard={onWizard && (() => { close(); onWizard(); })} onSettings={() => { close(); onSettings(); }} />}
    </>}
  </div>;
}
