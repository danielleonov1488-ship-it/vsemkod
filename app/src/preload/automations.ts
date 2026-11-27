import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/api";

export const automationMethods: Pick<DesktopApi, "schedules" | "saveSchedule" | "removeSchedule" | "runSchedule" |
  "hooks" | "saveHook" | "removeHook"> = {
  schedules: () => ipcRenderer.invoke("automations:schedules"),
  saveSchedule: input => ipcRenderer.invoke("automations:save-schedule", input),
  removeSchedule: id => ipcRenderer.invoke("automations:remove-schedule", id),
  runSchedule: id => ipcRenderer.invoke("automations:run-schedule", id),
  hooks: () => ipcRenderer.invoke("automations:hooks"),
  saveHook: input => ipcRenderer.invoke("automations:save-hook", input),
  removeHook: id => ipcRenderer.invoke("automations:remove-hook", id)
};

export function exposeAutomationChat() {
  contextBridge.exposeInMainWorld("vsemkodAutomationChat", {
    open: (scheduleId: string): Promise<void> => ipcRenderer.invoke("automations:open-chat", scheduleId)
  });
}
