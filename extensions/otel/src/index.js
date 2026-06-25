(function() {
  'use strict';

  var DEFAULT_CONFIG = {
    extensionName: 'otel-extension',
    requestTimeoutMs: 8000
  };

  function readConfig() {
    var runtime = window.__OTEL_EXTENSION_CONFIG__ || {};
    return {
      extensionName: runtime.extensionName || DEFAULT_CONFIG.extensionName,
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

  function useOtelData(application) {
    var _React$useState = React.useState({
      loading: true,
      error: '',
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
          return Object.assign({}, prev, { loading: false, error: 'Application context is not available', lastUpdated: null });
        });
        return;
      }

      var active = true;
      var config = readConfig();
      var headers = buildHeaders(application);

      setState(function(prev) {
        return Object.assign({}, prev, { loading: true, error: '', config: config });
      });

      fetchLinks(config, application, headers).then(function(result) {
        if (!active) {
          return;
        }
        setState({
          loading: false,
          error: '',
          categories: result.categories,
          lastUpdated: result.lastUpdated || new Date().toISOString(),
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
      state.loading && React.createElement('div', { style: { fontSize: '12px', color: '#1d4ed8' } }, 'Loading links...'),
      !state.loading && state.error && React.createElement('div', { style: { fontSize: '12px', color: '#b45309' } }, 'Observability unavailable'),
      !state.loading && !state.error && linksComponent(state.categories),
      React.createElement('div', { style: { marginTop: '8px', fontSize: '10px', color: '#64748b' } }, 'Updated: ' + formatAgo(state.lastUpdated))
    );
  }

  function linksComponent(categories) {
    if (!categories || categories.length === 0) {
      return null;
    }

    return React.createElement('div', { style: { marginTop: '8px' } },
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
            React.createElement('details', {
              style: {
                display: 'inline-flex',
                padding: '6px 10px',
                backgroundColor: '#dbeafe',
                border: '1px solid #93c5fd',
                borderRadius: '4px',
                color: '#1d4ed8',
                fontSize: '11px',
                fontWeight: 500
              }
            },
              React.createElement('summary', { style: { cursor: 'pointer', listStyle: 'none' } },
                category.icon ? React.createElement('span', { style: { marginRight: '4px' } }, category.icon) : null,
                category.label,
                React.createElement('span', { style: { marginLeft: '6px', fontSize: '9px' } }, '▼')
              ),
              React.createElement('div', { style: { marginTop: '6px', backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '4px', overflow: 'hidden', minWidth: '220px' } },
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
                    cursor: 'pointer'
                  }
                }, link.label || link.url);
              })
            ))
          );
        })
      )
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExtension);
  } else {
    initExtension();
  }
})();
