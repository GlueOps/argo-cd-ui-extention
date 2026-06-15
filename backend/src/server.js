const express = require('express');

const app = express();

const PORT = Number(process.env.PORT || 8000);
const LOG_LEVEL = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 8000);
const PROMETHEUS_BASE_URL = (process.env.PROMETHEUS_BASE_URL || '').replace(/\/$/, '');
const TEMPO_BASE_URL = (process.env.TEMPO_BASE_URL || '').replace(/\/$/, '');
const TEMPO_SEARCH_PATH = process.env.TEMPO_SEARCH_PATH || '/api/search';

function logDebug(message, meta) {
  if (LOG_LEVEL === 'DEBUG') {
    console.log('[DEBUG]', message, meta || '');
  }
}

function buildUrl(base, path, query) {
  const upstream = new URL(path, `${base}/`);
  const params = new URLSearchParams(query || {});
  upstream.search = params.toString();
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

  const url = buildUrl(PROMETHEUS_BASE_URL, '/api/v1/query', req.query);
  logDebug('proxy prometheus', { url });

  try {
    const result = await fetchJson(url);
    if (!result.ok) {
      return res.status(result.status).json({
        status: 'error',
        errorType: 'upstream_error',
        error: result.bodyText || 'upstream error'
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

  const url = buildUrl(TEMPO_BASE_URL, TEMPO_SEARCH_PATH, req.query);
  logDebug('proxy tempo', { url });

  try {
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

app.listen(PORT, () => {
  console.log(`argocd-otel-extension-api listening on :${PORT}`);
});
