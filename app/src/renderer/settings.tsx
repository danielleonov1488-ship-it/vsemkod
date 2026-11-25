import { useEffect, useState, type ReactNode } from "react";
import type { CatalogState, McpConfig, McpEntry, Preferences, SkillSummary } from "../shared/api";
import { accessLabels } from "../shared/workspace";
import { ModelSettings, PreferenceSwitch } from "./connections";
import { Icon } from "./icons";

const api = window.vsemkod;
const sections = ["Общие", "Модели и подключения", "Агент", "MCP-серверы", "Навыки", "Горячие клавиши", "Данные", "О программе"];
const hotkeys = [
  ["Ctrl+N", "Новый чат"], ["Ctrl+K", "Поиск чатов"], ["Ctrl+B", "Правая панель"], ["Ctrl+J", "Терминал"],
  ["Ctrl+,", "Настройки"], ["Shift+Tab", "Режим доступа"], ["Esc Esc", "Остановить агента"], ["Ctrl+Enter", "Вмешаться"],
  ["Enter", "Отправить сообщение"], ["Shift+Enter", "Новая строка"], ["↑ / ↓ / Tab", "Выбрать команду или упоминание"]
];

function Select<Value extends string>({ title, value, choices, change }: {
  title: string; value: Value; choices: Record<Value, string>; change: (value: Value) => void;
}) {
  return <label className="settings-row"><span>{title}</span><select className="field-control" aria-label={title} value={value} onChange={event => change(event.target.value as Value)}>
    {Object.entries<string>(choices).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
  </select></label>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-group"><h2>{title}</h2>{children}</section>;
}

function AgentSettings({ prefs, update, onError }: {
  prefs: Preferences; update: (patch: Partial<Preferences>) => void; onError: (error: unknown) => void;
}) {
  const [rules, setRules] = useState<string>();
  const [saved, setSaved] = useState("");
  const [steps, setSteps] = useState(prefs.agentSteps);
  const [writing, setWriting] = useState(false);
  useEffect(() => {
    let current = true;
    void api.readInstructions().then(text => { if (current) { setRules(text); setSaved(text); } })
      .catch(error => { if (current) onError(error); });
    return () => { current = false; };
  }, [onError]);
  return <>
    <Group title="Правила для всех проектов">
      <p className="subtle settings-detail">OpenCode читает этот файл AGENTS.md перед запросом. Для правил одного проекта положите AGENTS.md в его папку.</p>
      <textarea className="field-control rules-editor" aria-label="Правила для всех проектов" placeholder="Добавьте правила для агента"
        disabled={rules === undefined} value={rules ?? ""} maxLength={200_000} onChange={event => setRules(event.target.value)} />
      <button className="small-button" type="button" disabled={rules === undefined || rules === saved || writing} onClick={() => {
        if (rules === undefined) return;
        setWriting(true);
        void api.saveInstructions(rules).then(() => setSaved(rules)).catch(onError).finally(() => setWriting(false));
      }}>{writing ? "Сохраняем…" : "Сохранить правила"}</button>
    </Group>
    <Group title="Инструменты агента">
      <PreferenceSwitch title="Веб-поиск" detail="Разрешить агенту искать в интернете через TinyFish"
        value={prefs.webSearch} toggle={webSearch => update({ webSearch })} />
      <label className="settings-row"><span>Макс. шагов агента <small className="subtle">· 0 — по умолчанию</small></span>
        <input type="number" className="field-control short-number" min={0} max={200} value={steps}
          onChange={event => setSteps(Number(event.target.value))}
          onBlur={() => { const valid = Math.max(0, Math.min(200, Math.floor(steps))); setSteps(valid); update({ agentSteps: valid }); }} />
      </label>
    </Group>
  </>;
}

const statuses = { connected: "Подключён", disabled: "Выключен", pending: "Подключается", failed: "Ошибка", needs_auth: "Нужен вход" };
function pairs(value: string) {
  return Object.fromEntries(value.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const at = line.indexOf("=");
    if (at < 1) throw new Error("Укажите каждую пару на отдельной строке в формате имя=значение.");
    return [line.slice(0, at).trim(), line.slice(at + 1)];
  }));
}

