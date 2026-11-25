// Анимации лендинга: фон из строк кода, сцена «Скачай и работай», чек в «Нашей цели».
const motion = matchMedia("(prefers-reduced-motion: reduce)");

const SNIPPETS = [
  "const answer = await agent.run(task);",
  "git commit -m \"feat: menu and order form\"",
  "export function route(model, providers) {",
  "  return providers.filter((p) => p.free);",
  "if (response.status === 429) cooldown(provider);",
  "npm run build && npm test",
  "def handler(event, context):",
  "SELECT id, name FROM models WHERE free = 1;",
  "for (const offer of catalog.offers) {",
  "app.get(\"/api/menu\", async (req, res) => {",
  "<section class=\"menu\">",
  "fetch(\"/v1/chat/completions\", { stream: true })",
  "diff --git a/src/app.tsx b/src/app.tsx",
  "+  <ThemeToggle value={theme} />",
  "-  <ThemePreview />",
  "while (queue.length) await step(queue.shift());",
  "kimi-k3.1 → glm-5.3 → deepseek-v4.1",
  "import { createServer } from \"node:http\";",
  "res.writeHead(200, { \"Content-Type\": \"text/event-stream\" });",
  "const tokens = usage.prompt_tokens + usage.completion_tokens;",
  "✓ 17 tests passed",
  "docker compose up -d",
  "fn main() { println!(\"hello, vsemkod\"); }",
  "await fs.writeFile(\"index.html\", html);",
  "model: \"auto\", temperature: 0.2",
  "const free = catalog.models.filter(isTop);",
  "useEffect(() => { save(chat) }, [chat]);",
  "curl -s https://vsemkod.ru/catalog.json",
  "class Router { failover(model) { … } }",
  "pip install -r requirements.txt",
  "border-radius: 14px; color: #3DDC97;",
  "agent.on(\"tool\", (call) => render(call));",
];

function codeRain() {
  const canvas = document.getElementById("code-rain");
  if (!canvas || motion.matches) return;
  const ctx = canvas.getContext("2d");
  let width = 0, height = 0, lines = [], rgb = "61, 220, 151", alpha = 0.08, last = 0, running = !document.hidden;

  function readTheme() {
    const style = getComputedStyle(document.documentElement);
    rgb = style.getPropertyValue("--rain").trim() || rgb;
    alpha = Number.parseFloat(style.getPropertyValue("--rain-alpha")) || alpha;
  }

  function spawn(y) {
    const text = SNIPPETS[Math.floor(Math.random() * SNIPPETS.length)];
    return {
      text, y: y ?? height + 20 + Math.random() * 80,
      x: Math.random() * (width + 120) - 120,
      speed: 7 + Math.random() * 15,
      size: Math.random() < 0.18 ? 15 : 12,
      weight: 0.35 + Math.random() * 0.65,
      shown: Math.random() < 0.3 ? 0 : text.length,
    };
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lines = Array.from({ length: Math.round((width * height) / 24000) }, () => spawn(Math.random() * height));
  }

  function frame(time) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (time - last < 33) return;
    const dt = Math.min(0.1, (time - last) / 1000);
    last = time;
    ctx.clearRect(0, 0, width, height);
    for (const size of [12, 15]) {
      ctx.font = `${size}px ui-monospace, "Cascadia Code", Menlo, monospace`;
      for (const line of lines) {
        if (line.size !== size) continue;
        line.y -= line.speed * dt;
        if (line.shown < line.text.length) line.shown += 22 * dt;
        if (line.y < -24) Object.assign(line, spawn());
        const edge = Math.min(1, line.y / (height * 0.2), (height - line.y) / (height * 0.12));
        ctx.fillStyle = `rgba(${rgb}, ${(alpha * line.weight * Math.max(0, edge)).toFixed(3)})`;
        ctx.fillText(line.text.slice(0, Math.floor(line.shown)), line.x, line.y);
      }
    }
  }

  readTheme();
  resize();
  window.addEventListener("resize", resize);
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running) { last = performance.now(); requestAnimationFrame(frame); }
  });
  requestAnimationFrame(frame);
}

