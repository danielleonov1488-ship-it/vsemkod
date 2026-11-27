export interface FreeModelMetadata {
  id: string;
  name?: unknown;
  display_name?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown; input?: unknown; output?: unknown; free?: unknown };
  input_price?: unknown;
  output_price?: unknown;
  free?: unknown;
  is_free?: unknown;
  tier?: unknown;
  tool_call?: unknown;
  tools_calling?: unknown;
  capabilities?: unknown;
  supports_tools?: unknown;
  supports_tool_calling?: unknown;
  supported_parameters?: unknown;
  supported_features?: unknown;
  tags?: unknown;
}

const zero = (price: unknown) => price === 0 ||
  typeof price === "string" && /^(?:0+\.?0*|\.0+)(?:e[+-]?\d+)?$/i.test(price.trim());

export function toolSupport(item: FreeModelMetadata): boolean | undefined {
  const capabilities = item.capabilities;
  const flag = Array.isArray(capabilities) ? capabilities.includes("tools") :
    capabilities && typeof capabilities === "object"
      ? (capabilities as { tools?: unknown; function_calling?: unknown }).tools ??
        (capabilities as { function_calling?: unknown }).function_calling
      : undefined;
  const direct = [flag, item.supports_tools, item.supports_tool_calling, item.tools_calling, item.tool_call]
    .find(value => typeof value === "boolean");
  if (typeof direct === "boolean") return direct;
  if ([item.tags, item.supported_features].some(list => Array.isArray(list) &&
      list.some(value => ["tool-use", "tools", "tool_calling", "function_calling"].includes(value)))) return true;
  if (Array.isArray(item.supported_parameters)) return item.supported_parameters.includes("tools");
}

export function isFreeRoute(item: FreeModelMetadata, implicit = false): boolean {
  if (item.free === false || item.is_free === false) return false;
  const input = item.pricing?.prompt ?? item.pricing?.input ?? item.input_price;
  const output = item.pricing?.completion ?? item.pricing?.output ?? item.output_price;
  if (item.free === true || item.is_free === true || item.pricing?.free === true || zero(input) && zero(output)) return true;
  if ([input, output].some(price => price != null && !zero(price))) return false;
  return item.tier === "free" || /(?:-free|:free)$/i.test(item.id) || /^free\//i.test(item.id) ||
    [item.id, item.name, item.display_name].some(value => typeof value === "string" && /\(free\)/i.test(value)) ||
    implicit && input == null && output == null;
}
