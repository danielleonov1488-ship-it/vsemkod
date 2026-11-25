const DEMO_API = "";
const TURNSTILE_SITEKEY = "0x4AAAAAAGSiofqewQIBBTcx";
const RELEASE_URL = "https://github.com/danielleonov1488-ship-it/vsemkod/releases/latest";
const RELEASED = false;

import { configureDemo } from "./demo.js";

const CATALOG_URL = "/catalog.json";
const CHANGES_URL = "/changes.json";
const FALLBACK_DATA_URL = "https://raw.githubusercontent.com/danielleonov1488-ship-it/vsemkod/main/catalog-bot/data/";

function configureTheme() {
  const root = document.documentElement;
  const toggle = document.getElementById("theme-toggle");
  const themeColor = document.querySelector('meta[name="theme-color"]');

  function updateLabel() {
    const label = root.dataset.theme === "light" ? "Включить тёмную тему" : "Включить светлую тему";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  }

  toggle.hidden = false;
  updateLabel();
  toggle.addEventListener("click", () => {
    const theme = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = theme;
    themeColor.content = getComputedStyle(root).getPropertyValue("--bg").trim();
    try { localStorage.setItem("vsemkod-theme", theme); } catch {}
    updateLabel();
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
    for (const [index, entry] of entries.entries()) {
      if (!entry.isIntersecting) {
        if (!entry.target.matches(":target")) entry.target.classList.add("awaiting-reveal");
        continue;
      }
      entry.target.style.transitionDelay = `${Math.min(index, 3) * 45}ms`;
      entry.target.classList.remove("awaiting-reveal");
      observer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -5% 0px" });

  for (const section of document.querySelectorAll("[data-reveal]")) {
    observer.observe(section);
  }

  motion.addEventListener("change", () => {
    if (!motion.matches) return;
    observer.disconnect();
    document.querySelectorAll(".awaiting-reveal").forEach((section) => section.classList.remove("awaiting-reveal"));
  }, { once: true });
}

function configureFeatures(motion) {
  const track = document.getElementById("feature-track");
  const cards = [...track.children];
  const tabs = [...document.querySelectorAll(".feature-tabs button")];
  const previous = document.getElementById("previous-feature");
  const next = document.getElementById("next-feature");
  let active = 0;
  let settleTimer;

  function markActive(index) {
    active = index;
    tabs.forEach((tab, position) => tab.setAttribute("aria-pressed", String(position === index)));
    previous.disabled = index === 0;
    next.disabled = index === cards.length - 1;
  }

  function select(index) {
    const card = cards[index];
    if (!card) return;
    markActive(index);
    const offset = card.getBoundingClientRect().left - track.getBoundingClientRect().left;
    track.scrollTo({
      left: track.scrollLeft + offset - (track.clientWidth - card.offsetWidth) / 2,
      behavior: motion.matches ? "instant" : "smooth",
    });
  }

  function syncActiveCard() {
    const center = track.getBoundingClientRect().left + track.clientWidth / 2;
    const distances = cards.map((card) => Math.abs(card.getBoundingClientRect().left + card.offsetWidth / 2 - center));
    markActive(distances.indexOf(Math.min(...distances)));
  }

  if ("onscrollend" in track) {
    track.addEventListener("scrollend", syncActiveCard);
  } else {
    track.addEventListener("scroll", () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(syncActiveCard, 250);
    }, { passive: true });
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(index));
    tab.addEventListener("keydown", (event) => {
      const jump = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (!jump) return;
      event.preventDefault();
      const picked = (index + jump + tabs.length) % tabs.length;
      tabs[picked].focus();
      select(picked);
    });
  });
  track.addEventListener("keydown", (event) => {
    const jump = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!jump) return;
    event.preventDefault();
    select(active + jump);
  });
  previous.addEventListener("click", () => select(active - 1));
  next.addEventListener("click", () => select(active + 1));
  document.getElementById("demo-settings").addEventListener("click", () => select(3));
}


