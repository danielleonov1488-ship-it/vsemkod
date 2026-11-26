import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { quoteText } from "../shared/panels";
import { Icon } from "./icons";
import { readableError } from "./connections";
import { findSecrets, maskSecrets } from "../shared/secrets";

export function SideChat({ id, directory, parent, model, variant, insert }: {
  id: string; directory: string; parent?: string; model?: string; variant?: string; insert: (text: string) => void;
}) {
  const [messages, setMessages] = useState<{ question: string; answer?: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState(false);
  const thread = useRef<HTMLDivElement>(null);
  const api = window.vsemkod;
  useEffect(() => { if (thread.current) thread.current.scrollTop = thread.current.scrollHeight; }, [messages, busy]);

  async function ask(allowSecrets = false) {
    const text = draft.trim();
    if (!text || !model || busy || !api.askSide) return;
    if (!allowSecrets && findSecrets(text).length) { setWarning(true); return; }
    setWarning(false);
    setDraft("");
    setError("");
    setBusy(true);
    setMessages(value => [...value, { question: text }]);
    try {
      const reply = await api.askSide(id, directory, parent, text, model, variant || undefined);
      setMessages(value => [...value.slice(0, -1), { question: text, answer: reply.text }]);
    } catch (error) {
      setError(readableError(error));
      setDraft(text);
      setMessages(value => value.slice(0, -1));
    } finally { setBusy(false); }
  }

  return <section className="side-chat">
    <p className="subtle side-chat-note">Ответы здесь не попадут в основной чат</p>
    <div className="side-thread" ref={thread} aria-live="polite">
      {messages.map(({ question, answer }, index) => <div className="side-turn" key={index}>
        <div className="user-message">{question}</div>
        {answer && <><div className="agent-text"><Markdown disallowedElements={["img"]}
          components={{ a: ({ children }) => <span>{children}</span> }}>{answer}</Markdown></div>
          <button className="composer-control" type="button" onClick={() => insert(quoteText(answer))}>Вставить в основной чат</button></>}
      </div>)}
      {busy && <p className="subtle">Агент отвечает…</p>}
      {error && <p className="connect-error" role="alert">{error}</p>}
    </div>
    <form className="side-compose" onSubmit={event => { event.preventDefault(); void ask(); }}>
      {warning && <div className="secret-warning" role="alert"><span>Похоже, в сообщении ключ или пароль.</span>
        <button type="button" className="composer-control" onClick={() => { setDraft(maskSecrets(draft)); setWarning(false); }}>Заменить на ***</button>
        <button type="button" className="composer-control" onClick={() => void ask(true)}>Отправить как есть</button></div>}
      <textarea aria-label="Сообщение в боковой чат" placeholder="Задайте быстрый вопрос" value={draft}
        onChange={event => setDraft(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); }
        }} />
      <div><span className="subtle"><Icon name="eye" />Только чтение</span>
        <button type="submit" className="small-button" aria-label="Отправить в боковой чат" disabled={!draft.trim() || !model || busy || !api.askSide}><Icon name="send" /></button></div>
      {!api.askSide && <p className="subtle">Боковой чат доступен в приложении для компьютера.</p>}
    </form>
  </section>;
}
