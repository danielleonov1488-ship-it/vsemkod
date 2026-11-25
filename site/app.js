const RELEASE_URL = "https://github.com/danielleonov1488-ship-it/vsemkod/releases/latest";
const RELEASED = false;

const CATALOG_URL = "/catalog.json";
const FALLBACK_CATALOG_URL = "https://raw.githubusercontent.com/danielleonov1488-ship-it/vsemkod/main/catalog-bot/data/catalog.json";

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

async function fetchCatalog(url) {
  const response = await fetch(url, {
    cache: "no-cache",
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) {
    throw new Error(`Catalog HTTP ${response.status}`);
  }

  const catalog = await response.json();
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
  const grouped = new Map(topModels.map((model) => [model.id, { model, providers: new Map() }]));

  for (const offer of catalog.offers) {
    const group = grouped.get(offer.modelId);
    const providerName = providers.get(offer.providerId);
    if (offer.status !== "active" || !group || !providerName) continue;

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

async function renderCatalog() {
  const list = document.getElementById("model-list");
  const note = document.getElementById("catalog-note");
  const skeleton = document.getElementById("catalog-skeleton");
  list.append(skeleton.content.cloneNode(true));
  list.setAttribute("aria-busy", "true");

  try {
    const catalog = await fetchCatalog(CATALOG_URL).catch(() => fetchCatalog(FALLBACK_CATALOG_URL));
    const models = groupActiveModels(catalog);
    list.replaceChildren(...models.map(makeModelRow));

    const updatedAt = Date.parse(catalog.generatedAt);
    const age = Math.max(0, Math.floor((Date.now() - updatedAt) / 60_000));
    note.textContent = `${models.length ? "" : "Сейчас нет активных предложений для топовых моделей. "}Каталог обновлён ${age} мин назад · обновляется каждые 30 минут`;
  } catch {
    list.replaceChildren();
    const link = document.createElement("a");
    link.href = FALLBACK_CATALOG_URL;
    link.textContent = "Открыть JSON";
    note.replaceChildren("Не удалось загрузить каталог. ", link);
  } finally {
    list.removeAttribute("aria-busy");
    note.hidden = false;
  }
}

configureDownload();
renderCatalog();
