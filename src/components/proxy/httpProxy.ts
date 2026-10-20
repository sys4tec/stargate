import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { logger } from "../logs/logger.js";

const httpProxy = process.env.HTTP_PROXY;
const httpsProxy = process.env.HTTPS_PROXY;

if (httpProxy || httpsProxy) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch {
    logger.error("http_proxy_configuration_invalid");
    process.exit(1);
  }

  logger.info("http_proxy_enabled", {
    hasHttpProxy: Boolean(httpProxy),
    hasHttpsProxy: Boolean(httpsProxy),
    noProxy: process.env.NO_PROXY,
  });
}
