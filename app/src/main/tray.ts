// Значок в области уведомлений Windows и Linux: окно закрывается в трей, агент и фоновые задачи продолжают работать.
import { Menu, Tray, nativeImage } from "electron";
import { join } from "node:path";
import type { UpdateProgress, UpdateReady } from "../shared/api";
import { trayStatus } from "./tray-status";

export type TrayState = { running: number; tasks: number; update?: UpdateReady; downloading?: UpdateProgress };
export type TrayActions = {
  open(): void; newChat(): void; stopTasks(): void; checkUpdates(): void; applyUpdate(): void; quit(): void;
};

export function createTray(resources: string, actions: TrayActions) {
  const tray = new Tray(nativeImage.createFromPath(join(resources, "tray", "tray.png")));
  let state: TrayState = { running: 0, tasks: 0 };
  const render = () => {
    const { update, downloading, tasks } = state;
    const updateItem: Electron.MenuItemConstructorOptions = update?.action === "restart"
      ? { label: "Перезапустить и обновить до " + update.version, click: actions.applyUpdate }
      : update?.action === "download" ? { label: "Скачать версию " + update.version, click: actions.applyUpdate }
      : downloading ? { label: "Загружаем обновление " + downloading.version + (downloading.percent ? " · " + Math.floor(downloading.percent) + "%" : "") + "…", enabled: false }
      : { label: "Проверить обновления", click: actions.checkUpdates };
    tray.setToolTip("vsemkod — " + trayStatus(state));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Открыть vsemkod", click: actions.open },
      { label: "Новый чат", click: actions.newChat },
      { type: "separator" },
      { label: trayStatus(state).replace(/^./, letter => letter.toUpperCase()), enabled: false },
      ...(tasks ? [{ label: "Остановить фоновые задачи", click: actions.stopTasks }] : []),
      { type: "separator" },
      updateItem,
      { type: "separator" },
      { label: "Выйти из vsemkod", click: actions.quit }
    ]));
  };
  // Windows: левый щелчок открывает окно, правый — меню. На Linux щелчок обычно открывает меню сам.
  tray.on("click", actions.open);
  tray.on("double-click", actions.open);
  render();
  return {
    update(next: Partial<TrayState>) {
      const merged = { ...state, ...next };
      if (JSON.stringify(merged) === JSON.stringify(state)) return;
      state = merged;
      render();
    },
    destroy() { tray.destroy(); }
  };
}
