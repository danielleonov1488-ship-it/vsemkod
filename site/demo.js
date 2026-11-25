const HISTORY_LIFETIME = 10 * 60_000;
const DEFAULT_MODEL = { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro" };
const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

const EXAMPLE = {
  prompt: "Добавь тёмную тему в настройки",
  intro: "Проверю настройки и добавлю переключатель темы.",
  steps: [
    { icon: "file", label: "Прочитал", code: "settings.tsx" },
    {
      icon: "edit", label: "Изменил", code: "settings.tsx", added: "+24", removed: "−3",
      diff: [
        ["remove", "−   <ThemePreview />"],
        ["add", "+   <ThemeToggle value={theme}"],
        ["add", "+     onChange={setTheme} />"],
      ],
    },
    { icon: "terminal", label: "Запустил", code: "npm test", result: "— 17 пройдено" },
  ],
  result: "Готово. Добавил переключатель темы. Все 17 тестов прошли.",
};

const LIVE_PLACEHOLDER = "Спроси что угодно — бесплатно, без регистрации";
const OFFLINE_PLACEHOLDER = "Живой чат скоро — а пока скачай приложение";
const MESSAGE_PLURAL = new Intl.PluralRules("ru");
const MESSAGE_FORMS = { one: "сообщение", few: "сообщения", many: "сообщений", other: "сообщений" };

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function icon(name, className = "") {
  const ns = "http://www.w3.org/2000/svg";
  const node = document.createElementNS(ns, "svg");
  node.setAttribute("class", `icon ${className}`.trim());
  node.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `#i-${name}`);
  node.append(use);
  return node;
}

function exampleStep(step) {
  const row = element(step.diff ? "summary" : "div", "chat-action chat-enter");
  row.append(icon(step.icon), step.label, element("code", "", step.code));
  if (step.result) row.append(step.result);
  if (!step.diff) return row;

  row.append(element("span", "diff-added", step.added), element("span", "diff-removed", step.removed), icon("chevron", "diff-chevron"));
  const details = element("details", "diff-toggle");
  details.open = true;
  const diff = element("pre", "diff-code");
  diff.setAttribute("aria-label", `Изменения в ${step.code}`);
  const code = element("code");
  for (const [type, line] of step.diff) {
    code.append(element("span", type ? `diff-${type}` : "", line));
  }
  diff.append(code);
  details.append(row, diff);
  return details;
}

