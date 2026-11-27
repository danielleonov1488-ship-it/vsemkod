import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import type { RemoteAccess } from "../shared/api";
import { PreferenceSwitch } from "./connections";

type Group = "web" | "telegram";
const empty: RemoteAccess = { web: { enabled: false, urls: [] }, telegram: { connected: false } };

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    : "Не удалось выполнить действие.";
}

export function RemoteAccessSettings({ projects, onError }: { projects: string[]; onError: (error: unknown) => void }) {
  const api = window.vsemkod;
  const [state, setState] = useState(empty);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState<Group>();
  const [ready, setReady] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Group, string>>>({});
  const [copied, setCopied] = useState<Group>();
  const revision = useRef(0);
  const { web, telegram } = state;
  const address = web.urls[0];
  const pairCommand = telegram.pairCode && "/start " + telegram.pairCode;
  const qr = useMemo(() => {
    if (!address) return;
    const code = qrcode(0, "M");
    code.addData(address);
    code.make();
    return code.createDataURL(4, 6);
  }, [address]);

  useEffect(() => {
    if (!api.remoteAccess) return;
    let mounted = true;
    const version = revision.current;
    const unsub = api.onRemoteAccess?.(next => {
      revision.current++;
      setState(next);
      setReady(true);
    });
    void api.remoteAccess().then(next => {
      if (!mounted) return;
      if (version === revision.current) setState(next);
      setReady(true);
    }).catch(error => { if (mounted) onError(error); });
    return () => { mounted = false; unsub?.(); };
  }, [api, onError]);

  async function change(group: Group, action: () => Promise<RemoteAccess>) {
    setPending(group);
    setCopied(undefined);
    setErrors(current => ({ ...current, [group]: undefined }));
    const version = revision.current;
    try {
      const next = await action();
      if (revision.current === version) setState(next);
    } catch (error) {
      setErrors(current => ({ ...current, [group]: errorMessage(error) }));
    } finally {
      setPending(undefined);
    }
  }

  function webChange(enabled: boolean) {
    if (api.setRemoteWeb) void change("web", () => api.setRemoteWeb!(enabled));
  }

  function rotate() {
    if (api.setRemoteWeb) void change("web", async () => {
      await api.setRemoteWeb!(false);
      return api.setRemoteWeb!(true);
    });
  }

  function botChange(value: string | null, project?: string) {
    if (api.setTelegramBot) void change("telegram", async () => {
      const next = await api.setTelegramBot!(value, project);
      if (next.telegram.connected) setToken("");
      return next;
    });
  }

  function open(url: string) {
    void api.openExternal(url).catch(error => setErrors(current => ({ ...current, telegram: errorMessage(error) })));
  }

  function copy(group: Group, value: string) {
    void api.copyText(value).then(() => setCopied(group))
      .catch(error => setErrors(current => ({ ...current, [group]: errorMessage(error) })));
  }

  const disabled = !ready || pending !== undefined;
  const projectChoices = [...new Set([...projects, ...(telegram.project ? [telegram.project] : [])])];

  return <>
    <section className="settings-group">
      <h2>Браузер телефона</h2>
      <fieldset className="remote-switch" disabled={disabled || !api.setRemoteWeb}>
        <PreferenceSwitch title="Открыть доступ в локальной сети" value={web.enabled} toggle={webChange}
          detail="Телефон должен быть в той же Wi-Fi-сети. Windows может спросить разрешение для сети — нажмите «Разрешить»." />
      </fieldset>
      {web.enabled && (address && qr ? <div className="remote-card">
        <div className="remote-qr"><img src={qr} alt="QR-код для входа с телефона" /></div>
        <div className="remote-card-details">
          <code className="remote-address">{address}</code>
          {web.urls.length > 1 && <ul className="remote-other-addresses subtle">
            {web.urls.slice(1).map(url => <li key={url}><code>{url}</code></li>)}
          </ul>}
          <p className="subtle">Ссылка содержит ключ доступа — не пересылайте её</p>
          <div className="remote-actions">
            <button type="button" className="small-button" disabled={disabled} onClick={() => copy("web", address)}>
              {copied === "web" ? "Скопировано" : "Копировать ссылку"}
            </button>
            <button type="button" className="composer-control" disabled={disabled} onClick={rotate}>Новый ключ</button>
          </div>
        </div>
      </div> : <p className="remote-empty subtle">Подключите компьютер к локальной сети, чтобы получить адрес.</p>)}
      {(errors.web || web.error) && <p className="remote-error" role="alert">{errors.web || web.error}</p>}
    </section>

    <section className="settings-group">
      <h2>Telegram-бот</h2>
      {!telegram.connected ? <ol className="remote-steps">
        <li>
          <p>Откройте @BotFather в Telegram и создайте бота командой <code>/newbot</code></p>
          <button type="button" className="composer-control" onClick={() => open("https://t.me/BotFather")}>Открыть @BotFather</button>
        </li>
        <li>
          <form onSubmit={event => { event.preventDefault(); botChange(token.trim()); }}>
            <label htmlFor="remote-bot-token">Вставьте токен бота</label>
            <div className="remote-actions">
              <input id="remote-bot-token" className="field-control remote-token" type="password" autoComplete="off" spellCheck={false}
                maxLength={256} value={token} onChange={event => setToken(event.currentTarget.value)} disabled={disabled || !api.setTelegramBot} />
              <button className="small-button" type="submit" disabled={disabled || !api.setTelegramBot || !token.trim()}>
                {pending === "telegram" ? "Подключаем…" : "Подключить"}
              </button>
            </div>
          </form>
        </li>
        <li>Отправьте боту код</li>
      </ol> : <>
        {telegram.pairedUser ? <>
          <p className="remote-bot-label">Бот @{telegram.botName} · владелец {telegram.pairedUser}</p>
          <label className="remote-project">Проект для новых чатов
            <select className="field-control" value={telegram.project ?? ""} disabled={disabled}
              onChange={event => botChange("", event.currentTarget.value)}>
              {projectChoices.map(project => <option key={project} value={project} title={project}>{project.split(/[\\/]/).filter(Boolean).at(-1) ?? project}</option>)}
            </select>
          </label>
        </> : <>
          <p className="remote-bot-label">Бот @{telegram.botName} подключён. Отправьте ему:</p>
          {pairCommand && <div className="remote-pair">
            <code>{pairCommand}</code>
            <button type="button" className="composer-control" onClick={() => copy("telegram", pairCommand)}>
              {copied === "telegram" ? "Скопировано" : "Копировать код"}
            </button>
          </div>}
        </>}
        <div className="remote-actions">
          {telegram.pairedUser
            ? <button type="button" className="composer-control" disabled={disabled} onClick={() => botChange("")}>Отвязать</button>
            : <button type="button" className="small-button" onClick={() => open("https://t.me/" + telegram.botName)}>Открыть бота</button>}
          <button type="button" className="composer-control" disabled={disabled} onClick={() => botChange(null)}>Отключить бота</button>
        </div>
      </>}
      {(errors.telegram || telegram.error) && <p className="remote-error" role="alert">{errors.telegram || telegram.error}</p>}
    </section>
  </>;
}
