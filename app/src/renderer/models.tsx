import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { activeOffers, rankedModels } from "../shared/catalog";
import { compareByBenchmark, type Benchmarks } from "../shared/benchmarks";
import type { CatalogState, ModelLatency, ModelSpeed } from "../shared/api";
import type { Model, Provider } from "../shared/catalog-schema";
import { isUncensored, personalKind } from "../shared/model-tags";
import type { PersonalKind, PersonalModel } from "../shared/providers";
import { modelDisplayName } from "../shared/usage";
import { catalogConnection, type Connection } from "./connections";
import { Icon } from "./icons";

const levels: Record<string, [string, string]> = {
  "": ["По умолчанию", "по умолчанию"], minimal: ["Минимум", "минимум"], low: ["Низкий", "низко"],
  medium: ["Средний", "средне"], high: ["Высокий", "высоко"], xhigh: ["Очень высокий", "очень высоко"], max: ["Максимум", "максимум"]
};
const byName = new Intl.Collator("ru", { sensitivity: "base" });
const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const plural = new Intl.PluralRules("ru");
const sourceWord = (count: number) => ({ one: "источник", few: "источника" } as Record<string, string>)[plural.select(count)] ?? "источников";

type Tab = "best" | "free" | "uncensored" | "own";
const tabs: { id: Tab; label: string }[] = [
  { id: "best", label: "Лучшие" }, { id: "free", label: "Бесплатные" }, { id: "uncensored", label: "Без цензуры" }, { id: "own", label: "Мои" }
];
const tabStorage = "vsemkod.modelTab";
const kindLabels: Record<PersonalKind, string> = {
  subscription: "подписка", plan: "кодинг-план", api: "ключ API, платно", custom: "свой поставщик", zen: "бесплатно"
};
const kindOrder: PersonalKind[] = ["subscription", "plan", "api", "custom"];

export function modelOptions(state: CatalogState) {
  return rankedModels(state.catalog).filter(model => model.tier !== "basic").flatMap(model => {
    const offers = activeOffers(state.catalog, model.id).filter(({ offer }) => offer.supportsTools);
    const available = offers.filter(({ provider }) => state.connected.includes(provider.id));
    const locked = offers.filter(({ provider }) => !state.connected.includes(provider.id));
    return available.length || locked.length || model.tier === "new" ? [{ model, available, locked }] : [];
  });
}

export function modelSpeed(modelId: string, providerId: string, speeds?: ModelSpeed[], benchmarks?: Benchmarks) {
  const measured = speeds?.find(item => item.modelId === modelId && item.providerId === providerId)?.tokensPerSecond;
  const value = measured ?? benchmarks?.models[modelId]?.speed;
  return value === undefined ? undefined : { value, estimated: measured === undefined };
}

export function AutoSwitch({ auto, onAuto }: { auto: boolean; onAuto: (auto: boolean) => void }) {
  return <label className="auto-model">
    <span className="model-copy"><span className="model-name">Автовыбор модели</span>
      <span className="model-description">Если модель недоступна, ответит другая бесплатная</span></span>
    <input className="switch" type="checkbox" role="switch" aria-label="Автовыбор модели" checked={auto}
      onChange={event => onAuto(event.currentTarget.checked)} />
  </label>;
}

type Entry = {
  id: string; name: string; vendor: string; rank: number; model?: Model;
  providers: { id: string; name: string }[]; connect?: Provider; upstreamId?: string;
  sources?: { connected: Provider[]; locked: Provider[] };
  uncensored: boolean; kind: PersonalKind | "free"; context?: number;
};

function storedTab(): Tab {
  try {
    const value = localStorage.getItem(tabStorage);
    return tabs.some(tab => tab.id === value) ? value as Tab : "best";
  } catch { return "best"; }
}

