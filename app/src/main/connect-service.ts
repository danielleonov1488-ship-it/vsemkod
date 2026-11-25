import type { Catalog, ProviderId } from "../shared/catalog-schema";
import type { KeyStore } from "./key-store";

export class ConnectService {
  constructor(private readonly keys: KeyStore) {}

  connected(catalog: Catalog): ProviderId[] {
    return catalog.providers
      .filter(provider => provider.auth.type === "none" || this.keys.get(provider.id))
      .map(provider => provider.id);
  }

  key(id: ProviderId): string | undefined {
    return this.keys.get(id);
  }

  disconnect(id: ProviderId): Promise<void> {
    return this.keys.remove(id);
  }
}
