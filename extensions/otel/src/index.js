(function() {
  'use strict';

  var DEFAULT_CONFIG = {
    extensionName: 'otel-extension',
    grafanaBaseUrl: '',
    tempoDatasourceUid: 'tempo',
    prometheusDatasourceUid: 'prometheus',
    traceLookbackMinutes: 60,
    maxTraces: 20,
    requestTimeoutMs: 8000
  };

  function readConfig() {
    var runtime = window.__OTEL_EXTENSION_CONFIG__ || {};
    return {
      extensionName: runtime.extensionName || DEFAULT_CONFIG.extensionName,
      grafanaBaseUrl: runtime.grafanaBaseUrl || DEFAULT_CONFIG.grafanaBaseUrl,
      tempoDatasourceUid: runtime.tempoDatasourceUid || DEFAULT_CONFIG.tempoDatasourceUid,
      prometheusDatasourceUid: runtime.prometheusDatasourceUid || DEFAULT_CONFIG.prometheusDatasourceUid,
      traceLookbackMinutes: Number(runtime.traceLookbackMinutes || DEFAULT_CONFIG.traceLookbackMinutes),
      maxTraces: Number(runtime.maxTraces || DEFAULT_CONFIG.maxTraces),
      requestTimeoutMs: Number(runtime.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs)
    };
  }

  function getApplication(props) {
    return props && (props.application || props.item || props);
  }

  function getApplicationName(application) {
    return (application && application.metadata && application.metadata.name) || (application && application.name) || '';
  }

  function getApplicationNamespace(application) {
    return (application && application.metadata && application.metadata.namespace) || (application && application.namespace) || 'argocd';
  }

  function getProjectName(application) {
    return (application && application.spec && application.spec.project) || 'default';
  }

  function formatAgo(ts) {
    if (!ts) {
      return '-';
    }

    var now = Date.now();
    var then = new Date(ts).getTime();
    if (Number.isNaN(then)) {
      return '-';
    }

    var seconds = Math.max(0, Math.floor((now - then) / 1000));
    if (seconds < 60) {
      return 'just now';
    }
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return minutes + 'm ago';
    }
    var hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return hours + 'h ago';
    }
    return Math.floor(hours / 24) + 'd ago';
  }

  function formatNumber(value, suffix) {
    if (value === null || typeof value === 'undefined' || Number.isNaN(value)) {
      return '-';
    }
    var formatted = Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(2);
    return suffix ? formatted + suffix : formatted;
  }

  function buildExtensionUrl(extensionName, path) {
    return '/extensions/' + extensionName + path;
  }

  function buildHeaders(application) {
    var headers = new Headers();
    headers.set('Accept', 'application/json');
    headers.set('Argocd-Application-Name', getApplicationNamespace(application) + ':' + getApplicationName(application));
    headers.set('Argocd-Project-Name', getProjectName(application));

    try {
      var token = window.localStorage.getItem('argocd.token');
      if (token) {
        headers.set('Authorization', 'Bearer ' + token);
      }
    } catch (err) {
      // Ignore localStorage failures.
    }

    return headers;
  }

  function fetchJson(url, headers, timeoutMs) {
    var controller = new AbortController();
    var timeoutId = window.setTimeout(function() { controller.abort(); }, timeoutMs);

    return fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: headers,
      signal: controller.signal
    }).then(function(response) {
      window.clearTimeout(timeoutId);
      if (!response.ok) {
        return response.text().then(function(details) {
          throw new Error('Request failed (' + response.status + '): ' + details.slice(0, 120));
        });
      }
      return response.json();
    }).catch(function(err) {
      window.clearTimeout(timeoutId);
      throw err;
    });
  }

  function getScalarValue(payload) {
    if (!payload || !payload.data || !payload.data.result || !payload.data.result.length) {
      return null;
    }

    var first = payload.data.result[0];
    if (!first.value || first.value.length < 2) {
      return null;
    }

    return Number(first.value[1]);
  }

  function fetchTraces(config, application, headers) {
    if (!config.tempoDatasourceUid) {
      return Promise.resolve([]);
    }

    var end = Math.floor(Date.now() / 1000);
    var start = end - (config.traceLookbackMinutes * 60);
    var params = new URLSearchParams();
    params.set('start', String(start));
    params.set('end', String(end));
    params.set('limit', String(config.maxTraces));
    params.set('tags', 'service.name=' + getApplicationName(application));

    var path = '/api/datasources/proxy/' + config.tempoDatasourceUid + '/api/search?' + params.toString();
    var url = buildExtensionUrl(config.extensionName, path);

    return fetchJson(url, headers, config.requestTimeoutMs).then(function(payload) {
      var traces = Array.isArray(payload.traces) ? payload.traces : [];
      return traces.map(function(item) {
        var durationMs = typeof item.durationMs !== 'undefined' ? Number(item.durationMs) : Number((item.durationNano || 0) / 1000000);
        return {
          traceId: item.traceID || item.traceId || item.id || '',
          serviceName: item.rootServiceName || item.serviceName || '-',
          operation: item.rootTraceName || item.name || '-',
          durationMs: Number.isFinite(durationMs) ? durationMs : null,
          status: item.status || 'ok'
        };
      }).filter(function(trace) {
        return Boolean(trace.traceId);
      });
    });
  }

  function fetchRedMetrics(config, application, headers) {
    if (!config.prometheusDatasourceUid) {
      return Promise.resolve({ rate: null, errorRate: null, p99Ms: null });
    }

    var appName = getApplicationName(application);
    var metricBase = '{service_name="' + appName + '"}';
    var rateQuery = 'sum(rate(http_server_request_duration_seconds_count' + metricBase + '[5m]))';
    var errQuery = '100 * sum(rate(http_server_request_duration_seconds_count{service_name="' + appName + '",status=~"5.."}[5m])) / clamp_min(sum(rate(http_server_request_duration_seconds_count' + metricBase + '[5m])),0.0001)';
    var p99Query = '1000 * histogram_quantile(0.99, sum(rate(http_server_request_duration_seconds_bucket' + metricBase + '[5m])) by (le))';
    var base = '/api/datasources/proxy/' + config.prometheusDatasourceUid + '/api/v1/query?query=';

    return Promise.all([
      fetchJson(buildExtensionUrl(config.extensionName, base + encodeURIComponent(rateQuery)), headers, config.requestTimeoutMs).then(getScalarValue).catch(function() { return null; }),
      fetchJson(buildExtensionUrl(config.extensionName, base + encodeURIComponent(errQuery)), headers, config.requestTimeoutMs).then(getScalarValue).catch(function() { return null; }),
      fetchJson(buildExtensionUrl(config.extensionName, base + encodeURIComponent(p99Query)), headers, config.requestTimeoutMs).then(getScalarValue).catch(function() { return null; })
    ]).then(function(values) {
      return { rate: values[0], errorRate: values[1], p99Ms: values[2] };
    });
  }

  function fetchLinks(config, application, headers) {
    // Fetch context-aware links from backend
    var url = buildExtensionUrl(config.extensionName, '/api/links');
    return fetchJson(url, headers, config.requestTimeoutMs)
      .then(function(payload) {
        return {
          categories: Array.isArray(payload.categories) ? payload.categories : [],
          lastUpdated: payload.metadata ? payload.metadata.last_updated : null
        };
      })
      .catch(function() {
        return { categories: [], lastUpdated: null };
      });
  }

  function buildGrafanaTraceUrl(config, traceId) {
    if (!config.grafanaBaseUrl || !config.tempoDatasourceUid || !traceId) {
      return '';
    }

    var left = {
      datasource: config.tempoDatasourceUid,
      queries: [{ query: traceId, queryType: 'traceql' }],
      range: { from: 'now-1h', to: 'now' }
    };

    return config.grafanaBaseUrl.replace(/\/$/, '') + '/explore?left=' + encodeURIComponent(JSON.stringify(left));
  }

  function useOtelData(application) {
    var _React$useState = React.useState({
      loading: true,
      error: '',
      traces: [],
      metrics: { rate: null, errorRate: null, p99Ms: null },
      categories: [],
      lastUpdated: null,
      config: readConfig()
    });
    var state = _React$useState[0];
    var setState = _React$useState[1];

    var appName = getApplicationName(application);
    var appNamespace = getApplicationNamespace(application);
    var projectName = getProjectName(application);

    React.useEffect(function() {
      if (!appName) {
        setState(function(prev) {
          return Object.assign({}, prev, { loading: false, error: 'Application context is not available', traces: [], lastUpdated: null });
        });
        return;
      }

      var active = true;
      var config = readConfig();
      var headers = buildHeaders(application);

      setState(function(prev) {
        return Object.assign({}, prev, { loading: true, error: '', config: config });
      });

      Promise.all([
        fetchTraces(config, application, headers),
        fetchRedMetrics(config, application, headers),
        fetchLinks(config, application, headers)
      ]).then(function(results) {
        if (!active) {
          return;
        }
        setState({
          loading: false,
          error: '',
          traces: results[0],
          metrics: results[1],
          categories: results[2].categories,
          lastUpdated: new Date().toISOString(),
          config: config
        });
      }).catch(function(err) {
        if (!active) {
          return;
        }
        setState(function(prev) {
          return Object.assign({}, prev, {
            loading: false,
            error: err && err.message ? err.message : 'Observability backend unavailable',
            traces: [],
            metrics: { rate: null, errorRate: null, p99Ms: null },
            categories: [],
            lastUpdated: null
          });
        });
      });

      return function() {
        active = false;
      };
    }, [appName, appNamespace, projectName]);

    return state;
  }

  function metricTile(label, value) {
    return React.createElement(
      'div',
      { style: { border: '1px solid #e2e8f0', borderRadius: '6px', padding: '8px', backgroundColor: '#f8fafc' } },
      React.createElement('div', { style: { fontSize: '11px', color: '#475569', marginBottom: '4px' } }, label),
      React.createElement('div', { style: { fontWeight: 700, fontSize: '14px', color: '#0f172a' } }, value)
    );
  }

  function StatusPanel(props) {
    var application = getApplication(props);
    var appName = getApplicationName(application);
    var state = useOtelData(application);

    if (!appName) {
      return React.createElement('div', { style: { padding: '8px', fontSize: '12px', color: '#64748b' } }, 'OTEL: app not found');
    }

    return React.createElement(
      'div',
      { style: { padding: '8px', border: '1px solid #dbeafe', borderRadius: '6px', backgroundColor: '#ffffff' } },
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '8px', color: '#475569' } },
        React.createElement('span', { style: { fontWeight: 700 } }, 'OTEL'),
        React.createElement('span', null, 'v' + __EXTENSION_VERSION__)
      ),
      state.loading && React.createElement('div', { style: { fontSize: '12px', color: '#1d4ed8' } }, 'Loading telemetry...'),
      !state.loading && state.error && React.createElement('div', { style: { fontSize: '12px', color: '#b45309' } }, 'Observability unavailable'),
      !state.loading && !state.error && React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } },
        metricTile('Rate', formatNumber(state.metrics.rate, '/s')),
        metricTile('Error %', formatNumber(state.metrics.errorRate, '%')),
        metricTile('P99', formatNumber(state.metrics.p99Ms, 'ms')),
        metricTile('Traces', String(state.traces.length))
      ),
      React.createElement('div', { style: { marginTop: '8px', fontSize: '10px', color: '#64748b' } }, 'Updated: ' + formatAgo(state.lastUpdated))
    );
  }

  function tracesTable(traces, config) {
    if (!traces.length) {
      return React.createElement('div', { style: { fontSize: '12px', color: '#64748b', padding: '8px 0' } }, 'No traces found for this service in the selected lookback window.');
    }

    return React.createElement(
      'table',
      { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } },
      React.createElement('thead', null,
        React.createElement('tr', { style: { textAlign: 'left', borderBottom: '1px solid #e2e8f0' } },
          React.createElement('th', { style: { padding: '6px' } }, 'Trace ID'),
          React.createElement('th', { style: { padding: '6px' } }, 'Service'),
          React.createElement('th', { style: { padding: '6px' } }, 'Operation'),
          React.createElement('th', { style: { padding: '6px' } }, 'Duration'),
          React.createElement('th', { style: { padding: '6px' } }, 'Status')
        )
      ),
      React.createElement('tbody', null,
        traces.slice(0, 15).map(function(trace) {
          var traceLink = buildGrafanaTraceUrl(config, trace.traceId);
          return React.createElement('tr', { key: trace.traceId, style: { borderBottom: '1px solid #f1f5f9' } },
            React.createElement('td', { style: { padding: '6px' } },
              traceLink
                ? React.createElement('a', { href: traceLink, target: '_blank', rel: 'noopener noreferrer', style: { color: '#1d4ed8', textDecoration: 'none' } }, trace.traceId.slice(0, 12) + '...')
                : trace.traceId.slice(0, 12) + '...'
            ),
            React.createElement('td', { style: { padding: '6px' } }, trace.serviceName || '-'),
            React.createElement('td', { style: { padding: '6px' } }, trace.operation || '-'),
            React.createElement('td', { style: { padding: '6px' } }, formatNumber(trace.durationMs, 'ms')),
            React.createElement('td', { style: { padding: '6px' } }, trace.status || 'ok')
          );
        })
      )
    );
  }

  function linksComponent(categories) {
    if (!categories || categories.length === 0) {
      return null;
    }

    return React.createElement('div', { style: { marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #e2e8f0' } },
      React.createElement('div', { style: { marginBottom: '8px', fontWeight: 600, fontSize: '12px', color: '#334155' } }, 'Context Links'),
      React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        categories.map(function(category, idx) {
          var links = category.links || [];
          var isSingleLink = links.length === 1;
          var hasLinks = links.length > 0 && category.status === 'ok';
          
          if (!hasLinks) {
            return null;
          }

          if (isSingleLink) {
            return React.createElement('a', {
              key: idx,
              href: links[0].url,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                padding: '6px 10px',
                backgroundColor: '#dbeafe',
                border: '1px solid #93c5fd',
                borderRadius: '4px',
                color: '#1d4ed8',
                textDecoration: 'none',
                fontSize: '11px',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.2s ease'
              }
            },
              category.icon ? React.createElement('span', { style: { marginRight: '4px' } }, category.icon) : null,
              category.label
            );
          }

          return React.createElement('div', { key: idx, style: { position: 'relative' } },
            React.createElement('div', {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                padding: '6px 10px',
                backgroundColor: '#dbeafe',
                border: '1px solid #93c5fd',
                borderRadius: '4px',
                color: '#1d4ed8',
                fontSize: '11px',
                fontWeight: 500,
                cursor: 'pointer'
              }
            },
              category.icon ? React.createElement('span', { style: { marginRight: '4px' } }, category.icon) : null,
              category.label,
              React.createElement('span', { style: { marginLeft: '6px', fontSize: '9px' } }, '▼')
            ),
            React.createElement('div', {
              style: {
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: '4px',
                backgroundColor: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: '4px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                zIndex: 10,
                minWidth: '150px',
                overflow: 'hidden'
              }
            },
              links.map(function(link, linkIdx) {
                return React.createElement('a', {
                  key: linkIdx,
                  href: link.url,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  style: {
                    display: 'block',
                    padding: '8px 10px',
                    textDecoration: 'none',
                    color: '#0f172a',
                    fontSize: '11px',
                    borderBottom: linkIdx < links.length - 1 ? '1px solid #f1f5f9' : 'none',
                    backgroundColor: 'transparent',
                    cursor: 'pointer',
                    transition: 'background-color 0.15s'
                  },
                  onMouseEnter: function(e) { e.target.style.backgroundColor = '#f8fafc'; },
                  onMouseLeave: function(e) { e.target.style.backgroundColor = 'transparent'; }
                }, link.label || link.url);
              })
            )
          );
        })
      )
    );
  }

  function AppView(props) {
    var application = getApplication(props);
    var appName = getApplicationName(application);
    var state = useOtelData(application);

    if (!appName) {
      return React.createElement('div', { style: { padding: '12px', color: '#64748b' } }, 'Application context is not available.');
    }

    return React.createElement(
      'div',
      { style: { padding: '12px', backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '6px' } },
      React.createElement('h3', { style: { margin: '0 0 10px 0', fontSize: '14px', color: '#0f172a' } }, 'Observability: ' + appName),
      state.loading && React.createElement('div', { style: { fontSize: '12px', color: '#1d4ed8', marginBottom: '8px' } }, 'Loading traces and RED metrics...'),
      !state.loading && state.error && React.createElement('div', { style: { fontSize: '12px', color: '#b45309', marginBottom: '8px' } }, 'Unable to query OTEL backend: ' + state.error),
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(120px, 1fr))', gap: '8px', marginBottom: '12px' } },
        metricTile('Rate (req/s)', formatNumber(state.metrics.rate, '/s')),
        metricTile('Error %', formatNumber(state.metrics.errorRate, '%')),
        metricTile('P99 Latency', formatNumber(state.metrics.p99Ms, 'ms'))
      ),
      React.createElement('div', { style: { marginBottom: '8px', fontWeight: 600, fontSize: '12px', color: '#334155' } }, 'Recent traces'),
      tracesTable(state.traces, state.config),
      linksComponent(state.categories),
      React.createElement('div', { style: { marginTop: '8px', fontSize: '11px', color: '#64748b' } }, 'Updated: ' + formatAgo(state.lastUpdated))
    );
  }

  function initExtension() {
    if (typeof window.extensionsAPI === 'undefined') {
      setTimeout(initExtension, 500);
      return;
    }

    var extensionsAPI = window.extensionsAPI;

    if (typeof extensionsAPI.registerStatusPanelExtension === 'function') {
      extensionsAPI.registerStatusPanelExtension(StatusPanel, 'OTEL', 'otel');
    }
    if (typeof extensionsAPI.registerAppViewExtension === 'function') {
      extensionsAPI.registerAppViewExtension(AppView, 'Observability', 'fa-heartbeat');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExtension);
  } else {
    initExtension();
  }
})();