export function ModelPicker({ selected, catalog, options, personal, zen, auto, latencies, speeds, benchmarks, openSignal, routed,
  variant, variants, onVariant, onSelect, onAuto, onConnect, onSubscriptions }: {
  selected?: string; catalog?: CatalogState["catalog"]; options: ReturnType<typeof modelOptions>;
  personal: PersonalModel[]; zen: PersonalModel[]; auto: boolean; latencies?: ModelLatency[]; speeds?: ModelSpeed[];
  benchmarks?: Benchmarks; openSignal: number; variant: string; variants: string[];
  /** Модель, которая на самом деле ответила в этом чате (автовыбор мог переключить). */
  routed?: string;
  onVariant: (id: string) => void; onSelect: (id: string) => void; onAuto: (auto: boolean) => void;
  onConnect: (connection: Connection) => void; onSubscriptions: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const seenSignal = useRef(openSignal);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>(storedTab);
  const [reasoning, setReasoning] = useState(false);
  const [height, setHeight] = useState(600);

  function close(focus = true) {
    setOpen(false);
    setQuery("");
    setReasoning(false);
    if (focus) trigger.current?.focus();
  }

  function chooseTab(next: Tab) {
    setTab(next);
    setQuery("");
    body.current?.scrollTo({ top: 0 });
    try { localStorage.setItem(tabStorage, next); } catch { /* Без сохранения вкладки. */ }
  }

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setHeight(Math.max(0, Math.min(600, (trigger.current?.getBoundingClientRect().top ?? 616) - 16)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [open]);

  useEffect(() => {
    if (open) (reasoning ? back.current : search.current)?.focus();
  }, [open, reasoning]);

  useEffect(() => {
    if (seenSignal.current !== openSignal) { seenSignal.current = openSignal; setOpen(true); }
  }, [openSignal]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  const catalogProviders = catalog?.providers.map(provider => provider.id) ?? [];
  const free: Entry[] = options.filter(item => item.available.length || item.locked.length).map(({ model, available, locked }) => ({
    id: model.id, name: modelDisplayName(model.name), vendor: model.vendor, rank: model.rank, model,
    providers: (available.length ? available : locked).map(({ provider }) => provider),
    sources: { connected: available.map(({ provider }) => provider), locked: locked.map(({ provider }) => provider) },
    connect: available.length ? undefined : locked[0]?.provider,
    uncensored: isUncensored(model.name, model.id, ...[...available, ...locked].map(({ offer }) => offer.providerModelId)),
    kind: "free" as const
  }));
  const personalEntry = (model: PersonalModel): Entry => ({
    id: model.id, name: modelDisplayName(model.name), vendor: model.upstreamId?.split("/")[0] ?? model.providerName,
    rank: Number.MAX_SAFE_INTEGER, providers: [{ id: model.providerId, name: model.providerName }], upstreamId: model.upstreamId,
    uncensored: isUncensored(model.name, model.upstreamId, model.id), kind: personalKind(model, catalogProviders), context: model.context
  });
  const personalEntries = personal.map(personalEntry);
  const listed = personalEntries.filter(entry => entry.kind === "free");
  const own = personalEntries.filter(entry => entry.kind !== "free" && entry.kind !== "zen");
  const zenEntries = [...zen.map(personalEntry), ...personalEntries.filter(entry => entry.kind === "zen")];
  const sort = (a: Entry, b: Entry) => compareByBenchmark(a, b, benchmarks) || byName.compare(a.name, b.name);
  const connected = [...free.filter(entry => !entry.connect), ...listed].sort(sort);
  const lockable = free.filter(entry => entry.connect).sort(sort);
  const all = [...connected, ...zenEntries, ...lockable, ...own];

  const selectedEntry = all.find(entry => entry.id === selected);
  const selectedName = selectedEntry?.name ?? (selected && catalog?.models.find(model => model.id === selected)?.name) ?? "Модель";
  const routedName = auto && routed && routed !== selected
    ? all.find(entry => entry.id === routed)?.name ?? catalog?.models.find(model => model.id === routed)?.name : undefined;
  const label = modelDisplayName(routedName ?? selectedName);

  const term = query.trim().toLocaleLowerCase("ru");
  const matches = (entry: Entry) => [entry.name, entry.id, entry.upstreamId, entry.vendor, ...entry.providers.map(provider => provider.name), ...entry.sources?.locked.map(provider => provider.name) ?? []]
    .some(value => value?.toLocaleLowerCase("ru").includes(term));
  const hasIndex = Object.values(benchmarks?.models ?? {}).some(entry => entry.index !== undefined);
  const counts: Record<Tab, number> = {
    best: 0, free: connected.length + zenEntries.length,
    uncensored: connected.filter(entry => entry.uncensored).length, own: own.length
  };

  type Section = { key: string; title?: string; kind?: string; rows: Entry[]; note?: string };
  let sections: Section[];
  if (term) {
    sections = [
      { key: "free", title: "Бесплатные", rows: [...connected, ...zenEntries].filter(matches) },
      { key: "locked", title: "Подключить бесплатно", rows: lockable.filter(matches) },
      { key: "own", title: "Мои", rows: own.filter(matches) }
    ];
  } else if (tab === "best") {
    const top = connected.filter(entry => entry.model?.tier === "top");
    const best = (top.length >= 3 ? top : [...top, ...connected.filter(entry => entry.model?.tier === "good")]).slice(0, 6);
    sections = [
      { key: "best", title: "Лучшие бесплатные", rows: best },
      { key: "locked", title: "Подключить бесплатно", rows: lockable.filter(entry => entry.model?.tier === "top" || entry.model?.tier === "good").slice(0, 3) }
    ];
  } else if (tab === "free") {
    sections = [
      { key: "connected", title: "Подключены", rows: connected },
      { key: "zen", title: "OpenCode Zen", rows: zenEntries },
      { key: "locked", title: "Подключить бесплатно", rows: lockable }
    ];
  } else if (tab === "uncensored") {
    sections = [
      { key: "uncensored", rows: connected.filter(entry => entry.uncensored), note: "Версии моделей со снятыми отказами." },
      { key: "locked", title: "Подключить бесплатно", rows: lockable.filter(entry => entry.uncensored) }
    ];
  } else {
    const groups = new Map<string, Section>();
    for (const kind of kindOrder) for (const entry of own.filter(item => item.kind === kind)) {
      const provider = entry.providers[0];
      const key = kind + "/" + provider.id;
      if (!groups.has(key)) groups.set(key, { key, title: provider.name, kind: kindLabels[kind], rows: [] });
      groups.get(key)!.rows.push(entry);
    }
    sections = [...groups.values()].map(group => ({ ...group, rows: group.rows.sort((a, b) => byName.compare(a.name, b.name)) }));
  }
  sections = sections.filter(section => section.rows.length);
  const first = sections[0]?.rows[0];
  const numes = catalog?.providers.find(provider => provider.id === "numes" && provider.auth.type === "manual_key");

  function select(entry: Entry) {
    close();
    if (entry.connect) onConnect(catalogConnection(entry.connect, entry.model));
    else onSelect(entry.id);
  }

  function tabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const index = tabs.findIndex(item => item.id === tab);
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length];
    chooseTab(target.id);
    (event.currentTarget.parentElement?.querySelector(`[data-tab="${target.id}"]`) as HTMLElement | null)?.focus();
  }

  function row(entry: Entry, sectionKey: string) {
    const provider = entry.providers[0];
    const result = benchmarks?.models[entry.id];
    const speed = modelSpeed(entry.id, provider.id, speeds, benchmarks);
    const latency = latencies?.find(item => item.modelId === entry.id && item.providerId === provider.id)?.averageMs;
    const ttft = latency === undefined ? result?.ttft : latency / 1000;
    const sources = entry.sources;
    const ownRow = entry.kind !== "free" && entry.kind !== "zen";
    const detail = (ownRow ? [
      entry.upstreamId && entry.upstreamId !== entry.name ? entry.upstreamId : "",
      entry.context ? "контекст " + (entry.context >= 1000 ? Math.round(entry.context / 1000) + "K" : entry.context) : ""
    ] : [
      result?.index === undefined ? "" : "Индекс " + number.format(result.index),
      speed ? (speed.estimated ? "~" : "") + Math.round(speed.value) + " ток/с" : "",
      entry.connect ? entry.connect.name
        : sources ? sources.connected.length + " " + sourceWord(sources.connected.length) : provider.name
    ]).filter(Boolean).join(" · ");
    const tip = [entry.model?.description, ttft === undefined ? "" : "~" + number.format(ttft) + " с до первого ответа"].filter(Boolean).join("\n");
    const next = sources?.locked[0];
    const sourceList = sources && new Intl.ListFormat("ru").format([
      ...sources.connected.map(item => item.name + " (подключён)"), ...sources.locked.map(item => item.name)
    ]);
    return <li key={sectionKey + entry.id} className="model-source-row"><button className="model-option" type="button"
      aria-label={entry.connect ? "Подключить " + entry.name : undefined}
      aria-pressed={entry.connect ? undefined : entry.id === selected} title={sources && next && !entry.connect ? undefined : tip || undefined} onClick={() => select(entry)}>
      <span className="model-copy">
        <span className="model-name picker-model-name">{entry.name}</span>
        {detail && <span className="model-description">{detail}</span>}
      </span>
      {entry.model?.tier === "new" && entry.model.origin !== "discovered" && <span className="picker-tag">новая</span>}
      {entry.uncensored && tab !== "uncensored" && <span className="picker-tag">без цензуры</span>}
      {entry.id === routed && routed !== selected && auto && <span className="picker-tag picker-tag--live">отвечает</span>}
      {entry.connect ? <span className="connect-label">Подключить</span> : entry.id === selected && <span className="model-check"><Icon name="check" /></span>}
    </button>
    {sources && next && !entry.connect && <div className="model-source-tip">
      {tip && <div className="subtle">{tip}</div>}
      <div>Эта модель есть у {sourceList}. Подключите ещё один источник: если {provider.name} откажет, модель продолжит работать без смены.</div>
      <button type="button" className="composer-control" onClick={() => { close(); onConnect(catalogConnection(next, entry.model)); }}>Подключить {next.name}</button>
    </div>}</li>;
  }

  function empty() {
    if (term) return <p className="model-empty">Модели не найдены</p>;
    if (tab === "uncensored") {
      const suggest = numes && !options.some(item => item.available.some(({ provider }) => provider.id === numes.id)) ? numes : undefined;
      return <div className="picker-empty">
        <p>Подключённых моделей без цензуры пока нет.{suggest && <> Они бывают в бесплатном списке {suggest.name}.</>}</p>
        {suggest && <button type="button" className="composer-control connect-label" onClick={() => { close(); onConnect(catalogConnection(suggest)); }}>Подключить {suggest.name}</button>}
      </div>;
    }
    if (tab === "own") return <div className="picker-empty">
      <p>Здесь будут модели ваших подписок и ключей: ChatGPT, Copilot, SuperGrok, Kimi Code, GLM Coding Plan или любой OpenAI-совместимый сервер.</p>
    </div>;
    return <p className="model-empty">Нет доступных моделей</p>;
  }

  return <div className="model-picker" ref={wrapper} onKeyDown={event => {
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button ref={trigger} type="button" className="composer-control model-trigger" aria-label={"Модель · " + label}
      title={routedName ? "Выбрана " + modelDisplayName(selectedName) + ". Сейчас отвечает " + modelDisplayName(routedName) +
        ": выбранная была недоступна. Когда она освободится, автовыбор вернётся к ней." : undefined}
      aria-expanded={open} onClick={() => open ? close() : setOpen(true)}>
      {routedName && <span className="model-trigger-auto" aria-hidden="true">авто</span>}
      <span>{label}</span><Icon name="chevron" className="chevron" />
    </button>
    {open && <div className="model-panel stage-g-models" style={{ maxHeight: height }} role="region"
      aria-label={reasoning ? "Уровень рассуждений" : "Выбор модели"}>
      {reasoning ? <>
        <button ref={back} className="model-option reasoning-option" type="button" onClick={() => setReasoning(false)}>
          <Icon name="chevron" className="back-chevron" />Рассуждения
        </button>
        <ul className="model-list">{["", ...variants].map(id => <li key={id}>
          <button className="model-option reasoning-option" type="button" aria-pressed={id === variant}
            onClick={() => { onVariant(id); setReasoning(false); }}>
            {levels[id]?.[0] ?? id}{id === variant && <Icon name="check" />}
          </button></li>)}</ul>
      </> : <>
        <div className="picker-header">
          <div className="picker-search">
            <input className="field-control" ref={search} type="search" placeholder={"Найти среди " + all.length} aria-label="Найти модель"
              value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
                if (event.key === "Enter" && first) { event.preventDefault(); select(first); }
              }} />
            {variants.length > 0 && <button className="model-option reasoning-option" type="button" onClick={() => setReasoning(true)}>
              Рассуждения: {levels[variant]?.[1] ?? variant}<Icon name="chevron" className="forward-chevron" />
            </button>}
          </div>
          <div className="picker-tabs" role="tablist" aria-label="Группы моделей">
            {tabs.map(item => <button key={item.id} type="button" role="tab" data-tab={item.id}
              aria-selected={!term && item.id === tab} tabIndex={item.id === tab ? 0 : -1}
              onClick={() => chooseTab(item.id)} onKeyDown={tabKey}>
              {item.label}{counts[item.id] > 0 && <span className="picker-tab-count">{counts[item.id]}</span>}
            </button>)}
          </div>
        </div>
        <div className="picker-body" ref={body} role={term ? undefined : "tabpanel"}>
          {sections.map(section => <section className="model-section" key={section.key}>
            {section.title && <h2>{section.title}{section.kind && <span className="picker-kind">{section.kind}</span>}
              {(tab === "free" || term) && <span className="picker-section-count">{section.rows.length}</span>}</h2>}
            {section.note && <p className="picker-note">{section.note}</p>}
            <ul className="model-list">{section.rows.map(entry => row(entry, section.key))}</ul>
          </section>)}
          {!first && empty()}
          {tab === "own" && !term && <button type="button" className="model-option picker-add" onClick={() => { close(); onSubscriptions(); }}>
            <Icon name="plus" />Подключить подписку, ключ или своего поставщика
          </button>}
        </div>
        <div className="picker-footer">
          <AutoSwitch auto={auto} onAuto={onAuto} />
          <div><button type="button" className="subtle picker-link" onClick={() => { close(); onSubscriptions(); }}>Подписки и ключи</button>
            {hasIndex && <a href="https://artificialanalysis.ai/" className="subtle" onClick={event => {
              event.preventDefault();
              void window.vsemkod.openExternal(event.currentTarget.href);
            }}>Оценки: Artificial Analysis</a>}</div>
        </div>
      </>}
    </div>}
  </div>;
}
