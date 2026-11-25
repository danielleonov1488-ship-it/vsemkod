import { lazy, Suspense } from "react";
import type { Options } from "react-markdown";

// The renderer passes this plugin marker until the parser and GFM can be loaded together.
export function deferredGfm() {}

const Markdown = lazy(async () => {
  const [{ default: Parser }, { default: gfm }] = await Promise.all([import("react-markdown"), import("remark-gfm")]);
  return {
    default: (options: Options) => <Parser {...options}
      remarkPlugins={options.remarkPlugins?.map(plugin => plugin === deferredGfm ? gfm : plugin)} />
  };
});

export default function WebMarkdown(options: Options) {
  return <Suspense fallback={<p>{options.children}</p>}><Markdown {...options} /></Suspense>;
}
