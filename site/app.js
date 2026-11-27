export const DEMO_API = "https://vsemkod-demo.vsemkod.workers.dev";
export const TURNSTILE_SITEKEY = "0x4AAAAAAGSiofqewQIBBTcx";
const RELEASE_URL = "https://github.com/danielleonov1488-ship-it/vsemkod/releases/latest";
const RELEASED = true;
// Постоянные ссылки: GitHub сам отдаёт файл из последнего релиза.
const DOWNLOAD_URL = RELEASE_URL + "/download/";
const ASSETS = {
  Windows: "vsemkod-windows-x64.exe",
  macOS: "vsemkod-macos-arm64.dmg",
  macOSIntel: "vsemkod-macos-x64.dmg",
  Linux: "vsemkod-linux-x86_64.AppImage",
};

const CATALOG_URL = "/catalog.json";
const CHANGES_URL = "/changes.json";
const FALLBACK_DATA_URL = "https://raw.githubusercontent.com/danielleonov1488-ship-it/vsemkod/main/catalog-bot/data/";
const THEME_KEY = "vsemkod-theme";
const LOGOS = {
  "Moonshot AI": "kimi",
  "DeepSeek": "deepseek",
  "Z.ai": "zai",
  "Alibaba": "qwen",
  "MiniMax": "minimax",
  "Xiaomi": "xiaomimimo",
  "NVIDIA": "nvidia",
  "OpenAI": "openai",
  "Google": "gemma",
};

function sendTheme(frame) {
  frame.contentWindow?.postMessage({
    type: "vsemkod:theme",
    theme: document.documentElement.dataset.theme,
  }, location.origin);
}

function configureTheme() {
  const root = document.documentElement;
  const toggle = document.getElementById("theme-toggle");
  const themeColor = document.querySelector('meta[name="theme-color"]');

  function updateLabel() {
    const label = root.dataset.theme === "light" ? "Включить тёмную тему" : "Включить светлую тему";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  }

  function setTheme(theme) {
    if (!["dark", "light"].includes(theme) || root.dataset.theme === theme) return;
    root.dataset.theme = theme;
    themeColor.content = theme === "light" ? "#F5F4F0" : "#0F1112";
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
    updateLabel();
    document.querySelectorAll("[data-preview] iframe").forEach(sendTheme);
  }

  toggle.hidden = false;
  updateLabel();
  toggle.addEventListener("click", () => setTheme(root.dataset.theme === "light" ? "dark" : "light"));
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_KEY) setTheme(event.newValue);
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data?.type !== "vsemkod:theme") return;
    const frames = [...document.querySelectorAll("[data-preview] iframe")];
    if (frames.some((frame) => frame.contentWindow === event.source)) setTheme(event.data.theme);
  });
}

function configureHeader() {
  const header = document.getElementById("site-header");
  const menu = document.getElementById("menu-toggle");
  const nav = document.getElementById("site-nav");
  const mobile = matchMedia("(max-width: 840px)");

  function setMenu(open) {
    header.classList.toggle("menu-active", open);
    menu.setAttribute("aria-expanded", String(open));
    menu.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
  }

  function updateScroll() {
    header.classList.toggle("scrolled", window.scrollY > 8);
  }

  document.body.classList.add("header-ready");
  menu.hidden = false;
  requestAnimationFrame(updateScroll);
  window.addEventListener("scroll", updateScroll, { passive: true });
  menu.addEventListener("click", () => setMenu(!header.classList.contains("menu-active")));
  nav.addEventListener("click", (event) => {
    if (event.target.closest("a") && mobile.matches) {
      menu.focus();
      setMenu(false);
    }
  });
  document.addEventListener("click", (event) => {
    if (!header.contains(event.target)) setMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && header.classList.contains("menu-active")) {
      setMenu(false);
      menu.focus();
    }
  });
  mobile.addEventListener("change", () => setMenu(false));
}

function configureReveal(motion) {
  if (motion.matches || !("IntersectionObserver" in window)) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("reveal-in");
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -16px 0px" });

  document.querySelectorAll("[data-reveal]").forEach((item) => observer.observe(item));
}

const INSTALL_COMMANDS = {
  Windows: "irm https://vsemkod.ru/install.ps1 | iex",
  macOS: "curl -fsSL https://vsemkod.ru/install.sh | sh",
  Linux: "curl -fsSL https://vsemkod.ru/install.sh | sh"
};

