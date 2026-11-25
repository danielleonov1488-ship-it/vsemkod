import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DesktopApi } from "../shared/api";

function subscribe<T>(channel: string, listener: (data: T) => void) {
  const receive = (_event: IpcRendererEvent, data: T) => listener(data);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}

const api: DesktopApi = {
  initial: () => ipcRenderer.invoke("app:initial"),
  sessions: directory => ipcRenderer.invoke("chat:list", directory),
  create: (directory, title) => ipcRenderer.invoke("chat:create", directory, title),
  history: sessionId => ipcRenderer.invoke("chat:history", sessionId),
  send: (sessionId, text, modelId, files) => ipcRenderer.invoke("chat:send", sessionId, text, modelId, files),
  stop: sessionId => ipcRenderer.invoke("chat:stop", sessionId),
  answer: (sessionId, id, decision) => ipcRenderer.invoke("chat:answer", sessionId, id, decision),
  chooseDirectory: () => ipcRenderer.invoke("projects:choose"),
  chooseFiles: directory => ipcRenderer.invoke("projects:attach", directory),
  preferences: patch => ipcRenderer.invoke("app:preferences", patch),
  connect: (id, provider, input) => ipcRenderer.invoke("connect:start", id, provider, input),
  cancelConnection: id => ipcRenderer.invoke("connect:cancel", id),
  watchClipboard: (id, provider, enabled) => ipcRenderer.invoke("connect:clipboard", id, provider, enabled),
  disconnect: id => ipcRenderer.invoke("connect:disconnect", id),
  checkUpdates: () => ipcRenderer.invoke("updates:check"),
  applyUpdate: () => ipcRenderer.invoke("updates:apply"),
  openExternal: url => ipcRenderer.invoke("app:external", url),
  windowAction: action => ipcRenderer.invoke("app:window", action),
  onChat: listener => subscribe("chat:event", listener),
  onCatalog: listener => subscribe("catalog:update", listener),
  onNotice: listener => subscribe("notice", listener),
  onUpdate: listener => subscribe("updates:ready", listener),
  onConnect: listener => subscribe("connect:event", listener)
};

contextBridge.exposeInMainWorld("vsemkod", api);