function McpSettings({ directory, onError }: { directory: string; onError: (error: unknown) => void }) {
  const [items, setItems] = useState<McpEntry[]>();
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<"local" | "remote">("local");
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let current = true;
    void api.mcpList(directory).then(next => { if (current) setItems(next); })
      .catch(error => { if (current) { setItems([]); onError(error); } });
    return () => { current = false; };
  }, [directory, onError]);
  function change(name: string, action: "put" | "delete" | "enable" | "disable" | "check", config?: McpConfig) {
    setWorking(true);
    void api.mcpChange(directory, name, action, config).then(next => { setItems(next); if (config) setAdding(false); })
      .catch(onError).finally(() => setWorking(false));
  }
  return <>
    <p className="subtle settings-detail">{!items ? "Получаем список серверов…" : !items.length ? "MCP-серверы ещё не добавлены." : "Серверы, доступные в текущем проекте."}</p>
    {items?.map(item => <div key={item.name} className="mcp-item">
      <strong>{item.name}</strong><span className={"mcp-status " + item.status}>{statuses[item.status]}</span>
      {item.error && <p className="subtle">{item.error}</p>}
      <div className="settings-actions">
        <button className="composer-control" type="button" disabled={working || item.status === "disabled"} onClick={() => change(item.name, "check")}>Проверить</button>
        {item.managed && <>
          <button className="composer-control" type="button" disabled={working} onClick={() => change(item.name, item.status === "disabled" ? "enable" : "disable")}>
            {item.status === "disabled" ? "Включить" : "Выключить"}</button>
          <button className="composer-control danger-action" type="button" disabled={working} onClick={() => {
            if (window.confirm("Удалить MCP-сервер «" + item.name + "» из настроек?")) change(item.name, "delete");
          }}>Удалить</button>
        </>}
      </div>
    </div>)}
    {!adding ? <button className="small-button" type="button" onClick={() => setAdding(true)}>Добавить сервер</button> :
      <form className="mcp-form" onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const value = (key: string) => String(fields.get(key) ?? "").trim();
        try {
          const config: McpConfig = type === "local" ? { type, command: [value("address"), ...value("args").split(/\r?\n/).filter(Boolean)], environment: pairs(value("pairs")) }
            : { type, url: value("address"), headers: pairs(value("pairs")) };
          change(value("name"), "put", config);
        } catch (error) { onError(error); }
      }}>
        <Select title="Тип сервера" value={type} choices={{ local: "Локальный", remote: "Удалённый" }} change={setType} />
        <label className="manual-field">Имя<input className="field-control" name="name" pattern="[A-Za-z0-9_\-]{1,64}" required placeholder="project-tools" /></label>
        <label className="manual-field" key={type}>{type === "local" ? "Команда" : "URL"}<input className="field-control" name="address"
          type={type === "remote" ? "url" : "text"} required placeholder={type === "remote" ? "https://example.com/mcp" : "node"} /></label>
        {type === "local" && <label className="manual-field">Аргументы по одному на строку<textarea className="field-control" name="args" rows={2} /></label>}
        <label className="manual-field">{type === "local" ? "Переменные среды" : "Заголовки"}<textarea className="field-control" name="pairs"
          rows={2} placeholder="ИМЯ=значение" /></label>
        <div className="settings-actions"><button className="small-button" type="submit" disabled={working}>Сохранить</button>
          <button className="composer-control" type="button" disabled={working} onClick={() => setAdding(false)}>Отмена</button></div>
      </form>}
  </>;
}

function Skills({ directory, onError }: { directory: string; onError: (error: unknown) => void }) {
  const [skills, setSkills] = useState<SkillSummary[]>();
  useEffect(() => {
    let current = true;
    void api.tools(directory).then(value => { if (current) setSkills(value.skills); })
      .catch(error => { if (current) { setSkills([]); onError(error); } });
    return () => { current = false; };
  }, [directory, onError]);
  return <>
    <button className="small-button" type="button" onClick={() => void api.openFolder("skills").catch(onError)}>Открыть папку навыков</button>
    {!skills?.length && <p className="subtle settings-detail">{skills ? "В текущем проекте пока нет навыков." : "Получаем список навыков…"}</p>}
    {skills?.map(item => <section className="skill-item" key={item.id}><h2>{item.name}</h2>
      {item.description && <p>{item.description}</p>}<code className="subtle">{item.path}</code>
    </section>)}
  </>;
}

type SettingsProps = Omit<Parameters<typeof ModelSettings>[0], "prefs"> & {
  prefs?: Preferences; version?: string; directory: string; choose: () => void; open: (url: string) => void;
  checkUpdates: () => void; checkingUpdates: boolean; exportAll: () => void; state?: CatalogState;
  onError: (error: unknown) => void; onNotice: (text: string) => void;
};

