import { useEffect, useRef } from "react";
import { Icon } from "./icons";

/** Публикация в один клик: агент получает подробную задачу и сам собирает, выкладывает и присылает ссылку. */
export const publishTargets = [
  {
    id: "cloudflare", title: "Сайт в интернет", detail: "Cloudflare Pages · бесплатно",
    prompt: [
      "Опубликуй этот проект как сайт на Cloudflare Pages.",
      "1. Определи, что публиковать: если в package.json есть скрипт build — запусти сборку и возьми папку результата (dist, build или out); иначе — папку, где лежит index.html.",
      "2. Проверь, что установлен Node.js (`node -v`). Если нет — объясни, как поставить его с nodejs.org, и остановись.",
      "3. Выполни `npx --yes wrangler pages deploy <папка> --project-name <название проекта латиницей>`. Если wrangler попросит войти — запусти `npx --yes wrangler login` и попроси меня подтвердить вход в открывшемся браузере (аккаунт Cloudflare бесплатный), потом повтори публикацию.",
      "4. В конце дай ссылку на сайт и коротко объясни, как обновить публикацию после изменений."
    ].join("\n")
  },
  {
    id: "vercel", title: "Сайт на Vercel", detail: "Для React, Next.js и Vite",
    prompt: [
      "Опубликуй этот проект на Vercel.",
      "1. Проверь, что установлен Node.js (`node -v`). Если нет — объясни, как поставить его с nodejs.org, и остановись.",
      "2. Проверь, что проект собирается (`npm run build`, если есть такой скрипт), и исправь ошибки сборки.",
      "3. Выполни `npx --yes vercel deploy --prod --yes`. Если нужен вход — попроси меня один раз выполнить `npx vercel login` в панели «Терминал» (там можно выбрать способ входа), потом повтори публикацию.",
      "4. В конце дай ссылку на сайт."
    ].join("\n")
  },
  {
    id: "github", title: "Отправить на GitHub", detail: "Репозиторий и история изменений",
    prompt: [
      "Отправь этот проект на GitHub.",
      "1. Если это ещё не git-репозиторий — выполни `git init`, создай подходящий .gitignore (node_modules, .env, dist и т. п.) и сделай первый коммит с понятным сообщением на русском. Если репозиторий есть — закоммить текущие изменения.",
      "2. Проверь GitHub CLI: `gh --version` и `gh auth status`. Если он установлен и вход выполнен — создай приватный репозиторий: `gh repo create <название> --private --source . --push`.",
      "3. Если gh нет — объясни, как установить его с cli.github.com и войти командой `gh auth login`, либо как создать репозиторий на github.com и выполнить `git remote add origin …` и `git push -u origin HEAD`.",
      "4. Никогда не отправляй файлы с ключами и паролями (.env и подобные) — проверь это перед push.",
      "5. В конце дай ссылку на репозиторий."
    ].join("\n")
  }
] as const;

export function PublishMenu({ open, toggle, close, publish, disabled }: {
  open: boolean; toggle: () => void; close: () => void; publish: (prompt: string) => void; disabled?: boolean;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open, close]);
  return <div className="publish-menu" ref={wrapper}>
    <button type="button" className="panel-icon-button" aria-label="Опубликовать" aria-expanded={open} data-tip="Опубликовать"
      disabled={disabled} onClick={toggle}><Icon name="globe" /></button>
    {open && <div className="model-panel panel-popup publish-popup" role="menu" aria-label="Опубликовать">
      <p className="publish-title">Опубликовать проект</p>
      {publishTargets.map(target => <button key={target.id} type="button" role="menuitem" className="model-option" onClick={() => { close(); publish(target.prompt); }}>
        <span className="model-copy"><span className="model-name">{target.title}</span><span className="model-description">{target.detail}</span></span>
      </button>)}
      <p className="publish-note">Агент соберёт проект, выложит его и пришлёт ссылку. Для входа в сервис откроется браузер.</p>
    </div>}
  </div>;
}
