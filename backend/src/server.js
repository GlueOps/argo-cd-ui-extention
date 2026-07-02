const express = require('express');

const app = express();

// Use the "simple" query parser (Node's querystring): duplicate keys become
// arrays and there is no nested-object (`a[b]=1`) coercion, so buildUrl can
// faithfully forward multi-value query params to upstream.
app.set('query parser', 'simple');

function requirePositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.error(`[FATAL] ${name} must be a positive integer, got: ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return n;
}

const PORT = requirePositiveInt('PORT', 8000);
const LOG_LEVEL = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
const REQUEST_TIMEOUT_MS = requirePositiveInt('REQUEST_TIMEOUT_MS', 8000);
const PROMETHEUS_BASE_URL = (process.env.PROMETHEUS_BASE_URL || '').replace(/\/$/, '');
const TEMPO_BASE_URL = (process.env.TEMPO_BASE_URL || '').replace(/\/$/, '');
const TEMPO_SEARCH_PATH = (process.env.TEMPO_SEARCH_PATH || '/api/search').trim();

// Guard TEMPO_SEARCH_PATH against absolute URLs (SSRF prevention)
if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(TEMPO_SEARCH_PATH)) {
  console.error(`[FATAL] TEMPO_SEARCH_PATH must be a relative path, not an absolute URL: ${JSON.stringify(TEMPO_SEARCH_PATH)}`);
  process.exit(1);
}

console.log(`[CONFIG] PORT=${PORT} REQUEST_TIMEOUT_MS=${REQUEST_TIMEOUT_MS} TEMPO_SEARCH_PATH=${JSON.stringify(TEMPO_SEARCH_PATH)}`);

function logDebug(message, meta) {
  if (LOG_LEVEL === 'DEBUG') {
    console.log('[DEBUG]', message, meta || '');
  }
}

function buildQueryString(query) {
  // Preserve multi-value params (?tags=a&tags=b) instead of collapsing them to
  // a single comma-joined value, and drop anything that can't be represented as
  // a scalar (e.g. nested objects) rather than forwarding "[object Object]".
  const params = new URLSearchParams();
  const source = query || {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (entry !== undefined && entry !== null && typeof entry !== 'object') {
          params.append(key, String(entry));
        }
      });
    } else if (value !== undefined && value !== null && typeof value !== 'object') {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

function buildUrl(base, path, query) {
  const trimmedPath = path.trim();
  // Reject absolute URLs in path to prevent SSRF via URL override.
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmedPath)) {
    throw new Error(`buildUrl: path must be relative, got absolute URL: ${trimmedPath}`);
  }
  const baseUrl = new URL(`${base.replace(/\/$/, '')}/`);
  // Strip leading slashes (and backslashes) so the path is appended to the base
  // *path* rather than resetting to the base root. This both preserves a base
  // path prefix (e.g. `/prometheus`) and neutralizes protocol-relative
  // (`//host`) or `/\host` inputs that would otherwise change the host.
  const relativePath = trimmedPath.replace(/^[/\\]+/, '');
  const upstream = new URL(relativePath, baseUrl);
  // Defense in depth: never allow the resolved host/scheme to differ from base.
  if (upstream.origin !== baseUrl.origin) {
    throw new Error(`buildUrl: resolved origin ${upstream.origin} differs from base ${baseUrl.origin}`);
  }
  upstream.search = buildQueryString(query);
  return upstream.toString();
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    const bodyText = await response.text();
    let payload = null;
    try {
      payload = bodyText ? JSON.parse(bodyText) : null;
    } catch (err) {
      payload = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      payload,
      bodyText
    };
  } finally {
    clearTimeout(timer);
  }
}

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/datasources/proxy/prometheus/api/v1/query', async (req, res) => {
  if (!PROMETHEUS_BASE_URL) {
    return res.status(503).json({
      status: 'error',
      errorType: 'config_error',
      error: 'PROMETHEUS_BASE_URL is not configured'
    });
  }

  try {
    const url = buildUrl(PROMETHEUS_BASE_URL, '/api/v1/query', req.query);
    logDebug('proxy prometheus', { url });

    const result = await fetchJson(url);
    if (!result.ok) {
      return res.status(result.status).json({
        status: 'error',
        errorType: 'upstream_error',
        error: `upstream returned status ${result.status}`
      });
    }

    // A 200 with an unparseable body is an upstream fault, not an empty result;
    // surface it instead of fabricating a successful empty vector.
    if (result.payload === null && result.bodyText) {
      return res.status(502).json({
        status: 'error',
        errorType: 'invalid_upstream_response',
        error: 'upstream returned a non-JSON response'
      });
    }

    return res.status(200).json(result.payload || { status: 'success', data: { resultType: 'vector', result: [] } });
  } catch (err) {
    return res.status(502).json({
      status: 'error',
      errorType: 'proxy_error',
      error: err.message
    });
  }
});

app.get('/api/datasources/proxy/tempo/api/search', async (req, res) => {
  if (!TEMPO_BASE_URL) {
    return res.status(200).json({ traces: [] });
  }

  try {
    const url = buildUrl(TEMPO_BASE_URL, TEMPO_SEARCH_PATH, req.query);
    logDebug('proxy tempo', { url });

    const result = await fetchJson(url);
    if (!result.ok) {
      return res.status(result.status).json({ traces: [] });
    }

    if (result.payload && Array.isArray(result.payload.traces)) {
      return res.status(200).json(result.payload);
    }

    if (Array.isArray(result.payload)) {
      return res.status(200).json({ traces: result.payload });
    }

    return res.status(200).json({ traces: [] });
  } catch (err) {
    return res.status(200).json({ traces: [] });
  }
});

app.use((_req, res) => {
  res.status(404).json({ message: 'Not found' });
});

function start() {
  const server = app.listen(PORT, () => {
    console.log(`argocd-otel-extension-api listening on :${PORT}`);
  });

  // Drain in-flight requests on rollout/scale-down instead of dropping them.
  function shutdown(signal) {
    console.log(`[SHUTDOWN] received ${signal}, closing server`);
    server.close(() => process.exit(0));
    // Force-exit if connections don't drain in time.
    setTimeout(() => process.exit(0), REQUEST_TIMEOUT_MS + 2000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// Only listen when run directly, so the module (and its helpers) can be
// imported by tests without opening a port.
if (require.main === module) {
  start();
}

module.exports = { app, start, buildUrl, buildQueryString };
