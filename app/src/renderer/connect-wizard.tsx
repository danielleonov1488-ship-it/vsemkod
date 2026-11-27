import { useEffect, useRef } from "react";
import { activeOffers, rankedModels, uncensoredModel, visibleFreeModel } from "../shared/catalog";
import { compareByBenchmark } from "../shared/benchmarks";
import type { CatalogState } from "../shared/api";
import { catalogConnection, type Connection } from "./connections";
import { Icon } from "./icons";
import { WindowControls } from "./window-controls";

export function ConnectWizard({ state, first, connect, close }: {
  state: CatalogState; first: boolean; connect: (connection: Connection) => void; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const models = rankedModels(state.catalog).filter(model => visibleFreeModel(state.catalog, model) && !uncensoredModel(state.catalog, model)).sort((a, b) => compareByBenchmark(a, b, state.benchmarks));
  const sources = state.catalog.providers
    .filter(provider => provider.auth.type === "manual_key" || provider.auth.type === "oauth_pkce")
    .map(provider => ({ provider, models: models.filter(model => activeOffers(state.catalog, model.id).some(entry => entry.provider === provider)) }))
    .sort((a, b) => Number(b.provider.id === "openrouter") - Number(a.provider.id === "openrouter") ||
      (a.models[0] ? models.indexOf(a.models[0]) : models.length) - (b.models[0] ? models.indexOf(b.models[0]) : models.length))
    .slice(0, 7);
  const connected = sources.filter(({ provider }) => state.connected.includes(provider.id)).length;
  const covered = models.filter(model => new Set(activeOffers(state.catalog, model.id)
    .filter(({ provider }) => state.connected.includes(provider.id)).map(({ provider }) => provider.id)).size >= 2).length;
  return <dialog ref={dialog} className="connect-dialog connect-wizard" aria-labelledby="wizard-title"
    onCancel={event => { event.preventDefault(); close(); }}>
    <WindowControls floating />
    <button className="composer-control attach dialog-close" type="button" aria-label="Закрыть" onClick={close}><Icon name="close" /></button>
    <h1 id="wizard-title">Подключить всё за пару минут</h1>
    <ul className="wizard-providers">{sources.map(({ provider, models }) => {
      const connected = state.connected.includes(provider.id);
      const google = provider.loginMethods.includes("google");
      return <li key={provider.id}>
        <span className="wizard-logo" aria-hidden="true">{provider.name.slice(0, 1)}</span>
        <span><strong>{provider.name}</strong>
          {models.length > 0 && <small className="subtle">даёт: {models.slice(0, 2).map(model => model.name).join(", ")}</small>}
          <small className="subtle">{provider.id === "runcrate" ? "GitHub без карты · Google с картой" :
            provider.id === "modelscope" ? "Верификация Alibaba Cloud" : [google && "вход через Google", "без карты"].filter(Boolean).join(" · ")}</small>
        </span>
        {connected ? <span className="connection-label">Подключён <Icon name="check" /></span> :
          <button type="button" className="composer-control" aria-label={"Подключить " + provider.name} onClick={() => connect(catalogConnection(provider))}>Подключить</button>}
      </li>;
    })}</ul>
    <footer className="wizard-footer">
      <span className="subtle">Подключено {connected} из {sources.length}</span>
      {first && <button type="button" className="composer-control" onClick={close}>Позже</button>}
      <button type="button" className="small-button" onClick={close}>Готово</button>
    </footer>
    <p className="subtle wizard-result">{covered > 0 ? "Моделей с несколькими источниками: " + covered + ". Если один из них откажет, модель попробует другой." :
      "Подключите несколько источников, чтобы модели могли переключаться между ними при сбое."}</p>
  </dialog>;
}
