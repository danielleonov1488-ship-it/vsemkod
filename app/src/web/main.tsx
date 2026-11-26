import "../renderer/styles.css";
import "./web.css";
import { createDemo, readTheme, themeKey } from "./demo-api";
import { installWebControls, showDesktop } from "./web-controls";
import { preloadTurnstile } from "./transport";

// Внутри iframe на лендинге любой focus()/scrollIntoView() прокручивает и саму страницу сайта.
// Поэтому прокручиваем только контейнеры внутри копии приложения, а фокус ставим без прокрутки.
if (window.parent !== window) {
  const focus = HTMLElement.prototype.focus;
  // Сценарии в блоке «Что умеет» не забирают фокус у страницы, пока посетитель сам не щёлкнул по копии.
  let touched = !new URLSearchParams(location.search).has("scenario");
  for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, () => { touched = true; }, { capture: true, once: true });
  HTMLElement.prototype.focus = function (options?: FocusOptions) { if (touched) focus.call(this, { ...options, preventScroll: true }); };
  Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
    const options = typeof arg === "object" ? arg : { block: arg === false ? "end" : "start" } as ScrollIntoViewOptions;
    let box = this.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (!box) return;
    const target = this.getBoundingClientRect();
    const frame = box.getBoundingClientRect();
    const block = options.block ?? "start";
    let delta = 0;
    if (block === "start") delta = target.top - frame.top;
    else if (block === "end") delta = target.bottom - frame.bottom;
    else if (block === "center") delta = target.top + target.height / 2 - (frame.top + frame.height / 2);
    else if (target.top < frame.top) delta = target.top - frame.top;
    else if (target.bottom > frame.bottom) delta = target.bottom - frame.bottom;
    if (delta) box.scrollBy({ top: delta, behavior: options.behavior === "smooth" ? "smooth" : "auto" });
  };
}

const scenario = new URLSearchParams(location.search).get("scenario");
const root = document.querySelector<HTMLElement>("#root")!;
const demo = createDemo({ scenario: Boolean(scenario), showDesktop, setAvailability: state => controls.setAvailability(state) });
const controls = installWebControls(root, demo);
window.vsemkod = demo.api;
demo.applyTheme(readTheme(), false);

if (scenario) {
  document.documentElement.dataset.scenario = "";
} else {
  root.addEventListener("focusin", event => {
    if (!(event.target instanceof Element) || !event.target.matches(".composer-input")) return;
    void preloadTurnstile().catch(() => {});
  });
}

function syncTheme(theme: unknown) {
  if (theme !== "dark" && theme !== "light") return;
  demo.applyTheme(theme, false);
  controls.syncTheme();
}

window.addEventListener("storage", event => { if (event.key === themeKey) syncTheme(event.newValue ?? "dark"); });
let nextScenario = scenario;
let runScenario: ((id: string) => void) | undefined;
window.addEventListener("message", event => {
  if (parent === window || event.source !== parent || event.origin !== location.origin) return;
  if (event.data?.type === "vsemkod:theme") syncTheme(event.data.theme);
  if (scenario && event.data?.type === "vsemkod:scenario" && typeof event.data.id === "string") {
    nextScenario = event.data.id;
    runScenario?.(event.data.id);
  }
});

async function start() {
  await import("../renderer/index");
  if (scenario) {
    const { runScenarios } = await import("./scenarios");
    runScenario = runScenarios(root, demo);
    runScenario(nextScenario ?? scenario);
  }
}

void start().catch(() => { root.textContent = "Не удалось открыть демо vsemkod. Обнови страницу."; });
