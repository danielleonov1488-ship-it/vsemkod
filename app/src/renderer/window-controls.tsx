import { Icon } from "./icons";

const api = window.vsemkod;

/** Кнопки окна. Внутри модального диалога (floating) дублируются поверх затемнения,
 *  иначе showModal() делает заголовок окна неактивным и окно нельзя ни свернуть, ни закрыть. */
export function WindowControls({ floating = false }: { floating?: boolean }) {
  return <div className={floating ? "window-controls window-controls--floating" : "window-controls"}>
    <button className="window-control" type="button" aria-label="Свернуть" onClick={() => void api.windowAction("minimize")}><Icon name="minus" /></button>
    <button className="window-control" type="button" aria-label="Развернуть или восстановить" onClick={() => void api.windowAction("maximize")}><Icon name="maximize" /></button>
    <button className="window-control window-close" type="button" aria-label="Закрыть окно" onClick={() => void api.windowAction("close")}><Icon name="close" /></button>
  </div>;
}
