'use strict';

function parseNoProxy(value) {
  if (!value) {
    return [];
  }

  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.GLOBAL_AGENT_HTTPS_PROXY ||
  process.env.GLOBAL_AGENT_HTTP_PROXY;

if (!proxyUrl) {
  console.warn('[proxy-bootstrap] No proxy environment variables found; skipping Undici proxy configuration.');
  module.exports = {};
  return;
}

let undici;

try {
  undici = require('undici');
} catch (primaryError) {
  try {
    undici = require('node:undici');
  } catch (secondaryError) {
    console.warn(
      '[proxy-bootstrap] Cannot load undici; fetch traffic may bypass the proxy.',
      secondaryError,
    );
    module.exports = {};
    return;
  }
}

const { ProxyAgent, setGlobalDispatcher } = undici;

const noProxyEntries = Array.from(
  new Set([
    ...parseNoProxy(process.env.NO_PROXY),
    ...parseNoProxy(process.env.GLOBAL_AGENT_NO_PROXY),
  ]),
);

const proxyAgentOptions = {
  uri: proxyUrl,
};

if (noProxyEntries.length > 0) {
  proxyAgentOptions.noProxy = noProxyEntries;
}

setGlobalDispatcher(new ProxyAgent(proxyAgentOptions));
console.info(
  `[proxy-bootstrap] Undici dispatcher configured for ${proxyUrl}${
    noProxyEntries.length ? ` (NO_PROXY=${noProxyEntries.join(',')})` : ''
  }`,
);

try {
  require('global-agent/bootstrap');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') {
    console.warn('[proxy-bootstrap] Failed to initialize global-agent.', error);
  }
}

module.exports = {};
