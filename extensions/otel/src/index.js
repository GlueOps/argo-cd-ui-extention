(function() {
  'use strict';

  var DEFAULT_CONFIG = {
    extensionName: 'otel-extension',
    requestTimeoutMs: 8000
  };

  function toPositiveInt(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function readConfig() {
    var runtime = window.__OTEL_EXTENSION_CONFIG__ || {};
    return {
      extensionName: runtime.extensionName || DEFAULT_CONFIG.extensionName,
      // Guard against non-numeric config: Number('fast') -> NaN, and
      // setTimeout(fn, NaN) fires immediately, aborting every request.
      requestTimeoutMs: toPositiveInt(runtime.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs)
    };
  }

  // Only allow links to navigate to http(s) or same-origin relative paths.
  // Backend-supplied URLs are untrusted; a `javascript:`/`data:` href would
  // execute in the Argo CD origin (XSS) when clicked.
  function safeHref(url) {
    if (typeof url !== 'string') {
      return null;
    }
    var trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    // Same-origin absolute path only. Reject a second "/" OR "\" after the
    // leading slash: browsers normalize "\" to "/" for special schemes, so
    // "/\evil.com" (and "//host") resolve cross-origin -- an open redirect.
    if (/^\/(?![/\\])/.test(trimmed)) {
      return trimmed;
    }
    return null;
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

  // Logo shown in place of the old "OTEL" header. Overridable via runtime config
  // (window.__OTEL_EXTENSION_CONFIG__.logoUrl); defaults to the GlueOps GitHub avatar.
  var GLUEOPS_LOGO_URL = (window.__OTEL_EXTENSION_CONFIG__ && window.__OTEL_EXTENSION_CONFIG__.logoUrl) || 'https://github.com/GlueOps.png';

  // Detect the active Argo CD theme. Argo CD wraps its UI in a `.theme-dark` / `.theme-light`
  // element; fall back to the OS preference when neither is present.
  function detectTheme() {
    try {
      if (document.querySelector('.theme-dark')) {
        return 'dark';
      }
      if (document.querySelector('.theme-light')) {
        return 'light';
      }
    } catch (err) {
      // Ignore DOM access failures.
    }
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  // Track the theme reactively so the panel re-colors when the user toggles dark/light.
  function useArgoTheme() {
    var _React$useState = React.useState(detectTheme());
    var theme = _React$useState[0];
    var setTheme = _React$useState[1];

    React.useEffect(function() {
      var update = function() { setTheme(detectTheme()); };
      var observer = new MutationObserver(update);
      try {
        // Argo CD toggles the `theme-*` class on the root/body element. Observe
        // only those two nodes' class attribute -- NOT the whole subtree, which
        // would fire the callback on every unrelated DOM class change.
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        if (document.body) {
          observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        }
      } catch (err) {
        // Ignore observe failures.
      }
      update();
      return function() { observer.disconnect(); };
    }, []);

    return theme;
  }

  function getPalette(theme) {
    if (theme === 'dark') {
      return {
        panelBg: 'transparent',
        panelBorder: '1px solid rgba(255, 255, 255, 0.14)',
        heading: '#dce3e8',
        muted: '#8fa3b0',
        loading: '#6cb1ff',
        warn: '#e0a458',
        chipBg: 'rgba(108, 177, 255, 0.12)',
        chipBorder: '1px solid rgba(108, 177, 255, 0.35)',
        chipText: '#6cb1ff',
        neutralChipBg: 'rgba(255, 255, 255, 0.06)',
        neutralChipBorder: '1px solid rgba(255, 255, 255, 0.16)',
        neutralChipText: '#b8c4ce',
        menuBg: '#1f2933',
        menuBorder: '1px solid rgba(255, 255, 255, 0.14)',
        menuItemText: '#dce3e8',
        menuDivider: '1px solid rgba(255, 255, 255, 0.08)'
      };
    }
    return {
      panelBg: 'transparent',
      panelBorder: '1px solid #dbeafe',
      heading: '#334155',
      muted: '#64748b',
      loading: '#1d4ed8',
      warn: '#b45309',
      chipBg: '#dbeafe',
      chipBorder: '1px solid #93c5fd',
      chipText: '#1d4ed8',
      neutralChipBg: '#f1f5f9',
      neutralChipBorder: '1px solid #cbd5e1',
      neutralChipText: '#475569',
      menuBg: '#ffffff',
      menuBorder: '1px solid #e2e8f0',
      menuItemText: '#0f172a',
      menuDivider: '1px solid #f1f5f9'
    };
  }

  // GlueOps logo with a graceful text fallback if the image can't load (e.g. CSP/offline).
  function GlueOpsLogo() {
    var _React$useState = React.useState(false);
    var failed = _React$useState[0];
    var setFailed = _React$useState[1];

    if (failed) {
      return React.createElement('span', { style: { fontWeight: 700, fontSize: '13px', letterSpacing: '0.2px', color: 'inherit' } }, 'GlueOps');
    }

    return React.createElement('img', {
      src: GLUEOPS_LOGO_URL,
      alt: 'GlueOps',
      style: { height: '20px', width: 'auto', display: 'block' },
      onError: function() { setFailed(true); }
    });
  }

  function buildExtensionUrl(extensionName, path) {
    return '/extensions/' + extensionName + path;
  }

  // Takes the already-derived identity primitives (not the raw application
  // object) so callers depend only on those values -- keeps effect dependency
  // arrays honest and re-reads the token fresh on every call.
  function buildHeaders(appNamespace, appName, projectName) {
    var headers = new Headers();
    headers.set('Accept', 'application/json');
    headers.set('Argocd-Application-Name', appNamespace + ':' + appName);
    headers.set('Argocd-Project-Name', projectName);

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

  function fetchLinks(config, headers) {
    // Fetch context-aware links from backend
    var url = buildExtensionUrl(config.extensionName, '/api/links');
    // Do NOT swallow failures here: let network/HTTP errors reject so the
    // caller can surface "Observability unavailable" instead of an empty panel
    // that looks identical to "this app genuinely has no links". A malformed but
    // successful (2xx) body is tolerated as "no links", not an error.
    return fetchJson(url, headers, config.requestTimeoutMs)
      .then(function(payload) {
        var safe = payload && typeof payload === 'object' ? payload : {};
        return {
          categories: Array.isArray(safe.categories) ? safe.categories : [],
          lastUpdated: safe.metadata ? safe.metadata.last_updated : null
        };
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
      var headers = buildHeaders(appNamespace, appName, projectName);

      setState(function(prev) {
        return Object.assign({}, prev, { loading: true, error: '', config: config });
      });

      fetchLinks(config, headers).then(function(result) {
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
    var theme = useArgoTheme();
    var palette = getPalette(theme);
    var state = useOtelData(application);

    if (!appName) {
      return React.createElement('div', { style: { padding: '8px', fontSize: '12px', color: palette.muted } }, 'Application context not available');
    }

    return React.createElement(
      'div',
      { style: { padding: '8px', border: palette.panelBorder, borderRadius: '6px', backgroundColor: palette.panelBg, color: 'inherit' } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } },
        React.createElement(GlueOpsLogo, null)
      ),
      state.loading && React.createElement('div', { style: { fontSize: '12px', color: palette.loading } }, 'Loading links...'),
      !state.loading && state.error && React.createElement('div', { style: { fontSize: '12px', color: palette.warn } }, 'Observability unavailable'),
      !state.loading && !state.error && state.categories.length > 0 && linksComponent(state.categories, palette),
      !state.loading && !state.error && state.categories.length === 0 && React.createElement('div', { style: { fontSize: '12px', color: palette.muted } }, 'No links available')
    );
  }

  function linksComponent(categories, palette) {
    if (!categories || categories.length === 0) {
      return null;
    }

    return React.createElement('div', { style: { marginTop: '8px' } },
      React.createElement('div', { style: { marginBottom: '8px', fontWeight: 600, fontSize: '12px', color: palette.heading } }, 'Context Links'),
      React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        categories.map(function(category, idx) {
          if (!category || typeof category !== 'object') {
            return null;
          }
          var categoryKey = category.id || idx;
          var links = Array.isArray(category.links) ? category.links : [];
          var isSingleLink = links.length === 1;
          var forceExpandable = category.id === 'vault-secrets' || category.id === 'deployment-config';
          var hasLinks = links.length > 0 && category.status === 'ok';

          if (category.id === 'vault-secrets' && category.status === 'ok' && links.length === 0) {
            return React.createElement('span', {
              key: categoryKey,
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                padding: '6px 10px',
                backgroundColor: palette.neutralChipBg,
                border: palette.neutralChipBorder,
                borderRadius: '4px',
                color: palette.neutralChipText,
                fontSize: '11px',
                fontWeight: 500
              }
            },
              category.icon ? React.createElement('span', { style: { marginRight: '4px' } }, category.icon) : null,
              category.label
            );
          }

          if (!hasLinks) {
            return null;
          }

          if (isSingleLink && !forceExpandable) {
            var singleHref = links[0] && safeHref(links[0].url);
            if (!singleHref) {
              return null;
            }
            return React.createElement('a', {
              key: categoryKey,
              href: singleHref,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                padding: '6px 10px',
                backgroundColor: palette.chipBg,
                border: palette.chipBorder,
                borderRadius: '4px',
                color: palette.chipText,
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

          return React.createElement('div', { key: categoryKey, style: { position: 'relative' } },
            React.createElement('details', {
              style: {
                display: 'inline-flex',
                padding: '6px 10px',
                backgroundColor: palette.chipBg,
                border: palette.chipBorder,
                borderRadius: '4px',
                color: palette.chipText,
                fontSize: '11px',
                fontWeight: 500
              }
            },
              React.createElement('summary', { style: { cursor: 'pointer', listStyle: 'none' } },
                category.icon ? React.createElement('span', { style: { marginRight: '4px' } }, category.icon) : null,
                category.label,
                React.createElement('span', { style: { marginLeft: '6px', fontSize: '9px' } }, '▼')
              ),
              React.createElement('div', { style: { marginTop: '6px', backgroundColor: palette.menuBg, border: palette.menuBorder, borderRadius: '4px', overflow: 'hidden', minWidth: '220px' } },
              links.map(function(link, linkIdx) {
                var linkHref = link && safeHref(link.url);
                if (!linkHref) {
                  return null;
                }
                return React.createElement('a', {
                  key: link.url || linkIdx,
                  href: linkHref,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  style: {
                    display: 'block',
                    padding: '8px 10px',
                    textDecoration: 'none',
                    color: palette.menuItemText,
                    fontSize: '11px',
                    borderBottom: linkIdx < links.length - 1 ? palette.menuDivider : 'none',
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
      extensionsAPI.registerStatusPanelExtension(StatusPanel, 'GlueOps', 'otel');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExtension);
  } else {
    initExtension();
  }
})();
