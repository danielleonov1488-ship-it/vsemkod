import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";

function lazyMarkdown(): Plugin {
  const facade = fileURLToPath(new URL("./src/web/markdown.tsx", import.meta.url)).replaceAll("\\", "/");
  const plugin = "\0harness-lazy-gfm";
  return {
    name: "harness-lazy-markdown",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !/\/renderer\/(?:chat|side-chat)\.tsx$/.test(importer.replaceAll("\\", "/"))) return;
      if (source === "react-markdown") return facade;
      if (source === "remark-gfm") return plugin;
    },
    load(id) {
      if (id === plugin) return `export { deferredGfm as default } from ${JSON.stringify(facade)};`;
    }
  };
}

function startupBudget(): Plugin {
  return {
    name: "harness-startup-budget",
    generateBundle(_, bundle) {
      const visited = new Set<string>();
      function size(file: string): number {
        const chunk = bundle[file];
        if (visited.has(file) || chunk?.type !== "chunk") return 0;
        visited.add(file);
        return gzipSync(chunk.code).length + chunk.imports.reduce((sum, entry) => sum + size(entry), 0);
      }
      // The renderer is imported immediately after installing the API.
      const bytes = Object.values(bundle).reduce((sum, chunk) => {
        if (chunk.type !== "chunk") return sum;
        if (chunk.isEntry || chunk.facadeModuleId?.replaceAll("\\", "/").endsWith("/renderer/index.tsx")) {
          return sum + size(chunk.fileName);
        }
        return sum;
      }, 0);
      this.info(`Harness startup chunks: ${(bytes / 1024).toFixed(2)} KiB gzip`);
      if (bytes > 250_000) this.error("Harness startup chunks exceed 250 kB gzip.");
    }
  };
}

export default defineConfig({
  root: fileURLToPath(new URL("./src/web/", import.meta.url)),
  base: "./",
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: [
      { find: /^@xterm\/xterm$/, replacement: fileURLToPath(new URL("./src/web/terminal.ts", import.meta.url)) },
      { find: "@xterm/xterm/css/xterm.css", replacement: fileURLToPath(new URL("./src/web/terminal.css", import.meta.url)) }
    ]
  },
  build: {
    outDir: fileURLToPath(new URL("../site/harness/", import.meta.url)),
    emptyOutDir: true,
    target: "es2023"
  },
  plugins: [lazyMarkdown(), startupBudget()]
});
