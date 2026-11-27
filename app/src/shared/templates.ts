/** Шаблоны новых проектов: папка + AGENTS.md с правилами + первая задача агенту. */
export type ProjectTemplate = {
  id: string; title: string; description: string; folder: string;
  /** Иконка из icons.tsx. */
  icon: "globe" | "telegram" | "subscription" | "image" | "code" | "bolt" | "file" | "terminal";
  prompt: string; agents: string; skills?: string[];
};

const common = [
  "- Общайся со мной по-русски, коротко и без жаргона: я могу не быть программистом.",
  "- Все тексты интерфейса — на русском.",
  "- Делай рабочую версию маленькими шагами и после каждого шага проверяй, что всё запускается.",
  "- В конце работы напиши, как запустить проект, одной-двумя командами.",
  "- Не добавляй платные сервисы и ключи без моего согласия."
].join("\n");

const web = [
  "- Сайт должен открываться во встроенном браузере vsemkod: запусти локальный сервер (например `npx serve .` или `npm run dev`) и дай ссылку localhost.",
  "- Вёрстка адаптивная: телефон, планшет, компьютер. Проверь на ширине 375 px.",
  "- Никаких заглушек lorem ipsum: придумай правдоподобные тексты по теме."
].join("\n");

export const projectTemplates: ProjectTemplate[] = [
  {
    id: "landing", title: "Лендинг", description: "Одностраничный сайт с формой заявки", folder: "landing", icon: "globe", skills: ["frontend-design"],
    prompt: "Сделай современный одностраничный сайт-лендинг. Сначала спроси меня в одном сообщении: о чём сайт (продукт или услуга), для кого и какой стиль нравится. Если я не отвечу подробно — придумай сам. Структура: первый экран с заголовком и кнопкой, преимущества, как это работает, отзывы, цены, частые вопросы, форма заявки (имя, телефон, сообщение) с проверкой полей и сообщением «Спасибо». Только HTML, CSS и JavaScript без сборки. Запусти и покажи результат во встроенном браузере.",
    agents: "# Лендинг\n\nПростой статический сайт: index.html, styles.css, script.js, папка assets.\n\n" + common + "\n" + web + "\n- Без фреймворков и сборки, чтобы сайт можно было выложить на любой хостинг.\n"
  },
  {
    id: "telegram-bot", title: "Telegram-бот", description: "Бот на Python с командами и кнопками", folder: "telegram-bot", icon: "telegram",
    prompt: "Сделай Telegram-бота на Python (библиотека aiogram 3). Спроси меня, что бот должен делать; если я не уточню — сделай бота-помощника с командами /start и /help, меню из кнопок и простым опросом. Токен бота читай из файла .env (переменная BOT_TOKEN) и создай .env.example. Объясни по шагам, как получить токен у @BotFather, как установить зависимости (requirements.txt) и запустить бота. Проверь, что код запускается без ошибок (python -m py_compile).",
    agents: "# Telegram-бот\n\nPython 3.11+, aiogram 3, файлы: bot.py, requirements.txt, .env.example, README.md.\n\n" + common + "\n- Секреты только в .env, .env добавь в .gitignore.\n- Если Python не установлен — объясни, как поставить с python.org, и остановись.\n"
  },
  {
    id: "shop", title: "Интернет-магазин", description: "Каталог, корзина и оформление заказа", folder: "shop", icon: "subscription", skills: ["frontend-design"],
    prompt: "Сделай витрину интернет-магазина без сервера: каталог товаров с фильтрами и поиском, карточка товара, корзина (сохраняется в localStorage), оформление заказа с формой и итоговой суммой. Товары — в отдельном файле products.json (12 правдоподобных товаров на тему, которую я назову; если не назову — магазин кофе). React + Vite. Запусти и покажи во встроенном браузере.",
    agents: "# Интернет-магазин\n\nReact + Vite, без бэкенда, данные в products.json, корзина в localStorage.\n\n" + common + "\n" + web + "\n- Если Node.js не установлен — объясни, как поставить с nodejs.org, и остановись.\n"
  },
  {
    id: "portfolio", title: "Портфолио", description: "Сайт-визитка с проектами и контактами", folder: "portfolio", icon: "image", skills: ["frontend-design"],
    prompt: "Сделай сайт-портфолио: обо мне, навыки, 6 проектов карточками с фильтром по типу, отзывы, контакты со ссылками на Telegram и почту, тёмная и светлая тема с переключателем. Спроси моё имя и чем я занимаюсь; если не отвечу — сделай портфолио дизайнера. Только HTML, CSS и JavaScript. Запусти и покажи во встроенном браузере.",
    agents: "# Портфолио\n\nСтатический сайт без сборки.\n\n" + common + "\n" + web + "\n"
  },
  {
    id: "game", title: "Браузерная игра", description: "Игра на HTML5 Canvas", folder: "game", icon: "bolt",
    prompt: "Сделай браузерную игру на HTML5 Canvas без библиотек. Предложи три идеи (например, раннер, арканоид, змейка с усилениями) и сразу сделай первую, если я не выберу. Нужны: меню, счёт, рекорд в localStorage, звуки (Web Audio), пауза, экран «Игра окончена», управление с клавиатуры и касанием на телефоне. Запусти и покажи во встроенном браузере.",
    agents: "# Браузерная игра\n\nindex.html + game.js + style.css, Canvas 2D, без зависимостей.\n\n" + common + "\n" + web + "\n- Игра должна держать 60 кадров в секунду; не создавай объекты в каждом кадре без нужды.\n"
  },
  {
    id: "parser", title: "Парсер сайта", description: "Сбор данных со страниц в таблицу", folder: "parser", icon: "file",
    prompt: "Сделай парсер на Python, который собирает данные с сайта в таблицу CSV и Excel. Спроси, какой сайт и какие поля нужны; если не уточню — собери заголовки и ссылки новостей с https://news.ycombinator.com. Используй requests и BeautifulSoup, соблюдай паузы между запросами и robots.txt. Покажи первые 10 строк результата.",
    agents: "# Парсер\n\nPython 3.11+, requests, beautifulsoup4, openpyxl. Файлы: parser.py, requirements.txt, README.md.\n\n" + common + "\n- Уважай robots.txt и делай паузу не меньше секунды между запросами.\n- Если Python не установлен — объясни, как поставить с python.org, и остановись.\n"
  },
  {
    id: "webapp", title: "Веб-приложение", description: "React + Vite: задачи с сохранением", folder: "webapp", icon: "code", skills: ["frontend-design"],
    prompt: "Сделай веб-приложение на React + Vite + TypeScript: список задач с проектами, сроками, приоритетом, поиском, перетаскиванием и тёмной темой. Данные сохраняй в localStorage. Добавь несколько тестов на Vitest для логики. Запусти и покажи во встроенном браузере.",
    agents: "# Веб-приложение\n\nReact + Vite + TypeScript, Vitest для тестов.\n\n" + common + "\n" + web + "\n- Перед тем как сказать «готово», запусти `npm test` и `npm run build`.\n- Если Node.js не установлен — объясни, как поставить с nodejs.org, и остановись.\n"
  },
  {
    id: "empty", title: "Пустой проект", description: "Только папка — дальше сами", folder: "project", icon: "terminal",
    prompt: "", agents: "# Проект\n\n" + common + "\n"
  }
];

/** Имя папки: латиница, цифры и дефисы. */
export function templateFolderName(value: string) {
  const map: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
  return value.trim().toLowerCase().split("").map(char => map[char] ?? char).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
}
