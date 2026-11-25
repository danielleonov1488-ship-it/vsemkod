const paths = {
  paperclip: <path d="M6.5 10.5 11 6a2 2 0 0 0-2.8-2.8L3.6 7.8a3 3 0 0 0 4.2 4.2l4.7-4.7M5 9.3l4-4" />,
  more: <path d="M3 8h.1M8 8h.1M13 8h.1" strokeWidth="2.5" />,
  panel: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M10 3v10" /></>,
  minus: <path d="M3 8h10" />,
  maximize: <rect x="3.5" y="3.5" width="9" height="9" rx=".5" />,
  close: <path d="m4.5 4.5 7 7m0-7-7 7" />,
  newChat: <path d="M7 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h7a1.5 1.5 0 0 0 1.5-1.5V9M7 9l.4-2.2 4.4-4.4a1.25 1.25 0 0 1 1.8 1.8L9.2 8.6 7 9Z" />,
  search: <><circle cx="6.75" cy="6.75" r="4" /><path d="m9.75 9.75 3 3" /></>,
  settings: <><path d="M6.5 2.3h3l.4 1.5 1 .6 1.5-.4 1.5 2.6-1.1 1.1v1.1l1.1 1.1-1.5 2.6-1.5-.4-1 .6-.4 1.5h-3l-.4-1.5-1-.6-1.5.4-1.5-2.6 1.1-1.1V7.7L2.1 6.6 3.6 4l1.5.4 1-.6.4-1.5Z" /><circle cx="8" cy="8.25" r="2" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  bolt: <path d="m9 1.75-5.4 7h3.8l-.4 5.5 5.4-7H8.6L9 1.75Z" />,
  cache: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2.5" /></>,
  provider: <><rect x="2.5" y="2.75" width="11" height="4" rx="1.25" /><rect x="2.5" y="9.25" width="11" height="4" rx="1.25" /><path d="M5 4.75h.1M5 11.25h.1" /></>,
  subscription: <><rect x="2" y="3.5" width="12" height="9" rx="1.5" /><path d="M2 6.5h12M5 9.5h2" /></>,
  folder: <path d="M1.75 5A1.25 1.25 0 0 1 3 3.75h3.1L7.4 5h5.6c.7 0 1.25.55 1.25 1.25V11.5c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25Z" />,
  chevron: <path d="m5 6.5 3 3 3-3" />,
  check: <path d="m3.5 8 3 3 6-6" />,
  mic: <><rect x="6" y="2" width="4" height="7.5" rx="2" /><path d="M4 7.5V8a4 4 0 0 0 8 0v-.5M8 12v2m-2 0h4" /></>,
  send: <path d="M8 12.75v-9.5m-4 4 4-4 4 4" />,
  stop: <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1" fill="currentColor" />,
  read: <><path d="M5 3H3.5A1.5 1.5 0 0 0 2 4.5V11m8-8 3 3v6.5A1.5 1.5 0 0 1 11.5 14h-5A1.5 1.5 0 0 1 5 12.5v-8A1.5 1.5 0 0 1 6.5 3H10Z" /><path d="M10 3v3h3" /></>,
  file: <><path d="M9 2.5H4.5A1.5 1.5 0 0 0 3 4v8A1.5 1.5 0 0 0 4.5 13.5h7A1.5 1.5 0 0 0 13 12V6.5l-4-4Z" /><path d="M9 2.5v4h4m-7 2h4m-4 2.5h3" /></>,
  terminal: <><rect x="1.75" y="3" width="12.5" height="10" rx="2" /><path d="m4.5 6 2 2-2 2m4 0h3" /></>,
  changes: <><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="4.5" r="1.5" /><path d="M4 5v6m0 .5c.4-4.2 8 .2 8-5.5" /></>,
  telegram: <><path d="M14.25 2 1.75 7l4.5 1.75L8 13.5l2.3-2.9 2.95 2.15Z" /><path d="m6.25 8.75 8-6.75" /></>,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1.25" /><path d="M5.5 7V4.75a2.5 2.5 0 0 1 5 0V7M8 9.5v1.5" /></>
};

export function Icon({ name, className = "" }: { name: keyof typeof paths; className?: string }) {
  return <svg className={"icon " + className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
