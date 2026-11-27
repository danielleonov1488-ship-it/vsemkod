import { join } from "node:path";
import { rankedModels } from "../../shared/catalog";
import type { Catalog } from "../../shared/catalog-schema";
import type { PersonalModel } from "../../shared/providers";
import { sessionAccess } from "./access";

const filePermissions = sessionAccess("ask").permissions;

export function engineConfig(
  catalog: Catalog, personal: PersonalModel[], router: { baseUrl: string; token: string }, configDirectory: string,
  settings: () => { agentSteps: number; webSearch: boolean; mcp: object }, enableOpenCodeZenFree = false
) {
  const models = rankedModels(catalog);
  const entries = models.map(model => [model.id, {
    name: model.name,
    limit: { context: model.contextWindow, output: Math.min(8192, Math.floor(model.contextWindow / 4)) },
    capabilities: { tools: model.capabilities.includes("tools"), input: ["text", ...(model.capabilities.includes("vision") ? ["image"] : [])], output: ["text"] }
  }]);
  const personalEntries = personal.map(model => [model.id, {
    name: model.name,
    limit: { context: model.context ?? 32_768, output: model.output ?? Math.min(8192, Math.floor((model.context ?? 32_768) / 4)) },
    capabilities: { tools: true, input: ["text", ...(model.vision ? ["image"] : [])], output: ["text"] }
  }]);
  return {
    model: "vsemkod/auto",
    update: "disable",
    share: "disabled",
    formatter: false,
    lsp: false,
    snapshots: true,
    instructions: ["AGENTS.md"],
    skills: [join(configDirectory, "skills"), ".opencode/skills"],
    todo: true,
    websearch: settings().webSearch ? { provider: "tinyfish" } : false,
    compaction: { auto: true },
    policies: settings().webSearch ? [] : [{ action: "websearch.use", resource: "*", effect: "deny" }],
    mcp: settings().mcp,
    permissions: filePermissions,
    agents: {
      ...Object.fromEntries(["build", "plan", "general"].map(agent => [agent, { ...(settings().agentSteps ? { steps: settings().agentSteps } : {}), ...(agent === "plan" ? { permissions: sessionAccess("read").permissions } : {}) }])),
      title: { disabled: true }
    },
    plugins: [
      "-opencode.provider.kilo", "-opencode.provider.claude-agent", "-opencode.config.compatibility", "-opencode.skill", "-opencode.browser",
      ...(enableOpenCodeZenFree ? [] : ["-opencode.provider.opencode"])
    ],
    providers: {
      vsemkod: {
        name: "vsemkod",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: router.baseUrl, apiKey: router.token },
        models: Object.fromEntries([["auto", {
          name: "Автовыбор",
          limit: { context: Math.min(...models.filter(model => model.tier !== "basic" && model.origin !== "discovered").map(model => model.contextWindow), 128_000), output: 8192 },
          capabilities: { tools: true, input: ["text"], output: ["text"] }
        }], ["relay", {
          name: "vsemkod",
          limit: { context: 32_768, output: 8192 },
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] }
        }], ...entries, ...personalEntries])
      }
    }
  };
}
