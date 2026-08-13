// Upstream proxy injection for @cursor/sdk traffic. When CURSOR_PROXY is
// set: force HTTP/1.1, CONNECT-tunnel whitelisted hosts, and route the
// REST side through undici's ProxyAgent. No-op when unset.

import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import { setGlobalDispatcher, ProxyAgent } from "undici";
import { configureCursorSdk } from "@cursor/sdk";

const TUNNELED_HOSTS = [
  "api.cursor.com",
  "api2.cursor.sh",
  "api5.cursor.sh",
  "agentn.global.api5.cursor.sh",
  "agentn.us.api5.cursor.sh",
  "agentn.eu.api5.cursor.sh",
];

function proxyEndpoint(proxyUrl) {
  const u = new URL(proxyUrl);
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  return { host: u.hostname, port };
}

function requestTunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    let raw = "";
    proxy.on("data", function onData(chunk) {
      raw += chunk.toString("latin1");
      const sep = raw.indexOf("\r\n\r\n");
      if (sep === -1) return;
      proxy.removeListener("data", onData);
      if (!/^HTTP\/1\.[01] 200/i.test(raw)) {
        reject(new Error(`CONNECT ${host}:${port} failed: ${raw.split("\r\n")[0]}`));
        return;
      }
      resolve();
    });
    proxy.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`);
  });
}

function wrapTls(proxy, options, host) {
  return tls.connect({
    socket: proxy,
    servername: options.servername || host,
    host,
    port: options.port ?? 443,
    ...(options.ca ? { ca: options.ca } : {}),
    ...(options.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
  });
}

function buildTunnelAgent(proxyUrl) {
  const { host: proxyHost, port: proxyPort } = proxyEndpoint(proxyUrl);

  class ConnectTunnelAgent extends https.Agent {
    createConnection(options, callback) {
      const host = options.host;
      const port = options.port ?? 443;
      if (!TUNNELED_HOSTS.includes(host)) return super.createConnection(options, callback);

      const proxy = net.connect({ host: proxyHost, port: proxyPort });
      const onProxyError = (err) => {
        if (callback) callback(err);
        else proxy.destroy();
      };
      proxy.once("error", onProxyError);
      proxy.once("connect", () => {
        requestTunnel(proxy, host, port)
          .then(() => callback(null, wrapTls(proxy, options, host)))
          .catch(onProxyError);
      });
      return undefined; // callback mode; Node waits for the callback
    }
  }
  return new ConnectTunnelAgent();
}

export function injectProxy(proxyUrl) {
  if (!proxyUrl) return false;
  try {
    https.globalAgent = buildTunnelAgent(proxyUrl);
    configureCursorSdk({ local: { useHttp1ForAgent: true } });
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch (err) {
    console.error(`[proxy] proxy injection failed (falling back to direct): ${err?.message}`);
    return false;
  }
  console.log(`[proxy] upstream traffic now goes through ${proxyUrl} (forced HTTP/1.1 + CONNECT tunnel)`);
  return true;
}