function wait(milliseconds, signal) {
  return abortable(new Promise((resolve) => setTimeout(resolve, milliseconds)), signal);
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function typeExample(node, text, motion, signal, waitForPlay) {
  if (motion.matches) {
    node.textContent = text;
    return;
  }
  for (let count = 1; count <= text.length; count += 1) {
    await wait(18, signal);
    await waitForPlay(signal);
    node.textContent = text.slice(0, count);
  }
}

function appendInline(node, text) {
  const parts = text.split(/(`[^`\n]+`)/g);
  parts.forEach((part, index) => {
    node.append(index % 2 ? element("code", "", part.slice(1, -1)) : part);
  });
}

function markdown(source, complete, onCopy) {
  const fragment = document.createDocumentFragment();
  const lines = source.split(/\r?\n/);
  let paragraph;
  let list;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*(`{3,})\s*([\w+.#-]*)\s*$/);
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    const item = line.match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);

    if (fence) {
      const codeLines = [];
      const closingFence = new RegExp("^\\s*" + fence[1] + "\\x60*\\s*$");
      while (index + 1 < lines.length && !closingFence.test(lines[index + 1])) {
        codeLines.push(lines[++index]);
      }
      index += 1;
      const block = element("div", "code-block");
      const header = element("div", "code-header");
      const text = codeLines.join("\n");
      const copy = element("button", "copy-button", "Копировать");
      copy.type = "button";
      copy.disabled = !complete;
      copy.addEventListener("click", () => onCopy(text, copy));
      const pre = element("pre");
      pre.append(element("code", "", text));
      header.append(element("span", "", fence[2] || "Код"), copy);
      block.append(header, pre);
      fragment.append(block);
    } else if (heading) {
      const node = element(`h${Math.min(heading[1].length + 2, 5)}`, "md-heading");
      appendInline(node, heading[2]);
      fragment.append(node);
    } else if (item) {
      const tag = item[2] ? "OL" : "UL";
      if (list?.tagName !== tag) {
        list = element(tag.toLowerCase());
        if (tag === "OL") list.start = Number(item[2]);
        fragment.append(list);
      }
      const entry = element("li");
      appendInline(entry, item[3]);
      list.append(entry);
      paragraph = null;
      continue;
    } else if (line.trim()) {
      if (!paragraph) {
        paragraph = element("p");
        fragment.append(paragraph);
      } else {
        paragraph.append(" ");
      }
      appendInline(paragraph, line);
      list = null;
      continue;
    }

    paragraph = null;
    list = null;
  }
  return fragment;
}

function responsePainter(node, motion, onCopy, onPaint) {
  let source = "";
  let shown = 0;
  let frame = 0;
  let time = 0;
  let resolveDrain;

  function paint(now) {
    const step = Math.max(1, Math.floor((now - time) / 9), Math.ceil((source.length - shown) / 26));
    const target = motion.matches ? source.length : Math.min(source.length, shown + step);
    time = now;
    shown = target;
    // Keep surrogate pairs together during the animation.
    const boundary = /[\uD800-\uDBFF]/.test(source.charAt(shown - 1)) ? shown + 1 : shown;
    node.replaceChildren(markdown(source.slice(0, boundary), false, onCopy));
    onPaint();
    frame = target < source.length ? requestAnimationFrame(paint) : 0;
    if (!frame) resolveDrain?.();
  }

  return {
    append(delta) {
      source += delta;
      if (frame) return;
      time = performance.now();
      frame = requestAnimationFrame(paint);
    },
    reset() {
      cancelAnimationFrame(frame);
      frame = 0;
      shown = 0;
      source = "";
      node.replaceChildren();
    },
    drain(signal) {
      if (!frame || motion.matches) return;
      return abortable(new Promise((resolve) => { resolveDrain = resolve; }), signal);
    },
    finish() {
      cancelAnimationFrame(frame);
      node.replaceChildren(markdown(source, true, onCopy));
      return source;
    },
  };
}

class DemoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function endpoint(base, path, options) {
  const response = await fetch(base + path, { cache: "no-store", ...options });
  if (response.ok) return response;
  const payload = await response.json().catch(() => null);
  const fallbackCode = { 401: "auth", 403: "auth", 429: "limit", 503: "closed" }[response.status] || "unavailable";
  throw new DemoError(payload?.error?.code || fallbackCode, payload?.error?.message);
}

function post(body, signal, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { method: "POST", headers, body: JSON.stringify(body), signal };
}

async function* readEvents(response) {
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    throw new DemoError("unavailable");
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) pending += value;
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(pending))) {
        const event = pending.slice(0, separator.index);
        pending = pending.slice(separator.index + separator[0].length);
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (data) yield JSON.parse(data);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function turnstileClient(sitekey, widget) {
  let scriptPromise;

  function preload() {
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const failed = () => {
        clearTimeout(timeout);
        script.remove();
        reject(new DemoError("unavailable"));
      };
      const timeout = setTimeout(failed, 12_000);
      script.src = TURNSTILE_URL;
      script.async = true;
      script.addEventListener("load", () => {
        if (!window.turnstile) {
          failed();
          return;
        }
        clearTimeout(timeout);
        resolve(window.turnstile);
      }, { once: true });
      script.addEventListener("error", failed, { once: true });
      document.head.append(script);
    }).catch((error) => {
      scriptPromise = undefined;
      throw error;
    });
    return scriptPromise;
  }

  async function token(signal) {
    const turnstile = await abortable(preload(), signal);
    let widgetId;
    const challengeSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    try {
      challengeSignal.throwIfAborted();
      return await abortable(new Promise((resolve, reject) => {
        const failure = () => reject(new DemoError("unavailable"));
        widgetId = turnstile.render(widget, {
          sitekey,
          execution: "execute",
          appearance: "interaction-only",
          retry: "never",
          callback: resolve,
          "error-callback": failure,
          "expired-callback": failure,
          "timeout-callback": failure,
          "unsupported-callback": failure,
        });
        turnstile.execute(widgetId);
      }), challengeSignal);
    } finally {
      if (widgetId !== undefined) turnstile.remove(widgetId);
    }
  }

  return { preload, token };
}

