import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Hook, HookInput, Schedule, ScheduleInput } from "../shared/api";
import { Icon } from "./icons";

type SettingsProps = { directory: string; projects: string[]; onError: (error: unknown) => void };
type ScheduleAccess = Exclude<Schedule["access"], "ask">;
const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const everyDay = weekdays.map((_, index) => index + 1);
const accessChoices: [ScheduleAccess, string][] = [
  ["read", "Только чтение"], ["edit", "Может править файлы"], ["full", "Полный доступ"]
];
const scheduleTemplates: Pick<ScheduleInput, "name" | "when" | "access" | "prompt">[] = [
  { name: "Утром проверять зависимости", when: { type: "daily", time: "09:00", weekdays: [] }, access: "read",
    prompt: "Проверь зависимости проекта на устаревшие и уязвимые версии. Напиши короткий отчёт: что обновить и почему." },
  { name: "Вечерняя сводка", when: { type: "daily", time: "18:00", weekdays: [1, 2, 3, 4, 5] }, access: "read",
    prompt: "Посмотри изменения в проекте за сегодня (git log, git diff) и напиши короткую сводку на русском." },
  { name: "Еженедельно обновлять README", when: { type: "interval", hours: 168 }, access: "edit",
    prompt: "Обнови README.md под текущее состояние проекта: что это, как запустить, структура." }
];
const hookTemplates = [
  ["Тесты", "npm test"], ["Проверка типов", "npx tsc --noEmit"], ["Сборка", "npm run build"], ["Линтер", "npm run lint"]
];
const time = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const date = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const hours = new Intl.NumberFormat("ru-RU", { style: "unit", unit: "hour", unitDisplay: "long" });

function projectName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function dateLabel(at: number) {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const day = new Date(at).toDateString();
  const label = day === now.toDateString() ? "сегодня" : day === tomorrow.toDateString() ? "завтра" : date.format(at);
  return label + " в " + time.format(at);
}

function scheduleLabel(when: Schedule["when"]) {
  if (when.type === "interval") return "Каждые " + hours.format(when.hours);
  const dayLabel = when.weekdays.join() === "1,2,3,4,5" ? "Пн–Пт" : when.weekdays.map(day => weekdays[day - 1]).join(", ");
  return "Каждый день в " + when.time + (when.weekdays.length && when.weekdays.length < 7 ? " · " + dayLabel : "");
}

export function HookOutput({ output }: { output?: string }) {
  return output !== undefined ? <details className="auto-output">
    <summary className="text-link">Показать вывод</summary>
    <pre>{output || "Команда ничего не вывела."}</pre>
  </details> : null;
}

function ProjectField({ value, projects, change, all = false }: {
  value: string; projects: string[]; change: (value: string) => void; all?: boolean;
}) {
  const options = [...new Set([...projects, ...(value ? [value] : [])])];
  return <label className="auto-field">Проект
    <select className="field-control" required={!all} value={value} onChange={event => change(event.currentTarget.value)}>
      {(all || !value) && <option value="">{all ? "Все проекты" : "Выберите проект"}</option>}
      {options.map(path => <option key={path} value={path} title={path}>{projectName(path)}</option>)}
    </select>
  </label>;
}

function Choice<Value extends string>({ title, value, options, change }: {
  title: string; value: Value; options: [Value, string][]; change: (value: Value) => void;
}) {
  return <fieldset className="auto-field">
    <legend>{title}</legend>
    <div className="auto-segments">{options.map(([id, label]) => <button key={id} type="button"
      className="composer-control" aria-pressed={value === id} onClick={() => change(id)}>{label}</button>)}</div>
  </fieldset>;
}

