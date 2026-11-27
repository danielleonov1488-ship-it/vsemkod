import { ipcRenderer } from "electron";
import type { DesktopApi, RemoteAccess } from "../shared/api";

export function remoteAccessApi(subscribe: (channel: string, listener: (state: RemoteAccess) => void) => () => void) {
  return {
    remoteAccess: () => ipcRenderer.invoke("remote:get"),
    setRemoteWeb: enabled => ipcRenderer.invoke("remote:web", enabled),
    setTelegramBot: (token, project) => ipcRenderer.invoke("remote:telegram", token, project),
    onRemoteAccess: listener => subscribe("remote:event", listener)
  } satisfies Pick<DesktopApi, "remoteAccess" | "setRemoteWeb" | "setTelegramBot" | "onRemoteAccess">;
}