// Команда установки из терминала: без окна SmartScreen и Gatekeeper.
function configureInstallCommand(platform, mobile) {
  const line = document.getElementById("install-line");
  const code = document.getElementById("install-command");
  const button = document.getElementById("install-copy");
  const status = document.getElementById("install-copy-status");
  if (!line || !code || !button) return;
  if (mobile || !RELEASED) { line.hidden = true; return; }
  code.textContent = INSTALL_COMMANDS[platform];
  let timer;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.classList.add("is-copied");
      button.querySelector("use")?.setAttribute("href", "#i-copied");
      status.textContent = "Команда скопирована. Вставьте её в " + (platform === "Windows" ? "PowerShell" : "Терминал") + ".";
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.classList.remove("is-copied");
        button.querySelector("use")?.setAttribute("href", "#i-copy");
        status.textContent = "";
      }, 1800);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
  });
}

function configureDownload(motion) {
  const agent = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod/i.test(agent) ||
    (/Macintosh/i.test(agent) && navigator.maxTouchPoints > 1);
  const platform = /Macintosh|Mac OS X/i.test(agent) ? "macOS" : /Linux/i.test(agent) ? "Linux" : "Windows";
  const label = mobile ? "Скачать на компьютер" : `Скачать для ${platform}`;
  const download = document.getElementById("step-download");
  const status = document.getElementById("step-download-status");

  const direct = RELEASED && !mobile;
  const setLinks = (asset) => {
    document.querySelectorAll("[data-release]").forEach((link) => { link.href = direct ? DOWNLOAD_URL + asset : RELEASE_URL; });
  };
  setLinks(ASSETS[platform]);
  // Chromium на Mac умеет сказать архитектуру; Safari — нет, там Apple Silicon по умолчанию, Intel — в «Все загрузки».
  if (direct && platform === "macOS") {
    navigator.userAgentData?.getHighEntropyValues?.(["architecture"])
      .then(({ architecture }) => { if (architecture === "x86") setLinks(ASSETS.macOSIntel); })
      .catch(() => {});
  }
  configureInstallCommand(platform, mobile);
  document.getElementById("platform-label").textContent = label;
  document.getElementById("step-download-label").textContent = label;
  document.getElementById("release-status").hidden = RELEASED;
  if (RELEASED) document.getElementById("platform-download").removeAttribute("aria-describedby");

  download.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || motion.matches) return;
    event.preventDefault();
    if (download.classList.contains("is-opening")) return;
    download.classList.add("is-opening");
    status.textContent = direct ? "Начинаем загрузку." : "Открываем страницу релиза.";
    setTimeout(() => {
      download.classList.remove("is-opening");
      status.textContent = "";
      location.assign(download.href);
    }, 500);
  });
}