function CardActions({ name, enabled, toggle, edit, remove, run, busy }: {
  name: string; enabled: boolean; toggle: (value: boolean) => void; edit: () => void;
  remove: () => void; run?: () => void; busy: boolean;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  function action(run: () => void) {
    if (menu.current) menu.current.open = false;
    run();
  }
  return <div className="auto-actions">
    <input className="switch" type="checkbox" role="switch" aria-label={"Включено: " + name}
      checked={enabled} disabled={busy} onChange={event => toggle(event.currentTarget.checked)} />
    <details className="auto-menu" ref={menu} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }} onKeyDown={event => {
      if (event.key === "Escape" && menu.current?.open) {
        event.stopPropagation();
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    }}>
      <summary className="composer-control" aria-label={"Действия: " + name}><Icon name="more" /></summary>
      <div className="auto-menu-items">
        {run && <button type="button" className="composer-control" disabled={busy} onClick={() => action(run)}>Запустить сейчас</button>}
        <button type="button" className="composer-control" disabled={busy} onClick={() => action(edit)}>Изменить</button>
        <button type="button" className="composer-control auto-failed" disabled={busy} onClick={() => action(remove)}>Удалить</button>
      </div>
    </details>
  </div>;
}

function FormButtons({ busy, cancel }: { busy: boolean; cancel: () => void }) {
  return <div className="auto-buttons">
    <button type="submit" className="small-button" disabled={busy}>Сохранить</button>
    <button type="button" className="composer-control" onClick={cancel} disabled={busy}>Отмена</button>
  </div>;
}

function ScheduleForm({ initial, projects, save, cancel, busy }: {
  initial: ScheduleInput; projects: string[]; save: (input: ScheduleInput) => void; cancel: () => void; busy: boolean;
}) {
  const [input, setInput] = useState(initial);
  const [daily, setDaily] = useState(initial.when.type === "daily" ? initial.when : { type: "daily" as const, time: "09:00", weekdays: [] });
  const [interval, setIntervalHours] = useState(initial.when.type === "interval" ? String(initial.when.hours) : "1");
  const [kind, setKind] = useState(initial.when.type);
  const update = (patch: Partial<ScheduleInput>) => setInput(value => ({ ...value, ...patch }));
  const selectedDays = daily.weekdays.length ? daily.weekdays : everyDay;
  function toggleDay(day: number) {
    const next = selectedDays.includes(day) ? selectedDays.filter(value => value !== day) : [...selectedDays, day].sort();
    if (next.length) setDaily({ ...daily, weekdays: next.length === 7 ? [] : next });
  }
  return <form className="auto-card auto-form" onSubmit={event => {
    event.preventDefault();
    save({ ...input, when: kind === "daily" ? daily : { type: "interval", hours: Number(interval) } });
  }}>
    <div className="auto-chips" aria-label="Шаблоны задач">{scheduleTemplates.map(template => <button type="button" className="composer-control"
      key={template.name} onClick={() => {
        update(template);
        setKind(template.when.type);
        if (template.when.type === "daily") setDaily(template.when);
        else setIntervalHours(String(template.when.hours));
      }}>{template.name}</button>)}</div>
    <label className="auto-field">Название<input className="field-control" required maxLength={90} value={input.name}
      onChange={event => update({ name: event.currentTarget.value })} /></label>
    <ProjectField value={input.directory} projects={projects} change={directory => update({ directory })} />
    <label className="auto-field">Что сделать<textarea className="field-control" required maxLength={100_000} rows={3} value={input.prompt}
      onChange={event => update({ prompt: event.currentTarget.value })} /></label>
    <Choice title="Когда" options={[["daily", "Каждый день"], ["interval", "Каждые N часов"]]} value={kind} change={setKind} />
    {kind === "daily" ? <div className="auto-timing">
      <label className="auto-field">Время<input className="field-control" type="time" required value={daily.time}
        onChange={event => setDaily({ ...daily, time: event.currentTarget.value })} /></label>
      <fieldset className="auto-field"><legend>Дни недели</legend>
        <div className="auto-chips">{weekdays.map((name, index) => <button key={name} type="button" className="composer-control"
          aria-pressed={selectedDays.includes(index + 1)} disabled={selectedDays.length === 1 && selectedDays[0] === index + 1}
          onClick={() => toggleDay(index + 1)}>{name}</button>)}</div>
      </fieldset>
    </div> : <label className="auto-field auto-number">Интервал, ч<input className="field-control" type="number" required min={1}
      max={168} value={interval} onChange={event => setIntervalHours(event.currentTarget.value)} /></label>}
    <Choice title="Доступ" options={accessChoices} value={input.access === "ask" ? "read" : input.access} change={access => update({ access })} />
    {input.access === "full" && <p className="auto-meta">Может запускать любые команды.</p>}
    <FormButtons busy={busy} cancel={cancel} />
  </form>;
}

