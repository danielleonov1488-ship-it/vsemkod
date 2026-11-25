import { useEffect, useRef, useState } from "react";
import { activeOffers, rankedModels } from "../shared/catalog";
import type { CatalogState, ModelLatency } from "../shared/api";
import type { Catalog, Model, Offer } from "../shared/catalog-schema";
import type { PersonalModel } from "../shared/providers";
import { modelDisplayName } from "../shared/usage";
import type { Connection } from "./connections";
import { catalogConnection } from "./connections";
import { Icon } from "./icons";

const endDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const levels: Record<string, [string, string]> = {
  "": ["По умолчанию", "по умолчанию"], minimal: ["Минимум", "минимум"], low: ["Низкий", "низко"],
  medium: ["Средний", "средне"], high: ["Высокий", "высоко"], xhigh: ["Очень высокий", "очень высоко"], max: ["Максимум", "максимум"]
};

export function modelOptions(state: CatalogState) {
  return rankedModels(state.catalog).filter(model => model.tier !== "basic").flatMap(model => {
    const offers = activeOffers(state.catalog, model.id).filter(({ offer }) => offer.supportsTools);
    const available = offers.filter(({ provider }) => state.connected.includes(provider.id));
    const locked = offers.filter(({ provider }) => !state.connected.includes(provider.id));
    return available.length || locked.length || model.tier === "new" ? [{ model, available, locked }] : [];
  });
}

function ModelCopy({ model, offers }: { model: Model; offers: { offer: Offer }[] }) {
  const expirations = offers.flatMap(({ offer }) => offer.promo && offer.expiresAt ? [Date.parse(offer.expiresAt)] : []);
  return <span className="model-copy">
    <span className="model-name picker-model-name">{modelDisplayName(model.name)}</span>
    <span className="model-description">{model.description}</span>
    {expirations.length > 0 && <span className="model-expiry">бесплатно до {endDate.format(Math.max(...expirations))}</span>}
  </span>;
}

export function AutoSwitch({ auto, onAuto }: { auto: boolean; onAuto: (auto: boolean) => void }) {
  return <label className="auto-model">
    <span className="model-copy">
      <span className="model-name">Автовыбор модели</span>
      <span className="model-description">Если бесплатная модель недоступна, переключусь на другую бесплатную</span>
    </span>
    <input className="switch" type="checkbox" role="switch" aria-label="Автовыбор модели" checked={auto} onChange={event => onAuto(event.currentTarget.checked)} />
  </label>;
}

