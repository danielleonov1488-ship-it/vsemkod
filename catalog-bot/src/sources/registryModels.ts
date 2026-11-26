import { z } from "zod";
import { providersUnderReview } from "../registry/providers.js";
import { request } from "./common.js";

const modelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })).min(1),
});

export async function fetchRegistryModels(providerId: keyof typeof providersUnderReview): Promise<string[]> {
  const url = providersUnderReview[providerId].baseUrl + "/models";
  const { data } = modelsSchema.parse(await request(url, (response) => response.json(), { redirect: "error" }, 0));
  return data.map(({ id }) => id);
}