function HookForm({ initial, projects, busy, save, cancel }: {
  initial: HookInput; projects: string[]; busy: boolean; save: (input: HookInput) => void; cancel: () => void;
}) {
  const [input, setInput] = useState(initial);
  const [attempts, setAttempts] = useState(String(initial.fixAttempts));
  const update = (patch: Partial<HookInput>) => setInput(value => ({ ...value, ...patch }));
  return <form className="auto-card auto-form" onSubmit={event => { event.preventDefault(); save({ ...input, fixAttempts: Number(attempts) }); }}>
    <div className="auto-chips" aria-label="Шаблоны хуков">{hookTemplates.map(([name, command]) => <button key={name}
      type="button" className="composer-control" onClick={() => update({ name, command })}>{name}</button>)}</div>
    <label className="auto-field">Название<input className="field-control" required maxLength={90} value={input.name}
      onChange={event => update({ name: event.currentTarget.value })} /></label>
    <label className="auto-field">Команда<input className="field-control auto-code" required maxLength={16_384} value={input.command}
      onChange={event => update({ command: event.currentTarget.value })} /></label>
    <ProjectField value={input.directory ?? ""} projects={projects} all change={directory => update({ directory: directory || undefined })} />
    <label className="auto-check"><input type="checkbox" checked={input.onlyWhenFilesChanged}
      onChange={event => update({ onlyWhenFilesChanged: event.currentTarget.checked })} />Только если агент менял файлы</label>
    <label className="auto-field auto-number">Если команда упала — просить агента исправить
      <input className="field-control" type="number" required min={0} max={5} value={attempts} onChange={event => setAttempts(event.currentTarget.value)} />
    </label>
    <FormButtons busy={busy} cancel={cancel} />
  </form>;
}

function Group({ title, addLabel, add, children }: { title: string; addLabel: string; add: () => void; children: ReactNode }) {
  return <section className="settings-group auto-group">
    <div className="auto-heading"><h2>{title}</h2><button type="button" className="small-button" onClick={add}>{addLabel}</button></div>
    {children}
  </section>;
}