export function Settings({ prefs, version, directory, choose, update, open, checkUpdates, checkingUpdates, exportAll, onError, onNotice, ...models }: SettingsProps) {
  const [section, setSection] = useState(0);
  return <main className="workspace settings-workspace">
    <header className="chat-header"><h1>Настройки</h1></header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Разделы настроек">{sections.map((title, index) =>
        <button className="sidebar-row" aria-current={section === index ? "page" : undefined} type="button" key={title}
          onClick={() => setSection(index)}>{title}</button>)}</nav>
      <div className="settings-panel settings-content" key={section}>
        <h1>{sections[section]}</h1>
        {section === 0 && prefs && <>
          <Group title="Внешний вид">
            <Select title="Тема" value={prefs.theme} choices={{ system: "Как в системе", dark: "Тёмная", light: "Светлая" }} change={theme => update({ theme })} />
            <Select title="Размер шрифта" value={prefs.fontSize} choices={{ small: "Мелкий", normal: "Обычный", large: "Крупный" }} change={fontSize => update({ fontSize })} />
          </Group>
          <Group title="Рабочая папка и доступ">
            <div className="settings-row"><span className="folder-path" title={prefs.directory}>Папка по умолчанию<span className="subtle">{prefs.directory}</span></span>
              <button type="button" className="composer-control folder-chip" onClick={choose}><Icon name="folder" />Выбрать</button></div>
            <Select title="Режим доступа по умолчанию" value={prefs.defaultAccess} choices={accessLabels} change={defaultAccess => update({ defaultAccess })} />
            <Select title="Enter во время работы" value={prefs.busyEnter} choices={{ queue: "В очередь", interrupt: "Вмешаться" }} change={busyEnter => update({ busyEnter })} />
          </Group>
          <Group title="Уведомления и питание">
            <PreferenceSwitch title="Системные уведомления" detail="Когда агент закончил или ждёт ответа, а окно не в фокусе"
              value={prefs.notifications} toggle={notifications => update({ notifications })} />
            <PreferenceSwitch title="Звук уведомлений" detail="" value={prefs.notificationSound} toggle={notificationSound => update({ notificationSound })} />
            <PreferenceSwitch title="Не давать компьютеру уснуть, пока агент работает" detail="" value={prefs.keepAwake} toggle={keepAwake => update({ keepAwake })} />
          </Group>
          <Group title="Обновления"><div className="settings-row"><span className="subtle">Текущая версия {version}</span>
            <button type="button" className="composer-control connect-label" disabled={checkingUpdates} onClick={checkUpdates}>{checkingUpdates ? "Проверяем…" : "Проверить обновления"}</button>
          </div></Group>
        </>}
        {section === 1 && <ModelSettings {...models} prefs={prefs} update={update} onError={onError} />}
        {section === 2 && prefs && <AgentSettings prefs={prefs} update={update} onError={onError} />}
        {section === 3 && <McpSettings key={directory} directory={directory} onError={onError} />}
        {section === 4 && <Skills key={directory} directory={directory} onError={onError} />}
        {section === 5 && <dl className="hotkey-list">{hotkeys.map(([key, action]) => <div key={key}><dt>{action}</dt><dd><kbd>{key}</kbd></dd></div>)}</dl>}
        {section === 6 && <>
          <p className="subtle settings-detail">Телеметрии нет: vsemkod ничего не отправляет, кроме запросов к выбранным вами моделям.</p>
          <div className="data-actions">
            <button className="composer-control folder-chip" type="button" onClick={() => void api.openFolder("data").catch(onError)}>Открыть папку данных</button>
            <button className="composer-control folder-chip" type="button" onClick={() => void api.openFolder("logs").catch(onError)}>Открыть логи</button>
            <button className="composer-control folder-chip" type="button" onClick={exportAll}>Экспортировать все чаты</button>
            <button className="composer-control folder-chip" type="button" onClick={() => void api.clearCatalog().then(() => onNotice("Кэш каталога очищен")).catch(onError)}>Очистить кэш каталога</button>
          </div>
        </>}
        {section === 7 && <><Group title="vsemkod"><p className="subtle settings-detail">Версия {version} · лицензия MIT</p>
          <div className="settings-actions">
            <button className="text-link" type="button" onClick={() => open("https://github.com/danielleonov1488-ship-it/vsemkod")}>GitHub</button>
            <button className="text-link" type="button" onClick={() => open("https://vsemkod.ru")}>vsemkod.ru</button>
          </div></Group></>}
      </div>
    </div>
  </main>;
}
