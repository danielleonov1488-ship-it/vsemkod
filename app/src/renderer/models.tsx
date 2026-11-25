import { useEffect, useRef, useState } from "react";
import { activeOffers, rankedModels } from "../shared/catalog";
import type { CatalogState } from "../shared/api";
import type { Model, Offer, Provider } from "../shared/catalog-schema";
import { GoogleMark, Icon } from "./icons";

export type Connection = { model: Model; provider: Provider };
const endDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

export function modelOptions(state: CatalogState) {
  return rankedModels(state.catalog).filter(model => model.tier !== "basic").flatMap(model => {
    const offers = activeOffers(state.catalog, model.id).filter(({ offer }) => offer.supportsTools);
    const available = offers.filter(({ provider }) => state.connected.includes(provider.id));
    const locked = offers.filter(({ provider }) => !state.connected.includes(provider.id));
    return available.length || locked.length ? [{ model, available, locked }] : [];
  });
}

function ModelCopy({ model, offers }: { model: Model; offers: { offer: Offer }[] }) {
  const expirations = offers.flatMap(({ offer }) => offer.promo && offer.expiresAt ? [Date.parse(offer.expiresAt)] : []);
  return <span className="model-copy">
    <span className="model-name">{model.name}</span>
    <span className="model-description">{model.description}</span>
    {expirations.length > 0 && <span className="model-expiry">бесплатно до {endDate.format(Math.max(...expirations))}</span>}
  </span>;
}

export function AutoSwitch({ auto, onAuto }: { auto: boolean; onAuto: (auto: boolean) => void }) {
  return <label className="auto-model">
    <span className="model-copy">
      <span className="model-name">Автовыбор</span>
      <span className="model-description">Если модель недоступна, переключусь на лучшую из подключённых</span>
    </span>
    <input className="switch" type="checkbox" role="switch" aria-label="Автовыбор модели" checked={auto} onChange={event => onAuto(event.currentTarget.checked)} />
  </label>;
}

export function ModelPicker({ selected, options, auto, onSelect, onAuto, onConnect }: {
  selected?: string; options: ReturnType<typeof modelOptions>; auto: boolean;
  onSelect: (id: string) => void; onAuto: (auto: boolean) => void; onConnect: (connection: Connection) => void;
}) {
  const picker = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const [showGood, setShowGood] = useState(false);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (picker.current?.open && !picker.current.contains(event.target as Node)) picker.current.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && picker.current?.open) {
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
  }, []);

  const visible = options.filter(option => option.model.tier === "top" || showGood || option.model.id === selected);
  const connected = visible.filter(option => option.available.length);
  const locked = visible.filter(option => !option.available.length && option.locked.length);
  const name = options.find(option => option.model.id === selected)?.model.name ?? "Выбрать модель";

  return <details ref={picker} className="model-picker">
    <summary ref={summary} className="composer-control" aria-label={"Модель · " + name}>
      <span>{name}</span><Icon name="chevron" className="chevron" />
    </summary>
    <div className="model-panel" role="region" aria-label="Выбор модели">
      <section className="model-section">
        <h2>Подключены</h2>
        {connected.length === 0 && <p className="model-empty">Нет доступных моделей</p>}
        <ul className="model-list">{connected.map(({ model, available }) =>
          <li key={model.id}><button className="model-option" type="button" aria-pressed={model.id === selected} onClick={() => {
            onSelect(model.id);
            if (picker.current) picker.current.open = false;
            summary.current?.focus();
          }}>
            <ModelCopy model={model} offers={available} />
            {model.id === selected && <span className="model-check"><Icon name="check" /></span>}
          </button></li>
        )}</ul>
      </section>
      {locked.length > 0 && <section className="model-section">
        <h2><span className="free-label">Бесплатно</span> — подключить в один клик</h2>
        <ul className="model-list">{locked.map(({ model, locked: offers }) =>
          <li key={model.id}><button className="model-option" type="button" aria-label={"Подключить " + model.name}
            onClick={() => {
              if (picker.current) picker.current.open = false;
              onConnect({ model, provider: offers[0].provider });
            }}>
            <ModelCopy model={model} offers={offers} /><span className="connect-label">Подключить</span>
          </button></li>
        )}</ul>
      </section>}
      {options.some(option => option.model.tier === "good" && option.model.id !== selected) &&
        <button className="composer-control more-models" type="button" aria-expanded={showGood}
          onClick={() => setShowGood(value => !value)}>{showGood ? "Показать меньше" : "Показать ещё"}<Icon name="chevron" className="chevron" /></button>}
      <AutoSwitch auto={auto} onAuto={onAuto} />
    </div>
  </details>;
}

export function ConnectDialog({ connection: { model, provider }, close }: { connection: Connection; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState("");
  const oauth = provider.auth.type === "oauth_pkce";
  const methods = provider.loginMethods.map(method => method.toLowerCase());
  useEffect(() => { dialog.current?.showModal(); }, []);
  const preview = () => setStatus("Подключение через " + provider.name + " появится на этапе B.");

  return <dialog ref={dialog} className="connect-dialog" aria-labelledby="connect-title"
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    } }}>
    <button autoFocus className="composer-control attach dialog-close" type="button" title="Закрыть" aria-label="Закрыть" onClick={close}><Icon name="close" /></button>
    <span className="monogram" aria-hidden="true">{model.name[0]}</span>
    <h1 id="connect-title">Подключить {model.name}</h1>
    <p className="connect-intro">Бесплатно через {provider.name}. {oauth ? "Вход будет доступен в браузере." : "Понадобится ключ API из личного кабинета."}</p>
    <div className="provider-actions">
      {oauth ? <>
        {methods.includes("google") && <button className="google-button" type="button" onClick={preview}><GoogleMark />Продолжить с Google</button>}
        {methods.includes("github") && <button className="github-button" type="button" onClick={preview}>Войти через GitHub</button>}
        {!methods.includes("google") && !methods.includes("github") &&
          <button className="google-button" type="button" onClick={preview}>Продолжить в браузере</button>}
      </> : <>
        <button className="google-button" type="button" onClick={() => void window.vsemkod.openExternal(provider.keyPageUrl ?? provider.signupUrl).catch(preview)}>Открыть страницу ключей</button>
        <label className="manual-field">Вставь ключ<input type="password" disabled placeholder="Подключение появится на этапе B" /></label>
        <label className="manual-clipboard"><input className="switch" type="checkbox" role="switch" disabled />Поймать ключ из буфера обмена</label>
      </>}
    </div>
    {status && <p className="connect-intro" role="status">{status}</p>}
    <p className="privacy-note"><Icon name="lock" />Ключ хранится только на этом компьютере</p>
  </dialog>;
}