export function AutomationSettings({ directory, projects, onError }: SettingsProps) {
  const api = window.vsemkod;
  const [schedules, setSchedules] = useState<Schedule[]>();
  const [hooks, setHooks] = useState<Hook[]>();
  const [scheduleForm, setScheduleForm] = useState<ScheduleInput>();
  const [hookForm, setHookForm] = useState<HookInput>();
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string[]>([]);
  const version = useRef(0);
  const options = [...new Set([directory, ...projects].filter(Boolean))];
  useEffect(() => {
    if (!api.schedules || !api.hooks) return;
    let current = true;
    const refresh = () => {
      const started = ++version.current;
      void Promise.all([api.schedules!(), api.hooks!()]).then(([nextSchedules, nextHooks]) => {
        if (current && started === version.current) { setSchedules(nextSchedules); setHooks(nextHooks); }
      }).catch(error => { if (current && started === version.current) onError(error); });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    const unsubscribe = api.onChat(event => { if (event.type === "hook" && event.status !== "running") refresh(); });
    return () => { current = false; clearInterval(timer); unsubscribe(); };
  }, [api, onError]);

  function mutate<T>(operation: () => Promise<T>, apply: (items: T) => void) {
    setBusy(true);
    void operation().then(items => { version.current++; apply(items); }).catch(onError).finally(() => setBusy(false));
  }

  if (!api.schedules || !api.saveSchedule || !api.removeSchedule || !api.runSchedule || !api.hooks || !api.saveHook || !api.removeHook) {
    return <p className="subtle settings-detail">Автоматизации доступны в настольном приложении.</p>;
  }
  const openChat = (window as Window & { vsemkodAutomationChat?: { open(id: string): Promise<void> } }).vsemkodAutomationChat;
  const saveSchedule = (input: ScheduleInput, close = false) => mutate(() => api.saveSchedule!(input), list => {
    setSchedules(list);
    if (close) setScheduleForm(undefined);
  });
  const saveHook = (input: HookInput, close = false) => mutate(() => api.saveHook!(input), list => {
    setHooks(list);
    if (close) setHookForm(undefined);
  });
  function run(id: string) {
    setRunning(ids => [...ids, id]);
    void api.runSchedule!(id).then(list => { version.current++; setSchedules(list); }).catch(onError)
      .finally(() => setRunning(ids => ids.filter(item => item !== id)));
  }
  return <>
    <Group title="По расписанию" addLabel="Новая задача" add={() => setScheduleForm({
      name: "", directory, prompt: "", when: { type: "daily", time: "09:00", weekdays: [] }, access: "read", enabled: true
    })}>
      {scheduleForm && <ScheduleForm key={scheduleForm.id ?? "new"} initial={scheduleForm} projects={options} busy={busy}
        save={input => saveSchedule(input, true)} cancel={() => setScheduleForm(undefined)} />}
      {schedules?.length === 0 && !scheduleForm && <p className="auto-meta">Пока нет задач по расписанию. Задачи выполняются, пока vsemkod запущен (можно свёрнутым в трей).</p>}
      <div className="auto-list">{schedules?.map(item => {
        const last = item.lastRun;
        const isRunning = running.includes(item.id);
        return <article className="auto-card" key={item.id}>
          <div className="auto-card-head"><h3>{item.name}</h3>
            <CardActions name={item.name} enabled={item.enabled} busy={busy || isRunning}
              toggle={enabled => saveSchedule({ ...item, enabled })} edit={() => setScheduleForm(item)}
              remove={() => mutate(() => api.removeSchedule!(item.id), setSchedules)} run={() => run(item.id)} />
          </div>
          <p className="auto-meta">{scheduleLabel(item.when)} · проект {projectName(item.directory)}</p>
          {isRunning ? <p className="auto-meta" role="status">Выполняется…</p> : item.nextRun !== undefined &&
            <p className="auto-meta">Следующий запуск: {dateLabel(item.nextRun)}</p>}
          {last && <div className="auto-result">
            <span className={last.ok ? "auto-passed" : "auto-failed"}>{last.ok ? "✓" : "✗"} {last.ok ? "Готово" : "Ошибка"} · {dateLabel(last.at)}</span>
            {last.sessionId && openChat && <button type="button" className="text-link" onClick={() => void openChat.open(item.id).catch(onError)}>Открыть чат</button>}
          </div>}
          {last?.error && <p className="auto-meta auto-failed">{last.error}</p>}
        </article>;
      })}</div>
    </Group>
    <Group title="Хуки после ответа агента" addLabel="Новый хук" add={() => setHookForm({
      name: "", command: "", onlyWhenFilesChanged: true, fixAttempts: 2, enabled: true
    })}>
      {hookForm && <HookForm key={hookForm.id ?? "new"} initial={hookForm} projects={options} busy={busy}
        save={input => saveHook(input, true)} cancel={() => setHookForm(undefined)} />}
      {hooks?.length === 0 && !hookForm && <p className="auto-meta">Пока нет хуков.</p>}
      <div className="auto-list">{hooks?.map(item => {
        const last = item.lastRun;
        return <article className="auto-card" key={item.id}>
          <div className="auto-card-head"><h3>{item.name}</h3>
            <CardActions name={item.name} enabled={item.enabled} busy={busy} toggle={enabled => saveHook({ ...item, enabled })}
              edit={() => setHookForm(item)} remove={() => mutate(() => api.removeHook!(item.id), setHooks)} />
          </div>
          <code className="auto-code">{item.command}</code>
          <p className="auto-meta">Проект: {item.directory ? projectName(item.directory) : "Все проекты"}
            {item.onlyWhenFilesChanged && " · Только если менялись файлы"}
            {" · Чинить ошибки: до " + item.fixAttempts + " раз"}</p>
          {last && <>
            <p className={"auto-meta " + (last.exitCode === 0 ? "auto-passed" : "auto-failed")}>
              {last.exitCode === 0 ? "✓ Прошёл" : "✗ Упал"} · код {last.exitCode}
            </p>
            <HookOutput output={last.output} />
          </>}
        </article>;
      })}</div>
    </Group>
  </>;
}
