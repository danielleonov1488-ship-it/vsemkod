export const panelTabs = [
  { id: "changes", title: "Изменения", icon: "changes", code: "KeyD", key: "D", shift: true },
  { id: "browser", title: "Браузер", icon: "globe", code: "KeyB", key: "B", shift: true },
  { id: "files", title: "Файлы", icon: "folder", code: "KeyF", key: "F", shift: true },
  { id: "terminal", title: "Терминал", icon: "terminal", code: "Backquote", key: "`", shift: false },
  { id: "side", title: "Боковой чат", icon: "newChat", code: "Semicolon", key: ";", shift: false },
  { id: "tasks", title: "Фоновые задачи", icon: "clock" },
  { id: "preview", title: "Просмотр", icon: "eye" }
] as const;
export type PanelTab = typeof panelTabs[number]["id"];
export type PanelState = { tabs: PanelTab[]; active?: PanelTab };

export function panelShortcut(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, mac: boolean) {
  if (event.altKey || event.metaKey !== mac || event.ctrlKey === mac) return;
  return panelTabs.find(tab => "code" in tab && tab.code === event.code && tab.shift === event.shiftKey)?.id;
}

export function readPanels(value: string | null): PanelState {
  try {
    const data = JSON.parse(value ?? "null");
    if (!Array.isArray(data?.tabs)) return { tabs: [] };
    const tabs = [...new Set<PanelTab>(data.tabs.filter((id: unknown) => panelTabs.some(tab => tab.id === id)))];
    return { tabs, active: tabs.includes(data.active) ? data.active : tabs.at(-1) };
  } catch { return { tabs: [] }; }
}

export function quoteText(text: string) {
  return text.trim().split(/\r?\n/).map(line => "> " + line).join("\n");
}
