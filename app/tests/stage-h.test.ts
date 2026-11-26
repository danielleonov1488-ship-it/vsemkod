import { describe, expect, it } from "vitest";
import { findLocalUrls, isAllowedNavigation, normalizeAddress } from "../src/shared/browser";
import { panelShortcut, quoteText, readPanels } from "../src/shared/panels";
import { keyFromClipboard } from "../src/main/clipboard-watch";
import { findSecrets, maskSecrets } from "../src/shared/secrets";

describe("адресная строка браузера", () => {
  it("достраивает протокол", () => {
    expect(normalizeAddress("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeAddress("127.0.0.1:8080/app")).toBe("http://127.0.0.1:8080/app");
    expect(normalizeAddress("vsemkod.ru")).toBe("https://vsemkod.ru/");
    expect(normalizeAddress("example.com:8443/x")).toBe("https://example.com:8443/x");
    expect(normalizeAddress("https://vsemkod.ru/#faq")).toBe("https://vsemkod.ru/#faq");
  });
  it("отклоняет опасное и бессмысленное", () => {
    for (const value of ["", "  ", "javascript:alert(1)", "data:text/html,hi", "chrome://settings", "devtools://x", "mailto:a@b.c", "две строки", "word"]) {
      expect(normalizeAddress(value)).toBeUndefined();
    }
  });
});

describe("фильтр навигации", () => {
  const win = "G:\\Проекты\\кофейня";
  it("пускает http(s) и файлы внутри проекта", () => {
    expect(isAllowedNavigation("https://vsemkod.ru/")).toBe(true);
    expect(isAllowedNavigation("http://localhost:3000/")).toBe(true);
    expect(isAllowedNavigation("file:///G:/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82%D1%8B/%D0%BA%D0%BE%D1%84%D0%B5%D0%B9%D0%BD%D1%8F/index.html", win)).toBe(true);
    expect(isAllowedNavigation("file:///home/me/site/index.html", "/home/me/site")).toBe(true);
  });
  it("не пускает файлы снаружи, служебные схемы и логины в URL", () => {
    expect(isAllowedNavigation("file:///G:/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82%D1%8B/other/index.html", win)).toBe(false);
    expect(isAllowedNavigation("file:///G:/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82%D1%8B/%D0%BA%D0%BE%D1%84%D0%B5%D0%B9%D0%BD%D1%8F/../secret.txt", win)).toBe(false);
    expect(isAllowedNavigation("file:///home/me/site-other/a.html", "/home/me/site")).toBe(false);
    expect(isAllowedNavigation("file:///etc/passwd")).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)")).toBe(false);
    expect(isAllowedNavigation("chrome://gpu")).toBe(false);
    expect(isAllowedNavigation("devtools://devtools")).toBe(false);
    expect(isAllowedNavigation("https://user:pass@example.com/")).toBe(false);
  });
});

describe("поиск localhost-адресов", () => {
  it("находит адреса dev-серверов в выводе", () => {
    const output = "\u001b[32m➜\u001b[39m  Local:   \u001b[36mhttp://localhost:5173/\u001b[39m\n  Network: http://0.0.0.0:5173/.\nServer at http://127.0.0.1:8000, ready. https://example.com";
    expect(findLocalUrls(output)).toEqual(["http://localhost:5173/", "http://127.0.0.1:8000/"]);
  });
});

describe("секреты в сообщении", () => {
  it("находит ключи и пароли", () => {
    const text = "ключ sk-or-v1-abcdefghijklmnopqrstuvwxyz0123 и gsk_ABCDEFGHIJKLMNOPQRSTUVWX1234 password=hunter22";
    expect(findSecrets(text).map(item => item.kind)).toEqual(["Ключ OpenAI / OpenRouter / DeepSeek", "Ключ Groq", "Пароль"]);
    expect(maskSecrets(text)).toBe("ключ *** и *** password=***");
  });
  it("не срабатывает на обычный текст, хеши и пути", () => {
    for (const text of [
      "Исправь баг в sk-button.tsx и добавь task-list",
      "commit 3f9a1c2b7d4e5f60718293a4b5c6d7e8f9012345",
      "Пароль должен быть не короче 8 символов",
      "const token = getToken();",
      "G:\\vsemkod\\pelican-bicycle.svg",
    ]) expect(findSecrets(text)).toEqual([]);
  });
});

describe("горячие клавиши и вкладки", () => {
  const keys = [
    ["KeyD", true, "changes"], ["KeyB", true, "browser"], ["KeyF", true, "files"],
    ["Backquote", false, "terminal"], ["Semicolon", false, "side"]
  ] as const;
  it.each(keys)("%s поддерживает Ctrl на Windows и Cmd на Mac", (code, shiftKey, tab) => {
    const win = { code, shiftKey, ctrlKey: true, metaKey: false, altKey: false };
    const mac = { ...win, ctrlKey: false, metaKey: true };
    expect(panelShortcut(win, false)).toBe(tab);
    expect(panelShortcut(mac, true)).toBe(tab);
    expect(panelShortcut(win, true)).toBeUndefined();
    expect(panelShortcut({ ...mac, shiftKey: !shiftKey }, true)).toBeUndefined();
    expect(panelShortcut({ ...win, altKey: true }, false)).toBeUndefined();
  });
  it("восстанавливает только допустимые вкладки", () => {
    expect(readPanels('{"tabs":["browser","bad","tools","terminal","browser"],"active":"bad"}'))
      .toEqual({ tabs: ["browser", "terminal"], active: "terminal" });
    expect(readPanels("old")).toEqual({ tabs: [] });
    expect(quoteText("Привет\r\n\r\nЭтот текст")).toBe("> Привет\n> \n> Этот текст");
  });
});

describe("ключ для мастера подключений", () => {
  it("предлагает только полный ключ нужного провайдера", () => {
    const modelScope = /^ms-[A-Za-z0-9_-]+$/;
    expect(keyFromClipboard(" ms-example_123\n", modelScope)).toBe("ms-example_123");
    for (const text of ["git 9daeafb9864cf43055ae93beb0afd6c7d144bfa4", "sk-example_123", "Ключ: ms-example_123", "ms-example\nms-other"]) {
      expect(keyFromClipboard(text, modelScope)).toBeUndefined();
    }
  });
});