export function configureDemo(apiUrl, sitekey, motion) {
  const byId = (id) => document.getElementById(id);
  const demo = byId("demo");
  const thread = byId("chat-thread");
  const scroller = byId("chat-scroll");
  const title = byId("demo-title");
  const input = byId("prompt");
  const send = byId("send");
  const stop = byId("stop");
  const burn = byId("burn");
  const pause = byId("pause-example");
  const privacy = byId("privacy-label");
  const status = byId("demo-status");
  const notice = byId("demo-notice");
  const modelPicker = byId("model-picker");
  const turnstile = turnstileClient(sitekey, byId("turnstile-widget"));
  const base = apiUrl.replace(/\/+$/, "");
  let model = DEFAULT_MODEL;
  let topModels = [];
  let live = false;
  let closed = false;
  let history = [];
  let session;
  let remaining;
  let request;
  let playback;
  let paused = false;
  let burnTimer;
  let countdown;
  let expires = 0;

  function syncInput() {
    input.disabled = !base || closed;
    input.readOnly = Boolean(request);
    send.hidden = Boolean(request);
    send.disabled = input.disabled || !input.value.trim();
    stop.hidden = !request;
    input.placeholder = closed ? "Живой чат недоступен" : base ? LIVE_PLACEHOLDER : OFFLINE_PLACEHOLDER;
  }

  function renderModels() {
    byId("demo-model").textContent = model.name;
    const selected = element("li");
    selected.setAttribute("aria-current", "true");
    selected.append(element("span", "", model.name), element("small", "", base ? "демо" : "пример"));
    const options = topModels.filter((option) => option.id !== model.id).map((option) => {
      const row = element("li");
      row.setAttribute("aria-disabled", "true");
      row.append(element("span", "", option.name), element("small", "", "в приложении"));
      return row;
    });
    byId("demo-model-options").replaceChildren(selected, ...options);
  }

  function scrollToBottom() {
    scroller.scrollTop = scroller.scrollHeight;
  }

  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 38;
  }

  async function waitForPlay(signal) {
    while (paused) await wait(100, signal);
  }

  function updatePause() {
    const label = paused ? "Продолжить пример" : "Поставить пример на паузу";
    pause.setAttribute("aria-label", label);
    pause.querySelector("use").setAttribute("href", paused ? "#i-play" : "#i-pause");
    pause.title = label;
    pause.hidden = live || closed || motion.matches;
    demo.classList.toggle("example-paused", paused || live || closed);
  }

  async function playExample() {
    playback?.abort();
    const controller = new AbortController();
    playback = controller;
    const { signal } = controller;

    while (!live && !closed) {
      signal.throwIfAborted();
      const user = element("p", "chat-message user-message chat-enter");
      user.setAttribute("aria-label", "Сообщение пользователя");
      const agent = element("div", "chat-message agent-message");
      agent.setAttribute("aria-label", "Ответ агента");
      const intro = element("p");
      const actions = element("div", "chat-actions");
      const result = element("p");
      thread.replaceChildren(user, agent);
      scroller.scrollTop = 0;

      await typeExample(user, EXAMPLE.prompt, motion, signal, waitForPlay);
      agent.append(intro, actions);
      await typeExample(intro, EXAMPLE.intro, motion, signal, waitForPlay);
      for (const step of EXAMPLE.steps) {
        if (!motion.matches) await wait(420, signal);
        await waitForPlay(signal);
        actions.append(exampleStep(step));
      }
      agent.append(result);
      await typeExample(result, EXAMPLE.result, motion, signal, waitForPlay);

      if (motion.matches) return;
      await wait(8900, signal);
      while (paused || demo.contains(document.activeElement) || document.hidden) await wait(400, signal);
    }
  }

  function startExample() {
    playExample().catch((error) => {
      if (error.name !== "AbortError") throw error;
    });
  }

  function showRemaining(message = "") {
    const count = Number.isInteger(remaining)
      ? `Осталось ${remaining} ${MESSAGE_FORMS[MESSAGE_PLURAL.select(remaining)]}`
      : "";
    status.textContent = [message, count].filter(Boolean).join(" · ");
  }

  function startLive() {
    if (live || closed) return;
    live = true;
    updatePause();
    playback?.abort();
    thread.replaceChildren();
    title.textContent = "Новый чат";
    byId("example-chat").classList.remove("active");
    showRemaining();
  }

  function clearHistory(animate = true) {
    const wasBusy = Boolean(request);
    request?.abort();
    request = undefined;
    history = [];
    input.value = "";
    expires = 0;
    clearInterval(countdown);
    clearTimeout(burnTimer);
    burn.hidden = true;
    privacy.textContent = "Не сохраняется";
    if (animate && !motion.matches && thread.childElementCount) {
      thread.classList.add("burning");
      burnTimer = setTimeout(() => {
        thread.replaceChildren();
        thread.classList.remove("burning");
      }, 360);
    } else {
      thread.replaceChildren();
      thread.classList.remove("burning");
    }
    if (!closed) showRemaining();
    if (wasBusy || !closed) syncInput();
  }

  function refreshTimer() {
    const seconds = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
    if (seconds === 0) {
      clearHistory();
      return;
    }
    const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
    const remainder = String(seconds % 60).padStart(2, "0");
    privacy.textContent = `Не сохраняется · сгорит через ${minutes}:${remainder}`;
  }

  function touchHistory() {
    expires = Date.now() + HISTORY_LIFETIME;
    burn.hidden = false;
    refreshTimer();
    clearInterval(countdown);
    countdown = setInterval(refreshTimer, 1000);
  }

  function closeDemo(message = "") {
    closed = true;
    updatePause();
    playback?.abort();
    if (!live) thread.replaceChildren();
    title.textContent = "Демо-чат";
    notice.hidden = false;
    showRemaining(message);
    syncInput();
    scrollToBottom();
  }

  async function checkStatus() {
    try {
      if (!sitekey) throw new DemoError("unavailable");
      const response = await endpoint(base, "/status", { signal: AbortSignal.timeout(6000) });
      const data = await response.json();
      if (typeof data.model?.name === "string" && typeof data.model.id === "string") {
        model = data.model;
        renderModels();
        if (data.open === true) return true;
      }
    } catch {}
    closeDemo();
    return false;
  }

  async function authenticate(signal) {
    if (session && session.expiresAt > Date.now()) return session;
    const token = await turnstile.token(signal);
    const response = await endpoint(base, "/session", post({ turnstile: token }, signal));
    const data = await response.json();
    signal.throwIfAborted();
    if (typeof data.token !== "string" || !Number.isFinite(data.expiresAt) || !Number.isInteger(data.remaining)) {
      throw new DemoError("unavailable");
    }
    session = data;
    remaining = data.remaining;
    showRemaining("Готовлю ответ");
    return session;
  }

  async function getAnswer(signal, painter) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal.throwIfAborted();
      try {
        const { token } = await authenticate(signal);
        if (remaining === 0) throw new DemoError("limit");
        const response = await endpoint(base, "/chat", post({ messages: history.slice(-8) }, signal, token));
        for await (const event of readEvents(response)) {
          signal.throwIfAborted();
          if (event.t === "delta" && typeof event.v === "string") painter.append(event.v);
          if (event.t === "error") throw new DemoError(event.code, event.message);
          if (event.t === "done" && Number.isInteger(event.remaining)) {
            remaining = event.remaining;
            return;
          }
        }
        throw new DemoError("unavailable");
      } catch (error) {
        if (error.code !== "auth" || attempt !== 0) throw error;
        session = undefined;
        painter.reset();
      }
    }
  }

  async function copyCode(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      if (button.isConnected) button.textContent = "Скопировано";
    } catch {
      if (button.isConnected) showRemaining("Не удалось скопировать код");
    }
  }

  async function submit(event) {
    event.preventDefault();
    const content = input.value.trim().slice(0, 2000);
    if (!base || !content || request || closed) return;
    startLive();
    clearTimeout(burnTimer);
    if (thread.classList.contains("burning")) {
      thread.replaceChildren();
      thread.classList.remove("burning");
    }

    const controller = new AbortController();
    request = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const user = element("p", "chat-message user-message chat-enter", content);
    user.setAttribute("aria-label", "Сообщение пользователя");
    const agent = element("div", "chat-message agent-message");
    agent.setAttribute("aria-label", "Ответ агента");
    const priorHistory = history;
    history = [...history.slice(-7), { role: "user", content }];
    thread.append(user, agent);
    input.value = "";
    syncInput();
    touchHistory();
    scrollToBottom();
    showRemaining("Готовлю ответ");

    let follow = true;
    const onScroll = () => { follow = nearBottom(); };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const painter = responsePainter(agent, motion, copyCode, () => {
      if (follow) scrollToBottom();
    });

    try {
      if (!await abortable(available, signal)) return;
      await getAnswer(signal, painter);
      await painter.drain(signal);
      if (request !== controller) return;
      finishResponse("Ответ готов");
      if (remaining === 0) closeDemo();
    } catch (error) {
      if (request !== controller) {
        painter.reset();
        return;
      }
      if (controller.signal.aborted) {
        remaining = undefined;
        finishResponse("Ответ остановлен");
      } else if (["busy", "bad_request", "upstream"].includes(error.code)) {
        painter.reset();
        agent.remove();
        user.remove();
        history = priorHistory;
        if (!history.length) clearHistory(false);
        input.value = content;
        syncInput();
        showRemaining(error.message || "Ответ прервался. Попробуй ещё раз.");
      } else {
        finishResponse();
        if (error.code === "limit") remaining = 0;
        closeDemo();
      }
    } finally {
      scroller.removeEventListener("scroll", onScroll);
      if (request === controller) {
        request = undefined;
        const restoreFocus = document.activeElement === stop;
        syncInput();
        if (restoreFocus) (closed ? scroller : input).focus({ preventScroll: true });
      }
      if (follow) scrollToBottom();
    }

    function finishResponse(message = "") {
      const answer = painter.finish();
      if (answer) {
        history = [...history.slice(-7), { role: "assistant", content: answer }];
        touchHistory();
      } else {
        agent.remove();
      }
      showRemaining(message);
    }
  }

  const available = base ? checkStatus() : Promise.resolve(false);
  input.addEventListener("focus", () => {
    startLive();
    if (sitekey && !closed) turnstile.preload().catch(() => {});
  });
  input.addEventListener("input", syncInput);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled && !request) byId("composer").requestSubmit();
    }
  });
  byId("composer").addEventListener("submit", submit);
  stop.addEventListener("click", () => request?.abort());
  pause.addEventListener("click", () => {
    paused = !paused;
    updatePause();
  });
  burn.addEventListener("click", () => {
    clearHistory();
    (closed ? scroller : input).focus({ preventScroll: true });
  });
  byId("new-chat").addEventListener("click", () => {
    if (!base) {
      paused = false;
      updatePause();
      startExample();
    } else if (!closed) {
      startLive();
      clearHistory();
      input.focus({ preventScroll: true });
    }
  });
  document.addEventListener("click", (event) => {
    if (!modelPicker.contains(event.target)) modelPicker.open = false;
  });
  modelPicker.addEventListener("keydown", (event) => {
    if (event.key === "Escape") modelPicker.open = false;
  });
  window.addEventListener("pagehide", () => {
    if (live) clearHistory(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && expires) refreshTimer();
  });
  motion.addEventListener("change", () => {
    paused = false;
    updatePause();
    if (!live && !closed) startExample();
  });
  renderModels();
  updatePause();
  syncInput();
  startExample();

  return (models) => {
    topModels = models;
    renderModels();
  };
}