function configureStory(motion) {
  const hero = document.querySelector(".hero-window");
  const section = document.getElementById("features");
  const preview = section.querySelector(".feature-preview");
  const items = [...section.querySelectorAll(".feature-item")];
  const mobile = matchMedia("(max-width: 760px)");
  const frameTemplate = document.getElementById("harness-frame").content.firstElementChild;
  const harnessPath = frameTemplate.getAttribute("src");
  const SHOTS = { edit: "panel-changes", revert: "chat", modes: "home", failover: "settings-models", subscriptions: "settings-models", mcp: "settings-mcp" };
  let available = false;
  let active = -1;
  let queued = false;

  const sendScenario = (frame, id) => frame.contentWindow?.postMessage({ type: "vsemkod:scenario", id }, location.origin);

  function syncFrame(frame) {
    sendTheme(frame);
    const id = frame.parentElement.dataset.scenario;
    if (id) sendScenario(frame, id);
  }

  function mountFrame(host, scenario) {
    if (!available || host.querySelector("iframe")) return;
    const frame = frameTemplate.cloneNode();
    if (scenario) {
      frame.src = `${harnessPath}?scenario=${scenario}`;
      frame.loading = "lazy";
      frame.tabIndex = -1;
      frame.inert = true;
      frame.title = "Сценарий в приложении vsemkod";
      frame.setAttribute("aria-hidden", "true");
    }
    frame.addEventListener("load", () => {
      host.classList.remove("is-live");
      try {
        if (!frame.contentWindow.location.pathname.startsWith(harnessPath) || frame.contentDocument.querySelector(".not-found")) return;
        syncFrame(frame);
        host.classList.add("is-live");
      } catch {
        // Навигация за пределы копии оставляет картинку на месте.
      }
    });
    host.append(frame);
  }

  function select(index, progress) {
    if (index !== active) {
      items[active]?.removeAttribute("aria-current");
      items[index].setAttribute("aria-current", "true");
      active = index;
      const id = items[index].dataset.scenario;
      preview.dataset.scenario = id;
      preview.querySelectorAll(".themed-shot img").forEach((img) => {
        img.src = `/assets/d-${img.classList.contains("show-light") ? "light" : "dark"}-${SHOTS[id]}.webp`;
      });
      const frame = preview.querySelector("iframe");
      if (frame && preview.classList.contains("is-live")) sendScenario(frame, id);
    }
    items.forEach((item, i) => item.style.setProperty("--progress", i === index ? (motion.matches ? "1" : progress.toFixed(3)) : "0"));
  }

  const clamp = (value) => Math.min(1, Math.max(0, value));

  function update() {
    const rect = section.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < window.innerHeight) mountFrame(preview, items[Math.max(0, active)].dataset.scenario);
    if (mobile.matches) { if (active < 0) select(0, 1); return; }
    const header = document.getElementById("site-header").offsetHeight;
    const travel = rect.height - (window.innerHeight - header);
    const progress = clamp((header - rect.top) / Math.max(1, travel)) * items.length;
    const index = Math.min(items.length - 1, Math.floor(progress));
    select(index, clamp(progress - index));
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }

  items.forEach((item, index) => item.addEventListener("click", () => {
    if (mobile.matches) { select(index, 1); return; }
    const header = document.getElementById("site-header").offsetHeight;
    const top = section.getBoundingClientRect().top + window.scrollY;
    const travel = section.offsetHeight - (window.innerHeight - header);
    window.scrollTo({ top: top - header + travel * (index + 0.5) / items.length, behavior: motion.matches ? "auto" : "smooth" });
  }));

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data?.type !== "vsemkod:ready") return;
    const frame = [...document.querySelectorAll("[data-preview] iframe")].find((candidate) => candidate.contentWindow === event.source);
    if (frame) syncFrame(frame);
  });
  schedule();

  fetch(harnessPath, { method: "HEAD", signal: AbortSignal.timeout(5000) })
    .then((response) => {
      available = response.ok && response.headers.get("content-type")?.includes("text/html") && new URL(response.url).pathname.startsWith(harnessPath);
      mountFrame(hero);
      schedule();
    })
    .catch(() => {});
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: "no-cache",
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) {
    throw new Error(`Catalog HTTP ${response.status}`);
  }

  return response.json();
}

async function fetchCatalog(url) {
  const catalog = await fetchJson(url);
  if (
    !catalog ||
    !Array.isArray(catalog.models) ||
    !Array.isArray(catalog.providers) ||
    !Array.isArray(catalog.offers) ||
    !Number.isFinite(Date.parse(catalog.generatedAt))
  ) {
    throw new Error("Invalid catalog format");
  }
  return catalog;
}

function groupActiveModels(catalog) {
  const providers = new Map(catalog.providers.map((provider) => [provider.id, provider.name]));
  const available = catalog.models
    .filter((model) => ["top", "good", "new"].includes(model.tier))
    .sort((first, second) => first.rank - second.rank);
  const grouped = new Map(available.map((model) => [model.id, { model, providers: new Set(), activeProviderIds: new Set() }]));

  for (const offer of catalog.offers) {
    const group = grouped.get(offer.modelId);
    const providerName = providers.get(offer.providerId);
    if (offer.status !== "active" || !group || !providerName) continue;
    group.activeProviderIds.add(offer.providerId);
    group.providers.add(providerName);
  }

  return [...grouped.values()].filter((group) => group.providers.size > 0);
}

