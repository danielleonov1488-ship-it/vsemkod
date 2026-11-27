import { useEffect, useState } from "react";
import type { Connector, ConnectorState, SkillEntry } from "../shared/api";
import { readableError } from "./connections";

const api = window.vsemkod;

const connectorCategories: Record<Connector["category"], string> = {
  docs: "Документация", search: "Поиск", browser: "Браузер", code: "Код", data: "Данные",
  deploy: "Деплой", design: "Дизайн", work: "Работа"
};
const skillCategories: Record<SkillEntry["category"], string> = {
  design: "Дизайн", code: "Код", docs: "Документы", process: "Как работать"
};
const statusText: Record<NonNullable<ConnectorState["status"]>, string> = {
  connected: "Подключён", disabled: "Выключен", pending: "Подключается", failed: "Ошибка", needs_auth: "Нужен вход"
};
const requirementText = { node: "Node.js", chrome: "Google Chrome" } as const;
const requirementUrl = { node: "https://nodejs.org/ru/download", chrome: "https://www.google.com/chrome/" } as const;

function Chips<Id extends string>({ value, items, change, label }: {
  value: Id | "all"; items: [Id | "all", string, number][]; change: (value: Id | "all") => void; label: string;
}) {
  return <div className="catalog-chips" role="radiogroup" aria-label={label}>
    {items.map(([id, title, count]) => <button key={id} type="button" role="radio" aria-checked={value === id}
      onClick={() => change(id)}>{title}<span>{count}</span></button>)}
  </div>;
}

/** Готовые MCP-коннекторы: карточки с «Подключить», ключом или входом через аккаунт. */
export function ConnectorCatalog({ directory, onError }: { directory: string; onError: (error: unknown) => void }) {
  const [items, setItems] = useState<ConnectorState[]>();
  const [category, setCategory] = useState<Connector["category"] | "popular" | "all">("all");
  const [working, setWorking] = useState<string>();
  const [keyFor, setKeyFor] = useState<string>();
  const [key, setKey] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    let current = true;
    void api.connectors?.(directory).then(next => { if (current) setItems(next); })
      .catch(error => { if (current) { setItems([]); onError(error); } });
    return () => { current = false; };
  }, [directory, onError]);

  function run(id: string, task: () => Promise<ConnectorState[]> | undefined) {
    const promise = task();
    if (!promise) return;
    setWorking(id);
    setErrors(value => ({ ...value, [id]: "" }));
    void promise.then(next => {
      setItems(next);
      const item = next.find(entry => entry.id === id);
      // Удалённый сервер с OAuth: сразу после установки просим войти.
      if (item?.installed && item.status === "needs_auth" && api.authorizeConnector) {
        return api.authorizeConnector(directory, id).then(setItems);
      }
    }).catch(error => setErrors(value => ({ ...value, [id]: readableError(error) })))
      .finally(() => setWorking(undefined));
  }

  if (!api.connectors) return null;
  const counts = new Map<string, number>();
  for (const item of items ?? []) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  const popular = items?.filter(item => item.popular).length ?? 0;
  const chips: [Connector["category"] | "popular" | "all", string, number][] = [
    ["all", "Все", items?.length ?? 0], ...(popular ? [["popular", "Популярные", popular] as ["popular", string, number]] : []),
    ...(Object.keys(connectorCategories) as Connector["category"][]).filter(id => counts.has(id)).map(id => [id, connectorCategories[id], counts.get(id)!] as [Connector["category"], string, number])
  ];
  const shown = (items ?? []).filter(item => category === "all" || (category === "popular" ? item.popular : item.category === category))
    .sort((a, b) => Number(b.installed) - Number(a.installed) || Number(!!b.popular) - Number(!!a.popular));

  return <section className="settings-group catalog-section"><h2>Готовые коннекторы</h2>
    <p className="settings-hint">Инструменты для агента: документация библиотек, браузер, GitHub, базы данных, деплой. Подключите — и агент сможет ими пользоваться во всех проектах.</p>
    {!items ? <p className="subtle settings-detail">Загружаем каталог…</p> : <>
      <Chips value={category} items={chips} change={setCategory} label="Категории коннекторов" />
      <div className="catalog-grid">
        {shown.map(item => {
          const busy = working === item.id;
          const missing = item.missing ?? [];
          const target = item.url ?? item.command;
          return <article className="catalog-card" key={item.id} data-installed={item.installed || undefined}>
            <div className="catalog-card-head">
              <span className="catalog-mark" aria-hidden="true">{item.name[0]}</span>
              <h3>{item.name}</h3>
              {item.installed && item.status && <span className={"catalog-status " + item.status}>{statusText[item.status]}</span>}
            </div>
            <p className="catalog-description">{item.description}</p>
            <div className="catalog-tags">
              <span>{item.auth === "none" ? "Без входа" : item.auth === "oauth" ? "Вход через аккаунт" : "Нужен ключ"}</span>
              {item.readOnly && <span>Только чтение</span>}
              {item.requires?.map(need => <span key={need} data-missing={missing.includes(need) || undefined}>{"Нужен " + requirementText[need]}</span>)}
            </div>
            {target && <code className="catalog-target" title={target}>{item.transport === "remote" ? "Подключится к " : "Запустит "}{target}</code>}
            {errors[item.id] && <p className="catalog-error" role="alert">{errors[item.id]}</p>}
            {keyFor === item.id && !item.installed ? <form className="catalog-key" onSubmit={event => {
              event.preventDefault();
              const value = key.trim();
              if (!value) return;
              setKeyFor(undefined);
              setKey("");
              run(item.id, () => api.installConnector?.(directory, item.id, { key: value }));
            }}>
              <input className="field-control" type="password" autoFocus autoComplete="off" spellCheck={false} value={key}
                placeholder={item.keyLabel ?? "Ключ"} aria-label={item.keyLabel ?? "Ключ"} onChange={event => setKey(event.target.value)} />
              <button className="small-button" type="submit" disabled={!key.trim()}>Подключить</button>
              <button className="composer-control" type="button" onClick={() => { setKeyFor(undefined); setKey(""); }}>Отмена</button>
              {item.keyPageUrl && <button className="text-link catalog-key-link" type="button"
                onClick={() => void api.openExternal(item.keyPageUrl!).catch(onError)}>Где взять ключ</button>}
            </form> : <div className="catalog-actions">
              {!item.installed ? missing.length ? <button className="composer-control" type="button"
                onClick={() => void api.openExternal(requirementUrl[missing[0]]).catch(onError)}>Установить {requirementText[missing[0]]}</button>
                : <button className="small-button" type="button" disabled={!!working} onClick={() => {
                  if (item.auth === "key") { setKeyFor(item.id); setKey(""); return; }
                  run(item.id, () => api.installConnector?.(directory, item.id));
                }}>{busy ? item.auth === "oauth" ? "Ждём вход в браузере…" : "Подключаем…" : "Подключить"}</button>
              : <>
                {(item.status === "needs_auth" || item.status === "failed") && <button className="small-button" type="button" disabled={!!working}
                  onClick={() => run(item.id, () => item.status === "needs_auth" ? api.authorizeConnector?.(directory, item.id) : api.installConnector?.(directory, item.id))}>
                  {busy ? "Ждём вход в браузере…" : item.status === "needs_auth" ? "Войти" : "Повторить"}</button>}
                <button className="composer-control" type="button" disabled={!!working}
                  onClick={() => run(item.id, () => api.removeConnector?.(directory, item.id))}>{busy && item.status !== "needs_auth" ? "Отключаем…" : "Отключить"}</button>
              </>}
              <button className="text-link catalog-more" type="button" onClick={() => void api.openExternal(item.homepage).catch(onError)}>Подробнее</button>
            </div>}
            {item.installed && item.error && <p className="catalog-error">{item.error}</p>}
          </article>;
        })}
      </div>
    </>}
  </section>;
}

