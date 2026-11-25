import "../renderer/styles.css";
import "./web.css";
import { createDemo, readTheme, themeKey } from "./demo-api";
import { installWebControls, showDesktop } from "./web-controls";
import { preloadTurnstile } from "./transport";

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
