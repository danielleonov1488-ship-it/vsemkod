import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
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
  send: (sessionId, text, modelId, files, options) => ipcRenderer.invoke("chat:send", sessionId, text, modelId, files, options),
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
  chatAction: (session, action) => ipcRenderer.invoke("chat:action", session, action),
  revert: (session, message) => ipcRenderer.invoke("chat:revert", session, message),
  revertFile: (session, file) => ipcRenderer.invoke("chat:revert-file", session, file),
  exportChats: session => ipcRenderer.invoke("chat:export", session),
  captureFiles: (directory, files) => ipcRenderer.invoke("projects:capture", directory, files),
  filePath: file => webUtils.getPathForFile(file),
  tools: directory => ipcRenderer.invoke("projects:tools", directory),
  findFiles: (directory, query) => ipcRenderer.invoke("projects:find", directory, query),
  listFiles: (directory, path) => ipcRenderer.invoke("projects:files", directory, path),
  readFile: (directory, path) => ipcRenderer.invoke("projects:read", directory, path),
  answerQuestion: (session, form, answer) => ipcRenderer.invoke("chat:question", session, form, answer),
  modelVariants: (directory, model) => ipcRenderer.invoke("models:variants", directory, model),
  readInstructions: () => ipcRenderer.invoke("agent:rules"),
  saveInstructions: text => ipcRenderer.invoke("agent:rules-save", text),
  mcpList: directory => ipcRenderer.invoke("mcp:list", directory),
  mcpChange: (directory, name, action, config) => ipcRenderer.invoke("mcp:change", directory, name, action, config),
  openFolder: folder => ipcRenderer.invoke("app:folder", folder),
  refreshCatalog: () => ipcRenderer.invoke("catalog:refresh"),
  copyText: text => ipcRenderer.invoke("app:copy", text),
  clearCatalog: () => ipcRenderer.invoke("catalog:clear"),
  customModels: input => ipcRenderer.invoke("models:custom", input),
  saveCustomModels: models => ipcRenderer.invoke("models:custom-save", models),
  openTerminal: (directory, id) => ipcRenderer.invoke("terminal:open", directory, id),
  terminalInput: (id, data) => ipcRenderer.invoke("terminal:input", id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke("terminal:resize", id, cols, rows),
  closeTerminal: id => ipcRenderer.invoke("terminal:close", id),
  onTerminal: listener => subscribe("terminal:event", listener),
  onChat: listener => subscribe("chat:event", listener),
  onCatalog: listener => subscribe("catalog:update", listener),
  onNotice: listener => subscribe("notice", listener),
  onUpdate: listener => subscribe("updates:ready", listener),
  onConnect: listener => subscribe("connect:event", listener)
};

contextBridge.exposeInMainWorld("vsemkod", api);
