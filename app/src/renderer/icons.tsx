const paths = {
  minus: <path d="M3 8h10" />,
  maximize: <rect x="3.5" y="3.5" width="9" height="9" rx=".5" />,
  close: <path d="m4.5 4.5 7 7m0-7-7 7" />,
  newChat: <path d="M7 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h7a1.5 1.5 0 0 0 1.5-1.5V9M7 9l.4-2.2 4.4-4.4a1.25 1.25 0 0 1 1.8 1.8L9.2 8.6 7 9Z" />,
  search: <><circle cx="6.75" cy="6.75" r="4" /><path d="m9.75 9.75 3 3" /></>,
  settings: <><path d="M6.5 2.3h3l.4 1.5 1 .6 1.5-.4 1.5 2.6-1.1 1.1v1.1l1.1 1.1-1.5 2.6-1.5-.4-1 .6-.4 1.5h-3l-.4-1.5-1-.6-1.5.4-1.5-2.6 1.1-1.1V7.7L2.1 6.6 3.6 4l1.5.4 1-.6.4-1.5Z" /><circle cx="8" cy="8.25" r="2" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  folder: <path d="M1.75 5A1.25 1.25 0 0 1 3 3.75h3.1L7.4 5h5.6c.7 0 1.25.55 1.25 1.25V11.5c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25Z" />,
  chevron: <path d="m5 6.5 3 3 3-3" />,
  check: <path d="m3.5 8 3 3 6-6" />,
  send: <path d="M8 12.75v-9.5m-4 4 4-4 4 4" />,
  stop: <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1" fill="currentColor" />,
  read: <><path d="M5 3H3.5A1.5 1.5 0 0 0 2 4.5V11m8-8 3 3v6.5A1.5 1.5 0 0 1 11.5 14h-5A1.5 1.5 0 0 1 5 12.5v-8A1.5 1.5 0 0 1 6.5 3H10Z" /><path d="M10 3v3h3" /></>,
  file: <><path d="M9 2.5H4.5A1.5 1.5 0 0 0 3 4v8A1.5 1.5 0 0 0 4.5 13.5h7A1.5 1.5 0 0 0 13 12V6.5l-4-4Z" /><path d="M9 2.5v4h4m-7 2h4m-4 2.5h3" /></>,
  terminal: <><rect x="1.75" y="3" width="12.5" height="10" rx="2" /><path d="m4.5 6 2 2-2 2m4 0h3" /></>,
  changes: <><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="4.5" r="1.5" /><path d="M4 5v6m0 .5c.4-4.2 8 .2 8-5.5" /></>,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1.25" /><path d="M5.5 7V4.75a2.5 2.5 0 0 1 5 0V7M8 9.5v1.5" /></>
};

export function Icon({ name, className = "" }: { name: keyof typeof paths; className?: string }) {
  return <svg className={"icon " + className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

export function GoogleMark() {
  return <svg className="google-mark" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.2 5.48-4.71 7.18l7.73 6c4.51-4.18 7.02-10.34 7.02-17.65Z" />
    <path fill="#FBBC05" d="M10.54 28.59a14.4 14.4 0 0 1 0-9.18l-7.98-6.19a24.02 24.02 0 0 0 0 21.56l7.98-6.19Z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.96-5.8l-7.73-6c-2.17 1.46-5.8 2.3-8.23 2.3-6.26 0-11.61-4.22-13.46-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z" />
  </svg>;
}
