import { providers } from "../registry/providers.js";
import { requestJson } from "./common.js";
import type { SourceResult } from "./common.js";
import { parseOpenAIModels } from "./openrouter.js";

export async function fetchKilo(): Promise<SourceResult> {
  const response = await requestJson(providers.kilo.baseUrl + "/models");
  return { id: "kilo", observations: parseOpenAIModels(response, "kilo") };
}
