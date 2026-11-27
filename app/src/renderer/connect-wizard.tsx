import { useEffect, useRef } from "react";
import type { CatalogState } from "../shared/api";
import { availableStrong, providerPlan } from "../shared/provider-plan";
import { ProviderValueRow, type Connection } from "./connections";
import { Icon } from "./icons";
import { WindowControls } from "./window-controls";

export function ConnectWizard({ state, first, connect, close }: {
  state: CatalogState; first: boolean; connect: (connection: Connection) => void; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const plan = providerPlan(state.catalog, state.benchmarks);
  const progress = availableStrong(state.catalog, state.connected);
  const done = plan.recommended.filter(({ provider }) => state.connected.includes(provider.id)).length;
  return <dialog ref={dialog} className="connect-dialog connect-wizard" aria-labelledby="wizard-title"
    onCancel={event => { event.preventDefault(); close(); }}>
    <WindowControls floating />
    <button className="composer-control attach dialog-close" type="button" aria-label="Закрыть" onClick={close}><Icon name="close" /></button>
    <h1 id="wizard-title">Подключите {plan.recommended.length} источников</h1>
    <p className="connect-intro">Этого хватит, чтобы открыть все сильные бесплатные модели. Остальные источники только добавляют лимиты, их можно не трогать.</p>
    <ol className="provider-values">{plan.recommended.map((value, position) => <ProviderValueRow key={value.provider.id} value={value} index={position + 1}
      connected={state.connected.includes(value.provider.id)} connect={connect} />)}</ol>
    {plan.others.length > 0 && <details className="provider-values-more">
      <summary>Ещё источники · дополнительные лимиты ({plan.others.length})<Icon name="chevron" className="chevron" /></summary>
      <ul className="provider-values">{plan.others.map(value => <ProviderValueRow key={value.provider.id} value={value}
        connected={state.connected.includes(value.provider.id)} connect={connect} />)}</ul>
    </details>}
    <footer className="wizard-footer">
      <span className="subtle">Подключено {done} из {plan.recommended.length} · доступно {progress.ready} из {progress.total} сильных моделей</span>
      {first && <button type="button" className="composer-control" onClick={close}>Позже</button>}
      <button type="button" className="small-button" onClick={close}>Готово</button>
    </footer>
  </dialog>;
}