function story() {
  const stage = document.getElementById("story-stage");
  if (!stage) return;
  const items = [...document.querySelectorAll(".story-steps li")];
  const typed = stage.querySelector(".ma-typed");
  const TASK = "Сделай сайт для кофейни: меню, цены и форма заказа";
  let scene = 0, timers = [], visible = false;

  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const step = (n) => stage.classList.add(`s${n}`);
  const click = () => { stage.classList.add("click"); later(170, () => stage.classList.remove("click")); };
  const hide = () => { stage.style.setProperty("--cx", "50%"); stage.style.setProperty("--cy", "112%"); };
  function point(selector, dx = 0.5, dy = 0.5) {
    const target = stage.querySelector(selector);
    if (!target) return;
    const box = stage.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    stage.style.setProperty("--cx", `${rect.left - box.left + rect.width * dx}px`);
    stage.style.setProperty("--cy", `${rect.top - box.top + rect.height * dy}px`);
  }
  function type(text, duration) {
    const pause = duration / text.length;
    [...text].forEach((_, index) => later(index * pause, () => { typed.textContent = text.slice(0, index + 1); }));
  }

  const scenes = [
    { ms: 5600, run() {
      point(".mb-button", 0.62, 0.6);
      later(1050, () => { click(); step(2); });
      later(2300, () => step(3));
      later(4000, () => { step(4); hide(); });
    } },
    { ms: 6600, run() {
      point(".ma-plus");
      later(950, () => { click(); step(1); step(2); });
      later(1600, () => point(".ma-open", 0.4));
      later(2400, () => { click(); step(3); });
      later(2700, () => step(4));
      later(3400, () => point(".ma-pick", 0.35));
      later(4100, () => { click(); step(5); });
      later(4500, () => point(".ma-dialog-ok"));
      later(5300, () => { click(); step(6); hide(); });
    } },
    { ms: 6200, run() {
      point(".ma-input", 0.08);
      later(800, () => { click(); stage.classList.add("typing"); type(TASK, 3000); });
      later(4100, () => point(".ma-send"));
      later(4900, () => { click(); step(5); });
      later(5150, () => { stage.classList.remove("typing"); typed.textContent = ""; step(6); hide(); });
    } },
    { ms: 8200, run() {
      later(300, () => step(1));
      later(1500, () => step(2));
      later(2300, () => step(3));
      later(3100, () => step(4));
      later(5600, () => step(5));
      later(6600, () => step(6));
    } },
  ];

  function reset() {
    timers.forEach(clearTimeout);
    timers = [];
    stage.className = "story-stage";
    typed.textContent = "";
  }

  function show(index, autoplay = true) {
    reset();
    scene = index;
    stage.dataset.scene = String(index);
    items.forEach((item, i) => {
      item.classList.toggle("is-active", i === index);
      item.classList.toggle("is-done", i < index);
      item.style.setProperty("--step-ms", `${scenes[i].ms}ms`);
    });
    if (motion.matches) {
      for (let n = 1; n <= 6; n++) step(n);
      return;
    }
    hide();
    later(480, () => scenes[index].run());
    if (autoplay) later(scenes[index].ms, () => show((index + 1) % scenes.length));
  }

  document.querySelectorAll(".story-steps button").forEach((button) => {
    button.addEventListener("click", () => show(Number(button.dataset.goto)));
  });

  if (motion.matches) { show(3, false); return; }
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting === visible) return;
    visible = entry.isIntersecting;
    if (visible) show(scene);
    else reset();
  }, { threshold: 0.35 }).observe(stage);
}

function receipt() {
  const card = document.getElementById("receipt");
  const total = document.getElementById("receipt-total");
  if (!card || !total) return;
  const format = new Intl.NumberFormat("ru-RU");
  const finish = () => { card.classList.add("is-struck", "is-stamped"); total.textContent = "0 ₽"; };
  if (motion.matches) { finish(); return; }
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    observer.disconnect();
    card.classList.add("is-struck");
    const from = 66880, start = performance.now() + 1100, duration = 900;
    function tick(now) {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      total.textContent = `${format.format(Math.round(from * (1 - t) ** 2))} ₽`;
      if (t < 1) requestAnimationFrame(tick);
      else card.classList.add("is-stamped");
    }
    requestAnimationFrame(tick);
  }, { threshold: 0.55 });
  observer.observe(card);
}

codeRain();
story();
receipt();
