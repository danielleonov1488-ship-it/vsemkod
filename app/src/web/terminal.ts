// The shared workspace mounts the same terminal tab in both builds.
// In the browser its surface contains only the availability message.
export class Terminal {
  options: { theme?: object } = {};

  open(host: HTMLElement) {
    const note = document.createElement("p");
    note.className = "subtle panel-empty";
    note.textContent = "Терминал работает в приложении.";
    host.append(note);
  }

  onData() { return { dispose() {} }; }
  write() {}
  resize() {}
  dispose() {}
}
