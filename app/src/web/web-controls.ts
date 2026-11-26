import type { Availability, createDemo } from "./demo-api";

const release = "https://github.com/danielleonov1488-ship-it/vsemkod/releases/latest";
const themeSelect = '.settings-content select[aria-label="Тема"]';
const connectButton = 'button[aria-label^="Подключить "]';
const connectSelector = `.model-picker ${connectButton}, .settings-panel ${connectButton}`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className: string, text: string) {
  const node = element("button", className, text);
  node.type = "button";
  return node;
}

function download(className: string) {
  const link = element("a", className, "Скачать");
  link.href = release;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const agent = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod/i.test(agent) || (/Macintosh/i.test(agent) && navigator.maxTouchPoints > 1);
  const platform = /Macintosh|Mac OS X/i.test(agent) ? "macOS" : /Linux/i.test(agent) ? "Linux" : "Windows";
  link.setAttribute("aria-label", mobile ? "Скачать на компьютер" : "Скачать для " + platform);
  return link;
}

let desktopDialog: HTMLDialogElement | undefined;
export function showDesktop() {
  if (!desktopDialog) {
    const dialog = element("dialog", "connect-dialog harness-dialog");
    const title = element("h2", "", "Это доступно в приложении");
    title.id = "desktop-only-title";
    dialog.setAttribute("aria-labelledby", title.id);
    const dismiss = button("composer-control", "Закрыть");
    dismiss.addEventListener("click", () => dialog.close());
    const actions = element("div", "harness-dialog-actions");
    actions.append(download("small-button"), dismiss);
    dialog.append(title, element("p", "subtle", "Скачай vsemkod, чтобы работать с папками, терминалом и своими моделями."), actions);
    document.body.append(dialog);
    desktopDialog = dialog;
  }
  if (!desktopDialog.open) desktopDialog.showModal();
}

export function installWebControls(root: HTMLElement, demo: ReturnType<typeof createDemo>) {
  const toolbar = element("div", "harness-toolbar");
  const menu = button("harness-menu composer-control", "Меню");
  menu.setAttribute("aria-label", "Чаты и настройки");
  menu.setAttribute("aria-expanded", "false");
  menu.setAttribute("aria-controls", "harness-sidebar");
  const chip = element("span", "harness-chip", "Чаты не сохраняются");
  const counter = element("span", "harness-counter");
  counter.setAttribute("role", "status");
  counter.hidden = true;
  toolbar.append(chip, counter, download("harness-download small-button"));
  const scrim = button("harness-scrim", "");
  scrim.setAttribute("aria-label", "Закрыть меню");
  scrim.tabIndex = -1;
  const banner = element("div", "harness-banner");
  banner.append(element("span", "", "Демо в браузере · настройки работают в приложении"), download("text-link"));
  let availability: Availability = {};
  let frame = 0;
  let announcedReady = false;

  function drawer(open: boolean) {
    root.toggleAttribute("data-menu-open", open);
    menu.setAttribute("aria-expanded", String(open));
    if (open) root.querySelector<HTMLElement>(".sidebar-row--new")?.focus();
  }
  menu.onclick = () => drawer(!root.hasAttribute("data-menu-open"));
  scrim.onclick = () => { drawer(false); menu.focus(); };
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && root.hasAttribute("data-menu-open")) { drawer(false); menu.focus(); }
  });
  matchMedia("(max-width: 760px)").addEventListener("change", () => drawer(false));

  function syncTheme() {
    const select = root.querySelector<HTMLSelectElement>(themeSelect);
    const theme = demo.theme();
    if (select && (theme === "light" || theme === "dark") && select.value !== theme) {
      select.value = theme;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function setAvailability(state: Availability) {
    availability = state;
    counter.hidden = state.remaining === undefined;
    counter.textContent = state.remaining === undefined ? "" : "Осталось: " + state.remaining;
    root.toggleAttribute("data-demo-closed", Boolean(state.closed));
    schedule();
  }

  function enhance() {
    frame = 0;
    const titlebar = root.querySelector(".titlebar");
    const sidebar = root.querySelector(".sidebar");
    if (sidebar) sidebar.id = "harness-sidebar";
    if (titlebar && toolbar.parentElement !== titlebar) titlebar.append(menu, toolbar);
    if (sidebar && scrim.parentElement !== sidebar.parentElement) sidebar.after(scrim);
    const settings = root.querySelector(".settings-workspace .chat-header");
    if (settings && banner.previousElementSibling !== settings) settings.after(banner);
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>(
      `.settings-content :is(input, select, textarea, button):not(${themeSelect}, ${connectButton}, .subscription-link), .auto-model input`
    )) {
      control.disabled = true;
    }
    const systemTheme = root.querySelector<HTMLOptionElement>(themeSelect + ' option[value="system"]');
    if (systemTheme) systemTheme.hidden = true;
    syncTheme();

    const input = root.querySelector<HTMLTextAreaElement>(".composer-input");
    if (input) {
      input.maxLength = 2000;
      input.readOnly = Boolean(availability.closed) || document.documentElement.hasAttribute("data-scenario");
      if (availability.closed) input.placeholder = "Живой чат недоступен";
    }
    const composer = root.querySelector(".composer");
    if (availability.closed && composer && !composer.querySelector(".harness-closed")) {
      const card = element("div", "harness-closed");
      card.append(element("span", "", availability.closed), download("text-link"));
      composer.prepend(card);
    }
    for (const code of root.querySelectorAll<HTMLElement>(".agent-text pre > code")) {
      const pre = code.parentElement!;
      if (pre.querySelector(".harness-copy")) continue;
      const copy = button("composer-control harness-copy", "Копировать");
      copy.addEventListener("click", () => {
        void demo.api.copyText(code.textContent ?? "").then(
          () => demo.notices.emit({ text: "Скопировано" }),
          () => demo.notices.emit({ text: "Не удалось скопировать код.", tone: "error" })
        );
      });
      pre.append(copy);
    }
    for (const label of root.querySelectorAll<HTMLElement>(".model-picker button.model-option:not([aria-pressed]) > :is(.connect-label, .subtle)")) {
      label.setAttribute("data-app-only", "");
      label.parentElement?.setAttribute("aria-description", "Доступно в приложении");
    }
    if (!announcedReady && sidebar?.querySelector(".group-name")) {
      announcedReady = true;
      if (parent !== window) parent.postMessage({ type: "vsemkod:ready" }, location.origin);
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(enhance);
  }

  // These are browser-only controls on top of the shared, independently mounted renderer.
  new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
  root.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(connectSelector)) {
      event.stopPropagation();
      event.preventDefault();
      const picker = event.target.closest(".model-picker");
      picker?.querySelector<HTMLButtonElement>('.model-trigger[aria-expanded="true"]')?.click();
      showDesktop();
      return;
    }
    if (event.target.closest(".sidebar :is(.sidebar-row--new, .wordmark, .conversation, .group-new, .sidebar-end button)")) {
      drawer(false);
    }
  }, true);
  root.addEventListener("submit", event => {
    if (availability.closed && event.target instanceof Element && event.target.matches(".composer")) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  return { setAvailability, syncTheme };
}
