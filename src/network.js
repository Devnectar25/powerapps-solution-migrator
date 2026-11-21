'use strict';

/**
 * Outbound network setup for the Node server (used by MSAL and all Dataverse calls):
 *  - corporate proxy support (HTTPS_PROXY / HTTP_PROXY / NO_PROXY)
 *  - trust the operating system's certificate store (needed behind TLS-inspecting proxies)
 *  - readable explanations for low-level connection errors
 */

const tls = require('tls');
const config = require('./config');

const state = { proxy: null, systemCa: false, notes: [] };

function setupNetwork() {
  // 1. Trust OS certificates (Windows certificate store / macOS keychain) in addition to Node's bundle.
  if (config.useSystemCa) {
    if (typeof tls.getCACertificates === 'function' && typeof tls.setDefaultCACertificates === 'function') {
      try {
        const certs = new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
        tls.setDefaultCACertificates([...certs]);
        state.systemCa = true;
      } catch (err) {
        state.notes.push(`Could not load the system certificate store: ${err.message}`);
      }
    } else {
      state.notes.push(`Node ${process.version} cannot load the system certificate store; upgrade to Node 22.19+ or set NODE_EXTRA_CA_CERTS.`);
    }
  }

  // 2. Proxy. Node's built-in fetch ignores proxy variables unless a dispatcher is configured.
  const env = (k) => process.env[k] || process.env[k.toLowerCase()] || '';
  const httpsProxy = config.proxyUrl || env('HTTPS_PROXY') || env('HTTP_PROXY');
  const httpProxy = config.proxyUrl || env('HTTP_PROXY') || httpsProxy;
  const proxy = httpsProxy;
  // Long timeouts: Dataverse may take well over 5 minutes to answer a large import request.
  const timeouts = {
    headersTimeout: config.requestTimeoutMinutes * 60 * 1000,
    bodyTimeout: config.requestTimeoutMinutes * 60 * 1000,
  };
  state.requestTimeoutMinutes = config.requestTimeoutMinutes;
  if (proxy) {
    // Silence undici's "experimental" notice for EnvHttpProxyAgent.
    const emit = process.emitWarning;
    process.emitWarning = (w, ...rest) => {
      const code = rest[0] && typeof rest[0] === 'object' ? rest[0].code : rest[1];
      if (code === 'UNDICI-EHPA') return undefined;
      return emit.call(process, w, ...rest);
    };
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: env('NO_PROXY') || 'localhost,127.0.0.1', ...timeouts }));
    state.proxy = proxy.replace(/\/\/[^@/]*@/, '//***@'); // hide credentials in logs
  } else {
    const { Agent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new Agent(timeouts));
  }
  return state;
}

const HINTS = {
  ENOTFOUND: 'The host name could not be resolved (DNS). Check your internet connection, VPN, or whether a proxy is required (set PROXY_URL in .env).',
  EAI_AGAIN: 'DNS lookup timed out. Check your internet connection or VPN.',
  ECONNREFUSED: 'The connection was refused. If you use a proxy, check PROXY_URL; otherwise a firewall may be blocking Node.js.',
  ECONNRESET: 'The connection was reset, typically by a firewall or proxy. Set PROXY_URL in .env if your network requires a proxy, or allow node.exe in the firewall.',
  ETIMEDOUT: 'The connection timed out. Your network probably requires a proxy: set PROXY_URL in .env (ask IT for the address, e.g. http://proxy.company.com:8080).',
  UND_ERR_CONNECT_TIMEOUT: 'The connection timed out. Your network probably requires a proxy: set PROXY_URL in .env (ask IT for the address, e.g. http://proxy.company.com:8080).',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'Your network inspects HTTPS traffic with a company certificate that Node.js does not trust. Keep USE_SYSTEM_CA=true with Node 22.19+, or export the company root certificate and set NODE_EXTRA_CA_CERTS=C:\\path\\to\\root.pem.',
  SELF_SIGNED_CERT_IN_CHAIN: 'Your network inspects HTTPS traffic with a company certificate that Node.js does not trust. Keep USE_SYSTEM_CA=true with Node 22.19+, or export the company root certificate and set NODE_EXTRA_CA_CERTS=C:\\path\\to\\root.pem.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The server certificate could not be verified (HTTPS inspection). Set NODE_EXTRA_CA_CERTS to your company root certificate.',
  CERT_HAS_EXPIRED: 'A certificate in the chain has expired; check the PC clock and any HTTPS-inspecting proxy.',
  UND_ERR_ABORTED: 'The request was cancelled by the network, usually a proxy or firewall refusing the connection. Check PROXY_URL or ask IT to allow this host.',
  UND_ERR_SOCKET: 'The connection was closed unexpectedly, usually by a proxy or firewall. Check PROXY_URL or ask IT to allow this host.',
  UND_ERR_HEADERS_TIMEOUT: 'The server did not answer in time. For large solutions, increase REQUEST_TIMEOUT_MINUTES in .env.',
  UND_ERR_BODY_TIMEOUT: 'The server stopped sending data before the response was complete. Try again; for large solutions, increase REQUEST_TIMEOUT_MINUTES in .env.',
  UND_ERR_PROXY: 'The proxy rejected the request. Check PROXY_URL (including user name and password if your proxy needs them).',
};

function findCode(err, depth = 0) {
  if (!err || depth > 6) return null;
  if (err.code && typeof err.code === 'string') return err.code;
  return findCode(err.cause, depth + 1) || (Array.isArray(err.errors) ? err.errors.map((e) => findCode(e, depth + 1)).find(Boolean) : null);
}

function explain(err) {
  const code = findCode(err);
  if (!code) return null;
  return { code, hint: HINTS[code] || `Connection error ${code}.` };
}

/** Tries to reach `url` and returns null when OK, otherwise {code, hint, message}. */
async function probe(url, timeoutMs = 10000) {
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return null;
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { code: 'ETIMEDOUT', hint: HINTS.ETIMEDOUT, message: 'timed out' };
    const e = explain(err) || { code: 'UNKNOWN', hint: 'Unknown network error.' };
    return { ...e, message: (err.cause && err.cause.message) || err.message };
  }
}

module.exports = { setupNetwork, explain, probe, status: () => state };