/** Готовые навыки: инструкции, которые агент подключает сам, когда задача подходит. */
export function SkillCatalog({ onError, onChange }: { onError: (error: unknown) => void; onChange?: () => void }) {
  const [items, setItems] = useState<SkillEntry[]>();
  const [category, setCategory] = useState<SkillEntry["category"] | "all">("all");
  const [working, setWorking] = useState<string>();
  useEffect(() => {
    let current = true;
    void api.skillCatalog?.().then(next => { if (current) setItems(next); })
      .catch(error => { if (current) { setItems([]); onError(error); } });
    return () => { current = false; };
  }, [onError]);
  if (!api.skillCatalog) return null;
  const run = (id: string, task: () => Promise<SkillEntry[]> | undefined) => {
    const promise = task();
    if (!promise) return;
    setWorking(id);
    void promise.then(next => { setItems(next); onChange?.(); }).catch(onError).finally(() => setWorking(undefined));
  };
  const counts = new Map<string, number>();
  for (const item of items ?? []) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  const chips: [SkillEntry["category"] | "all", string, number][] = [["all", "Все", items?.length ?? 0],
    ...(Object.keys(skillCategories) as SkillEntry["category"][]).filter(id => counts.has(id)).map(id => [id, skillCategories[id], counts.get(id)!] as [SkillEntry["category"], string, number])];
  const shown = (items ?? []).filter(item => category === "all" || item.category === category).sort((a, b) => Number(b.installed) - Number(a.installed));
  return <section className="settings-group catalog-section"><h2>Готовые навыки</h2>
    <p className="settings-hint">Проверенные инструкции для агента: как делать красивый интерфейс, писать тесты, искать ошибки, работать с PDF и Excel. Агент сам включает навык, когда задача подходит.</p>
    {!items ? <p className="subtle settings-detail">Загружаем каталог…</p> : <>
      <Chips value={category} items={chips} change={setCategory} label="Категории навыков" />
      <div className="catalog-grid">
        {shown.map(item => <article className="catalog-card" key={item.id} data-installed={item.installed || undefined}>
          <div className="catalog-card-head">
            <span className="catalog-mark" aria-hidden="true">{item.name[0]}</span>
            <h3>{item.name}</h3>
            {item.installed && <span className="catalog-status connected">Установлен</span>}
          </div>
          <p className="catalog-description">{item.description}</p>
          <div className="catalog-tags"><span>{item.license}</span></div>
          <div className="catalog-actions">
            {item.installed ? <button className="composer-control" type="button" disabled={!!working}
              onClick={() => run(item.id, () => api.removeSkill?.(item.id))}>{working === item.id ? "Удаляем…" : "Удалить"}</button>
              : <button className="small-button" type="button" disabled={!!working}
                onClick={() => run(item.id, () => api.installSkill?.(item.id))}>{working === item.id ? "Устанавливаем…" : "Установить"}</button>}
            <button className="text-link catalog-more" type="button" onClick={() => void api.openExternal(item.source).catch(onError)}>Источник</button>
          </div>
        </article>)}
      </div>
    </>}
  </section>;
}
