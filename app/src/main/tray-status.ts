// Строка состояния для подсказки и меню значка в трее.

function count(value: number, one: string, few: string, many: string) {
  const form = new Intl.PluralRules("ru").select(value);
  return value + " " + (form === "one" ? one : form === "few" ? few : many);
}

export function trayStatus({ running, tasks }: { running: number; tasks: number }) {
  const parts = [running ? "агент работает: " + count(running, "чат", "чата", "чатов") : "агент свободен"];
  if (tasks) parts.push(count(tasks, "фоновая задача", "фоновые задачи", "фоновых задач"));
  return parts.join(" · ");
}