function makeModelCard({ model, providers }) {
  const card = document.createElement("li");
  card.className = "model-card";
  const logoName = Object.hasOwn(LOGOS, model.vendor)
    ? LOGOS[model.vendor]
    : /^(xiaomi-)?mimo/i.test(model.id) ? "xiaomimimo" : "";
  if (logoName) {
    const logo = document.createElement("img");
    logo.className = ["kimi", "zai", "xiaomimimo", "openai"].includes(logoName) ? "model-logo mono-logo" : "model-logo";
    logo.src = `/assets/logos/${logoName}.svg`;
    logo.alt = "";
    logo.width = logo.height = 28;
    card.append(logo);
  }

  const copy = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = model.name;
  const description = document.createElement("p");
  description.textContent = `Бесплатно у ${[...providers].join(", ")}`;
  copy.append(title, description);
  card.append(copy);
  return card;
}

function makeNewCard(count) {
  const card = document.createElement("li");
  card.className = "model-card new-models";
  const title = document.createElement("h3");
  title.textContent = `+${count} новых`;
  const caption = document.createElement("p");
  caption.textContent = "Модели в каталоге";
  card.append(title, caption);
  return card;
}

function renderRails(rails, cards) {
  for (const offset of [0, 1]) {
    const items = cards.filter((_, index) => index % 2 === offset);
    if (!items.length) continue;
    const rail = document.createElement("div");
    rail.className = "model-rail";
    const track = document.createElement("div");
    track.className = "rail-track";
    const group = document.createElement("ul");
    group.className = "rail-group";
    group.setAttribute("role", "list");
    group.append(...items);
    const clone = group.cloneNode(true);
    clone.classList.add("rail-clone");
    clone.setAttribute("aria-hidden", "true");
    track.append(group, clone);
    rail.append(track);
    rails.append(rail);
  }
}

function configureRails(rails) {
  const observer = new IntersectionObserver(([entry]) => {
    rails.classList.toggle("is-visible", entry.isIntersecting);
  });
  observer.observe(rails);
}

async function renderAnnouncement(models) {
  const changes = await fetchJson(CHANGES_URL).catch(() => fetchJson(FALLBACK_DATA_URL + "changes.json"));
  if (!Array.isArray(changes)) return;

  const active = new Map(models.map((group) => [group.model.id, group]));
  const latest = changes
    .filter((change) => {
      const group = active.get(change?.modelId);
      return change?.type === "offer_added" && group && Number.isFinite(Date.parse(change.date)) &&
        group.activeProviderIds.has(change.providerId);
    })
    .sort((first, second) => Date.parse(second.date) - Date.parse(first.date))[0];
  if (!latest) return;

  document.getElementById("announcement-label").textContent = `Новая раздача: ${active.get(latest.modelId).model.name} бесплатно`;
  document.getElementById("announcement").href = "#models";
}

async function renderCatalog() {
  const rails = document.getElementById("model-rails");
  const note = document.getElementById("catalog-note");
  const fallback = FALLBACK_DATA_URL + "catalog.json";

  try {
    const catalog = await fetchCatalog(CATALOG_URL).catch(() => fetchCatalog(fallback));
    const models = groupActiveModels(catalog);
    const cards = models.filter(({ model }) => model.tier !== "new").map(makeModelCard);
    const newCount = models.filter(({ model }) => model.tier === "new").length;
    if (newCount) cards.push(makeNewCard(newCount));
    if (cards.length) {
      renderRails(rails, cards);
      configureRails(rails);
    } else {
      note.textContent = "Сейчас в каталоге нет активных раздач.";
    }

    const updated = document.getElementById("catalog-updated");
    const dateFormat = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" });
    updated.dateTime = catalog.generatedAt;
    updated.textContent = `Каталог обновлён ${dateFormat.format(new Date(catalog.generatedAt))}`;
    updated.hidden = false;

    renderAnnouncement(models.filter(({ model }) => model.tier === "top")).catch(() => {});
  } catch {
    rails.replaceChildren();
    const link = document.createElement("a");
    link.href = fallback;
    link.textContent = "Открыть JSON";
    note.replaceChildren("Не удалось загрузить каталог. ", link);
  } finally {
    rails.removeAttribute("aria-busy");
    note.hidden = !note.textContent;
  }
}

if (document.getElementById("site-header")) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  configureTheme();
  configureHeader();
  configureDownload(motion);
  configureReveal(motion);
  configureStory(motion);
  renderCatalog();
}
