import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { activeOffers, rankedModels } from "../shared/catalog";
import { compareByBenchmark, type Benchmarks } from "../shared/benchmarks";
import type { CatalogState, ModelLatency, ModelSpeed } from "../shared/api";
import type { Model, Provider } from "../shared/catalog-schema";
import type { PersonalModel } from "../shared/providers";
import { modelDisplayName } from "../shared/usage";
import { catalogConnection, type Connection } from "./connections";
import { Icon } from "./icons";

const levels: Record<string, [string, string]> = {
  "": ["По умолчанию", "по умолчанию"], minimal: ["Минимум", "минимум"], low: ["Низкий", "низко"],
  medium: ["Средний", "средне"], high: ["Высокий", "высоко"], xhigh: ["Очень высокий", "очень высоко"], max: ["Максимум", "максимум"]
};
const byName = new Intl.Collator("ru", { sensitivity: "base" });
const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

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
    <span className="model-copy"><span className="model-name">Автовыбор модели</span></span>
    <input className="switch" type="checkbox" role="switch" aria-label="Автовыбор модели" checked={auto}
      onChange={event => onAuto(event.currentTarget.checked)} />
  </label>;
}

type Entry = {
  id: string; name: string; vendor: string; rank: number; model?: Model;
  providers: { id: string; name: string }[]; connect?: Provider; upstreamId?: string;
  sources?: { connected: Provider[]; locked: Provider[] };
};