export function ModelPicker({ selected, catalog, options, personal, zen, auto, latencies, openSignal, variant, variants, onVariant, onSelect, onAuto, onConnect, onSubscriptions }: {
  selected?: string; openSignal?: number; latencies?: ModelLatency[]; options: ReturnType<typeof modelOptions>; auto: boolean;
  catalog?: Catalog;
  personal: PersonalModel[]; zen: PersonalModel[];
  variant: string; variants: string[]; onVariant: (variant: string) => void;
  onSelect: (id: string) => void; onAuto: (auto: boolean) => void; onConnect: (connection: Connection) => void;
  onSubscriptions: () => void;
}) {
  const picker = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const lastSignal = useRef(0);
  useEffect(() => {
    if (openSignal && openSignal !== lastSignal.current && picker.current) { picker.current.open = true; summary.current?.focus(); }
    lastSignal.current = openSignal ?? 0;
  }, [openSignal]);
  const [showGood, setShowGood] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const reasoningTrigger = useRef<HTMLButtonElement>(null);
  const reasoningBack = useRef<HTMLButtonElement>(null);
  const showReasoning = reasoning && variants.length > 0;
  useEffect(() => { if (showReasoning) reasoningBack.current?.focus(); }, [showReasoning]);
  function closeReasoning() {
    setReasoning(false);
    requestAnimationFrame(() => reasoningTrigger.current?.focus());
  }
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (picker.current?.open && !picker.current.contains(event.target as Node)) picker.current.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && picker.current?.open) {
        event.preventDefault();
        if (showReasoning) { closeReasoning(); return; }
        picker.current.open = false;
        summary.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showReasoning]);

  const visible = options.filter(option => option.model.id === selected ||
    (option.model.tier !== "new" && (option.model.tier === "top" || showGood)));
  const connected = visible.filter(option => option.available.length);
  const locked = visible.filter(option => !option.available.length && option.locked.length);
  const experimental = options.filter(option => option.model.tier === "new" && option.model.id !== selected);
  function personalName(model: PersonalModel) {
    const id = model.upstreamId ?? model.id;
    const match = catalog?.offers.find(offer => offer.providerId === model.providerId.replace(/-api$/, "") && offer.providerModelId === id);
    const catalogName = catalog?.models.find(item => item.id === (match?.modelId ?? id))?.name;
    return modelDisplayName(model.name, catalogName);
  }
  const ownModel = [...personal, ...zen].find(model => model.id === selected);
  const name = ownModel ? personalName(ownModel) : modelDisplayName(catalog?.models.find(model => model.id === selected)?.name ?? "Выбрать модель");
  function close() {
    if (picker.current) picker.current.open = false;
    summary.current?.focus();
  }
  function select(id: string) {
    onSelect(id);
    close();
  }
  function latency(id: string, providers: { id: string; name: string }[]) {
    const samples = providers.flatMap(provider => {
      const measurement = latencies?.find(value => value.modelId === id && value.providerId === provider.id);
      return measurement ? [{ ...measurement, name: provider.name }] : [];
    });
    const first = samples[0];
    if (!first) return null;
    const seconds = (ms: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: ms < 1000 ? 1 : 0 })
      .format(Math.max(0.1, ms / 1000)) + " с";
    return <small className="model-speed" title={samples.map(item => item.name + " · " + seconds(item.averageMs)).join("\n")}>
      ~{seconds(first.averageMs)}
    </small>;
  }
  function freeOption({ model, available, locked }: (typeof options)[number]) {
    const provider = locked[0]?.provider;
    return <li key={model.id}><button className="model-option" type="button"
      disabled={!available.length && !provider}
      aria-pressed={available.length ? model.id === selected : undefined}
      aria-label={provider && !available.length ? "Подключить " + modelDisplayName(model.name) : undefined}
      onClick={() => {
        if (available.length) select(model.id);
        else if (provider) { close(); onConnect(catalogConnection(provider, model)); }
      }}>
      <ModelCopy model={model} offers={available.length ? available : locked} />
      {!available.length ? <span className={provider ? "connect-label" : "subtle"}>{provider ? "Подключить" : "Нет раздачи"}</span> :
        <span className="model-details">{latency(model.id, available.map(item => item.provider))}
          {model.id === selected && <span className="model-check"><Icon name="check" /></span>}
        </span>}
    </button></li>;
  }
  function personalOptions(models: PersonalModel[]) {
    return <ul className="model-list">{models.map(model =>
      <li key={model.id}><button className="model-option" type="button" aria-pressed={model.id === selected} onClick={() => select(model.id)}>
        <span className="model-copy"><span className="model-name picker-model-name">{personalName(model)}</span><span className="model-description">{model.providerName}</span></span>
        <span className="model-details">{latency(model.id, [{ id: model.providerId, name: model.providerName }])}
          {model.id === selected && <span className="model-check"><Icon name="check" /></span>}
        </span>
      </button></li>)}</ul>;
  }

  return <details ref={picker} className="model-picker" onToggle={event => { if (!event.currentTarget.open) setReasoning(false); }}>
    <summary ref={summary} className="composer-control" aria-label={"Модель · " + name}>
      <span>{name}</span><Icon name="chevron" className="chevron" />
    </summary>
    <div className="model-panel" role="region" aria-label={showReasoning ? "Уровень рассуждений" : "Выбор модели"}>
      {showReasoning ? <>
        <button ref={reasoningBack} className="model-option reasoning-option" type="button" onClick={closeReasoning}>
          <Icon name="chevron" className="back-chevron" />Рассуждения
        </button>
        <ul className="model-list">{["", ...variants].map(id => <li key={id}>
          <button className="model-option reasoning-option" type="button" aria-pressed={id === variant}
            onClick={() => { onVariant(id); closeReasoning(); }}>
            {levels[id]?.[0] ?? id}{id === variant && <Icon name="check" />}
          </button>
        </li>)}</ul>
      </> : <>
      {variants.length > 0 && <button ref={reasoningTrigger} className="model-option reasoning-option reasoning-trigger" type="button"
        onClick={() => setReasoning(true)}>
        Рассуждения: {levels[variant]?.[1] ?? variant}<Icon name="chevron" className="forward-chevron" />
      </button>}
      <section className="model-section">
        <h2>Подключены</h2>
        {connected.length === 0 && <p className="model-empty">Нет доступных моделей</p>}
        <ul className="model-list">{connected.map(freeOption)}</ul>
      </section>
      {locked.length > 0 && <section className="model-section">
        <h2><span className="free-label">Бесплатно</span> — подключить в один клик</h2>
        <ul className="model-list">{locked.map(freeOption)}</ul>
      </section>}
      {options.some(option => option.model.tier === "good" && option.model.id !== selected) &&
        <button className="composer-control more-models" type="button" aria-expanded={showGood}
          onClick={() => setShowGood(value => !value)}>{showGood ? "Показать меньше" : "Показать ещё"}<Icon name="chevron" className="chevron" /></button>}
      {experimental.length > 0 && <details className="model-section experimental">
        <summary><span>Новые <span className="subtle">· экспериментальные</span></span><Icon name="chevron" className="chevron" /></summary>
        <ul className="model-list">{experimental.map(freeOption)}</ul>
      </details>}
      {zen.length > 0 && <section className="model-section"><h2>OpenCode Zen · бесплатно</h2>{personalOptions(zen)}</section>}
      <section className="model-section">
        <h2>Мои подписки</h2>
        {personalOptions(personal)}
        <button className="composer-control subscription-link" type="button" onClick={() => { close(); onSubscriptions(); }}>
          <Icon name="plus" />Свои подписки и ключи
        </button>
      </section>
      <AutoSwitch auto={auto} onAuto={onAuto} />
      </>}
    </div>
  </details>;
}