function configureDownload() {
  const agent = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod/i.test(agent) ||
    (/Macintosh/i.test(agent) && navigator.maxTouchPoints > 1);
  let platform = "Windows";

  if (!mobile && /Macintosh|Mac OS X/i.test(agent)) {
    platform = "macOS";
  } else if (!mobile && /Linux/i.test(agent)) {
    platform = "Linux";
  }

  document.querySelectorAll("[data-release]").forEach((link) => {
    link.href = RELEASE_URL;
  });
  document.getElementById("platform-label").textContent = `Скачать для ${platform}`;
  document.getElementById("release-status").hidden = RELEASED;
  if (RELEASED) {
    document.getElementById("platform-download").removeAttribute("aria-describedby");
  }
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
  const topModels = catalog.models
    .filter((model) => model.tier === "top")
    .sort((first, second) => first.rank - second.rank);
  const grouped = new Map(topModels.map((model) => [model.id, { model, providers: new Map(), activeProviderIds: new Set() }]));

  for (const offer of catalog.offers) {
    const group = grouped.get(offer.modelId);
    const providerName = providers.get(offer.providerId);
    if (offer.status !== "active" || !group || !providerName) continue;

    group.activeProviderIds.add(offer.providerId);
    if (!group.providers.has(providerName)) {
      group.providers.set(providerName, new Set());
    }
    if (offer.expiresAt && Number.isFinite(Date.parse(offer.expiresAt))) {
      group.providers.get(providerName).add(offer.expiresAt);
    }
  }

  return [...grouped.values()].filter((group) => group.providers.size > 0);
}

function makeModelRow({ model, providers }) {
  const row = document.createElement("li");
  row.className = "model-row";

  const info = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = model.name;
  const description = document.createElement("p");
  description.textContent = model.description;
  info.append(heading, description);

  const chips = document.createElement("div");
  chips.className = "provider-chips";
  const dateFormat = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  });

  for (const [name, expirations] of providers) {
    const chip = document.createElement("span");
    chip.className = "provider-chip";
    chip.textContent = name;

    for (const expiration of expirations) {
      const date = document.createElement("time");
      date.className = "offer-expiry";
      date.dateTime = expiration;
      date.textContent = `акция до ${dateFormat.format(new Date(expiration))}`;
      chip.append(" ", date);
    }
    chips.append(chip);
  }

  row.append(info, chips);
  return row;
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

async function renderCatalog(setCatalogModels) {
  const list = document.getElementById("model-list");
  const note = document.getElementById("catalog-note");
  const fallback = FALLBACK_DATA_URL + "catalog.json";

  try {
    const catalog = await fetchCatalog(CATALOG_URL).catch(() => fetchCatalog(fallback));
    const models = groupActiveModels(catalog);
    list.replaceChildren(...models.map(makeModelRow));

    const updated = document.getElementById("catalog-updated");
    const dateFormat = new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "medium", timeStyle: "short",
    });
    updated.dateTime = catalog.generatedAt;
    updated.textContent = `Последнее обновление · ${dateFormat.format(new Date(catalog.generatedAt))}`;
    updated.hidden = false;

    if (models.length === 0) note.textContent = "Сейчас нет активных предложений для топовых моделей.";
    setCatalogModels(catalog.models.filter((model) => model.tier === "top").sort((first, second) => first.rank - second.rank));
    renderAnnouncement(models).catch(() => {});
  } catch {
    list.replaceChildren();
    const link = document.createElement("a");
    link.href = fallback;
    link.textContent = "Открыть JSON";
    note.replaceChildren("Не удалось загрузить каталог. ", link);
  } finally {
    list.removeAttribute("aria-busy");
    note.hidden = !note.textContent;
  }
}

const motion = matchMedia("(prefers-reduced-motion: reduce)");
configureTheme();
configureHeader();
configureDownload();
configureReveal(motion);
configureFeatures(motion);
const setCatalogModels = configureDemo(DEMO_API, TURNSTILE_SITEKEY, motion);
renderCatalog(setCatalogModels);