export function ModelPicker({ selected, options, personal, zen, auto, latencies, speeds, benchmarks, openSignal,
  variant, variants, onVariant, onSelect, onAuto, onConnect, onSubscriptions }: {
  selected?: string; catalog?: CatalogState["catalog"]; options: ReturnType<typeof modelOptions>;
  personal: PersonalModel[]; zen: PersonalModel[]; auto: boolean; latencies?: ModelLatency[]; speeds?: ModelSpeed[];
  benchmarks?: Benchmarks; openSignal: number; variant: string; variants: string[];
  onVariant: (id: string) => void; onSelect: (id: string) => void; onAuto: (auto: boolean) => void;
  onConnect: (connection: Connection) => void; onSubscriptions: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const seenSignal = useRef(openSignal);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [more, setMore] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [height, setHeight] = useState(560);

  function close(focus = true) {
    setOpen(false);
    setQuery("");
    setMore(false);
    setReasoning(false);
    if (focus) trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setHeight(Math.max(0, Math.min(560, (trigger.current?.getBoundingClientRect().top ?? 576) - 16)));
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

  const entries: Entry[] = options.filter(item => item.available.length || item.locked.length).map(({ model, available, locked }) => ({
    id: model.id, name: modelDisplayName(model.name), vendor: model.vendor, rank: model.rank, model,
    providers: (available.length ? available : locked).map(({ provider }) => provider),
    sources: { connected: available.map(({ provider }) => provider), locked: locked.map(({ provider }) => provider) },
    connect: available.length ? undefined : locked[0]?.provider
  }));
  const own: Entry[] = [...personal, ...zen].map(model => ({
    id: model.id, name: modelDisplayName(model.name), vendor: model.upstreamId?.split("/")[0] ?? model.providerName,
    rank: Number.MAX_SAFE_INTEGER, providers: [{ id: model.providerId, name: model.providerName }], upstreamId: model.upstreamId
  }));
  const sort = (a: Entry, b: Entry) => compareByBenchmark(a, b, benchmarks) || byName.compare(a.name, b.name);
  const best = entries.filter(entry => !entry.connect && entry.model?.tier === "top").sort(sort).slice(0, 5);
  const locked = entries.filter(entry => entry.connect).sort(sort).slice(0, 3);
  const rest = [...entries.filter(entry => !entry.connect && !best.includes(entry)), ...own].sort(sort);
  const name = [...entries, ...own].find(entry => entry.id === selected)?.name ?? "Модель";
  const term = query.trim().toLocaleLowerCase("ru");
  const matches = (entry: Entry) => [entry.name, entry.id, entry.upstreamId, entry.vendor, ...entry.providers.map(provider => provider.name), ...entry.sources?.locked.map(provider => provider.name) ?? []]
    .some(value => value?.toLocaleLowerCase("ru").includes(term));
  const bestRows = best.filter(matches);
  const lockedRows = (term ? entries.filter(entry => entry.connect).sort(sort) : locked).filter(matches);
  const moreRows = rest.filter(matches);
  const first = bestRows[0] ?? lockedRows[0] ?? moreRows[0];
  const hasIndex = Object.values(benchmarks?.models ?? {}).some(entry => entry.index !== undefined);

  function select(entry: Entry) {
    close();
    if (entry.connect) onConnect(catalogConnection(entry.connect, entry.model));
    else onSelect(entry.id);
  }

  function row(entry: Entry) {
    const provider = entry.providers[0];
    const result = benchmarks?.models[entry.id];
    const speed = modelSpeed(entry.id, provider.id, speeds, benchmarks);
    const latency = latencies?.find(item => item.modelId === entry.id && item.providerId === provider.id)?.averageMs;
    const ttft = latency === undefined ? result?.ttft : latency / 1000;
    const detail = [
      result?.index === undefined ? "" : "Индекс " + number.format(result.index),
      speed ? (speed.estimated ? "~" : "") + Math.round(speed.value) + " ток/с" : "",
      provider.name + (entry.providers.length > 1 ? " +" + (entry.providers.length - 1) : ""),
      entry.sources ? entry.sources.connected.length + " из " + (entry.sources.connected.length + entry.sources.locked.length) + " источников" : ""
    ].filter(Boolean).join(" · ");
    const tip = [entry.model?.description, ttft === undefined ? "" : "~" + number.format(ttft) + " с до первого ответа"].filter(Boolean).join("\n");
    const uncensored = /uncensored|abliterated/i.test(entry.name + " " + (entry.upstreamId ?? entry.id));
    const sources = entry.sources;
    const next = sources?.locked[0];
    const sourceList = sources && new Intl.ListFormat("ru").format([
      ...sources.connected.map(provider => provider.name + " (подключён)"), ...sources.locked.map(provider => provider.name)
    ]);
    return <li key={entry.id} className="model-source-row"><button className="model-option" type="button"
      aria-label={entry.connect ? "Подключить " + entry.name : undefined}
      aria-pressed={entry.connect ? undefined : entry.id === selected} title={sources && next && !entry.connect ? undefined : tip || undefined} onClick={() => select(entry)}>
      <span className="model-copy">
        <span className="model-name picker-model-name">{entry.name}</span>
        <span className="model-description">{detail}</span>
      </span>
      {entry.model?.tier === "new" && <span className="picker-tag">новая</span>}
      {uncensored && <span className="picker-tag">без цензуры</span>}
      {entry.connect ? <span className="connect-label">Подключить</span> : entry.id === selected && <span className="model-check"><Icon name="check" /></span>}
    </button>
    {sources && next && !entry.connect && <div className="model-source-tip">
      {tip && <div className="subtle">{tip}</div>}
      <div>Эта модель есть у {sourceList}. Подключите ещё один источник — если {provider.name} откажет, модель продолжит работать без смены.</div>
      <button type="button" className="composer-control" onClick={() => { close(); onConnect(catalogConnection(next, entry.model)); }}>Подключить {next.name}</button>
    </div>}</li>;
  }

  return <div className="model-picker" ref={wrapper} onKeyDown={event => {
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button ref={trigger} type="button" className="composer-control model-trigger" aria-label={"Модель · " + name}
      aria-expanded={open} onClick={() => open ? close() : setOpen(true)}>
      <span>{name}</span><Icon name="chevron" className="chevron" />
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
          <input className="field-control" ref={search} type="search" placeholder="Найти модель" aria-label="Найти модель"
            value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
              if (event.key === "Enter" && first) { event.preventDefault(); select(first); }
            }} />
          {variants.length > 0 && <button className="model-option reasoning-option" type="button" onClick={() => setReasoning(true)}>
            Рассуждения: {levels[variant]?.[1] ?? variant}<Icon name="chevron" className="forward-chevron" />
          </button>}
        </div>
        <div className="picker-body">
          {bestRows.length > 0 && <section className="model-section">
            <h2>Лучшие бесплатные</h2><ul className="model-list">{bestRows.map(row)}</ul>
          </section>}
          {lockedRows.length > 0 && <section className="model-section">
            <h2>Подключить бесплатно</h2><ul className="model-list">{lockedRows.map(row)}</ul>
          </section>}
          {moreRows.length > 0 && <section className="model-section">
            <button className="model-option picker-more" type="button" aria-expanded={more || !!term}
              onClick={() => { if (!term) setMore(value => !value); }}>
              Ещё модели · {moreRows.length}<Icon name="chevron" className="chevron" />
            </button>
            {(more || !!term) && <ul className="model-list">{moreRows.map(row)}</ul>}
          </section>}
          {!first && <p className="model-empty">{term ? "Модели не найдены" : "Нет доступных моделей"}</p>}
        </div>
        <div className="picker-footer">
          <AutoSwitch auto={auto} onAuto={onAuto} />
          <div><button type="button" className="subtle picker-link" onClick={() => { close(); onSubscriptions(); }}>Свои подписки и ключи</button>
            {hasIndex && <a href="https://artificialanalysis.ai/" className="subtle" onClick={event => {
              event.preventDefault();
              void window.vsemkod.openExternal(event.currentTarget.href);
            }}>Оценки: Artificial Analysis</a>}</div>
        </div>
      </>}
    </div>}
  </div>;
}
