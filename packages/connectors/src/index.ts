import type { ConnectionConfig } from "@dashflow/core";
import { createAzureConnector } from "./azure-direct";
import { createDemoConnector } from "./demo";
import { createLighthouseConnector } from "./lighthouse";
import { createNerdioConnector } from "./nerdio";
import { createPartnerCenterConnector } from "./partner-center";
import type { Connector, ConnectorContext } from "./types";

export { API } from "./azure/arm";
export { AzureCollector, hashKey, isHealthy, roundToFiveMinutes } from "./azure/collectors";
export { SCOPES } from "./azure/credentials";
export {
  NERDIO_DEFAULT_ENDPOINTS,
  type NerdioEndpointKey,
  normalizeNerdioHostPool,
  normalizeNerdioSessionHost,
} from "./nerdio";
export { buildConsentUrl, PARTNER_CONSENT_SCOPES, redeemConsentCode } from "./partner-center";
export * from "./types";

/** The one place that maps a stored connection to an implementation. */
export function createConnector(config: ConnectionConfig, ctx: ConnectorContext): Connector {
  switch (config.type) {
    case "azure":
      return createAzureConnector(config, ctx);
    case "lighthouse":
      return createLighthouseConnector(config, ctx);
    case "partner-center":
      return createPartnerCenterConnector(config, ctx);
    case "nerdio":
      return createNerdioConnector(config, ctx);
    case "demo":
      return createDemoConnector(config, ctx);
  }
}
