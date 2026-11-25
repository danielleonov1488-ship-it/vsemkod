"use strict";

const appName = getComputedStyle(document.documentElement).getPropertyValue("--app-name").trim().slice(1, -1);
document.title = `${document.title} · ${appName}`;

const chatSearch = document.querySelector("[data-chat-search]");
const recentChats = document.querySelectorAll(".recent li");
chatSearch.addEventListener("input", () => {
  const query = chatSearch.value.trim().toLocaleLowerCase("ru");
  for (const chat of recentChats) {
    chat.hidden = !chat.textContent.trim().toLocaleLowerCase("ru").includes(query);
  }
});

const draft = document.querySelector(".composer-input");
for (const suggestion of document.querySelectorAll(".suggestion")) {
  suggestion.addEventListener("click", () => {
    draft.value = suggestion.textContent;
    draft.focus();
  });
}

const attachment = document.querySelector("[data-file-input]");
const attachButton = document.querySelector("[data-pick-file]");
attachButton.addEventListener("click", () => attachment.click());
attachment.addEventListener("change", () => {
  const label = attachment.files[0]?.name ?? "Прикрепить файл";
  attachButton.title = label;
  attachButton.setAttribute("aria-label", label);
});

const folder = document.querySelector("[data-folder-input]");
const folderButton = document.querySelector("[data-pick-folder]");
folderButton.addEventListener("click", () => folder.click());
folder.addEventListener("change", () => {
  const path = folder.files[0]?.webkitRelativePath;
  if (path) folderButton.querySelector("span").textContent = path.split("/")[0];
});

const picker = document.querySelector(".model-picker");
const selectedModel = picker.querySelector("[data-selected-model]");
const modelChoices = picker.querySelectorAll("[data-model]");
const providerNote = document.querySelector(".provider-note");
for (const choice of modelChoices) {
  choice.addEventListener("click", () => {
    selectedModel.textContent = choice.dataset.model;
    for (const item of modelChoices) {
      item.setAttribute("aria-pressed", String(item === choice));
      item.querySelector(".model-check").hidden = item !== choice;
    }
    if (providerNote) providerNote.style.visibility = choice === modelChoices[0] ? "" : "hidden";
    picker.open = false;
    picker.querySelector("summary").focus();
  });
}

const diff = document.getElementById("chat-diff");
document.querySelector(".changes")?.addEventListener("click", () => { diff.open = true; });
document.querySelector("[data-followup]")?.addEventListener("submit", (event) => event.preventDefault());

const dialog = document.querySelector(".connect-dialog");
if (dialog) {
  if (new URLSearchParams(location.search).get("model") === "qwen") {
    dialog.querySelector(".monogram").textContent = "Q";
    dialog.querySelector("h1").textContent = "Подключить Qwen3.8";
  }
  dialog.focus();
  const toast = document.querySelector("[data-toast-message]");
  for (const button of dialog.querySelectorAll("[data-provider]")) {
    button.addEventListener("click", () => {
      toast.textContent = `Демонстрация входа через ${button.dataset.provider}`;
    });
  }
} else {
  document.addEventListener("click", (event) => {
    if (picker.open && !picker.contains(event.target)) picker.open = false;
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (dialog) location.href = dialog.querySelector(".dialog-close").href;
  else if (picker.open) {
    picker.open = false;
    picker.querySelector("summary").focus();
  }
});
