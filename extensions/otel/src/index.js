(function() {
  'use strict';

  var DEFAULT_CONFIG = {
    extensionName: 'otel-extension',
    requestTimeoutMs: 8000
  };

  function toPositiveInt(value, fallback) {
    var n = Number(value);
    // Require a positive *integer*: a fractional value like 0.5 would make
    // setTimeout(fn, 0.5) fire almost immediately -- the same near-instant-abort
    // failure mode we reject NaN/invalid config for. Round down so a benign
    // "8000.0" still works, then re-check it stayed positive (floor of a negative
    // or NaN can't be > 0, so it falls back).
    n = Math.floor(n);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  // Only allow links to navigate to http(s) URLs or absolute same-origin paths
  // (a single leading "/", e.g. "/foo"); bare relative paths and every other
  // scheme are rejected. Backend-supplied URLs are untrusted; a `javascript:`/
  // `data:` href would execute in the Argo CD origin (XSS) when clicked.
  function safeHref(url) {
    if (typeof url !== 'string') {
      return null;
    }
    // Strip tab/newline/CR anywhere in the string BEFORE the scheme/path checks:
    // the URL parser removes U+0009/U+000A/U+000D during parsing, so "/\t/evil.com"
    // would pass the "single leading slash" test here yet resolve to the
    // protocol-relative "//evil.com" (cross-origin) once the browser parses it.
    var trimmed = url.replace(/[\t\n\r]/g, '').trim();
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

  function readConfig() {
    var runtime = window.__OTEL_EXTENSION_CONFIG__ || {};
    return {
      extensionName: runtime.extensionName || DEFAULT_CONFIG.extensionName,
      // Guard against non-numeric config: Number('fast') -> NaN, and
      // setTimeout(fn, NaN) fires immediately, aborting every request.
      requestTimeoutMs: toPositiveInt(runtime.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs)
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

  // Logo shown in place of the old "OTEL" header. Overridable via runtime config
  // (window.__OTEL_EXTENSION_CONFIG__.logoUrl); defaults to the GlueOps GitHub avatar.
  // Run the override through safeHref as scheme hardening only: it rejects
  // javascript:/data:/other non-http(s) schemes and scheme-relative ("//host")
  // tricks, falling back to the default when unusable. NOTE: safeHref allows ANY
  // http(s) host -- this is NOT a host allowlist, so a configured logoUrl can
  // still load cross-origin, as the default github.com avatar already does.
  var DEFAULT_LOGO_URL = 'https://github.com/GlueOps.png';
  var GLUEOPS_LOGO_URL = safeHref(window.__OTEL_EXTENSION_CONFIG__ && window.__OTEL_EXTENSION_CONFIG__.logoUrl) || DEFAULT_LOGO_URL;

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
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        if (document.body) {
          // Argo CD toggles the `theme-*` class on the root/body element. Observe
          // only those two nodes' class attribute -- NOT the whole subtree, which
          // would fire the callback on every unrelated DOM class change.
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

  // Links are derived from the Application's identity and its deployment-config
  // repo, so they are effectively static for the life of a page view. Argo CD
  // remounts status-panel extensions whenever the Application object updates --
  // with `timeout.reconciliation: 10s` in argocd-cm that is every ~10s -- and a
  // remount resets useState, so without this cache every reconcile blanked the
  // links behind "Loading links...". Keyed per application so switching apps
  // never shows another app's links.
  var linksCache = {};
  var CACHE_TTL_MS = 5 * 60 * 1000;

  function cacheKey(namespace, name) {
    return namespace + '/' + name;
  }

  function useOtelData(application) {
    var appName = getApplicationName(application);
    var appNamespace = getApplicationNamespace(application);
    var projectName = getProjectName(application);
    var key = cacheKey(appNamespace, appName);

    // Lazy initializer: on a remount this renders the cached links immediately
    // rather than flashing the loading state.
    var _React$useState = React.useState(function() {
      var cached = appName ? linksCache[key] : null;
      return {
        loading: !cached,
        error: '',
        categories: cached ? cached.categories : [],
        lastUpdated: cached ? cached.lastUpdated : null,
        config: readConfig()
      };
    });
    var state = _React$useState[0];
    var setState = _React$useState[1];

    React.useEffect(function() {
      if (!appName) {
        setState(function(prev) {
          return Object.assign({}, prev, { loading: false, error: 'Application context is not available', lastUpdated: null });
        });
        return;
      }

      var cached = linksCache[key];
      var fresh = cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS;
      if (fresh) {
        // Nothing to do: the lazy initializer already rendered these links.
        return;
      }

      var active = true;
      var config = readConfig();
      var headers = buildHeaders(application);

      // Only blank the panel when there is nothing to show. A stale cache is
      // revalidated silently, so the links stay on screen while it refetches.
      if (!cached) {
        setState(function(prev) {
          return Object.assign({}, prev, { loading: true, error: '', config: config });
        });
      }

      fetchLinks(config, application, headers).then(function(result) {
        if (!active) {
          return;
        }
        // fetchLinks swallows transport errors and resolves with an empty
        // category list, so "empty" is indistinguishable from "backend down".
        // Never let that replace links already on screen, and never cache it --
        // leaving the entry untouched means the next remount retries instead of
        // serving an empty panel for the whole TTL.
        if (cached && cached.categories.length > 0 && result.categories.length === 0) {
          setState(function(prev) {
            return Object.assign({}, prev, { loading: false });
          });
          return;
        }

        var lastUpdated = result.lastUpdated || new Date().toISOString();
        linksCache[key] = {
          categories: result.categories,
          lastUpdated: lastUpdated,
          fetchedAt: Date.now()
        };
        setState({
          loading: false,
          error: '',
          categories: result.categories,
          lastUpdated: lastUpdated,
          config: config
        });
      }).catch(function(err) {
        if (!active) {
          return;
        }
        setState(function(prev) {
          // A failed background revalidation must not throw away links that are
          // already on screen -- keep showing the stale set rather than
          // replacing a working panel with "Observability unavailable".
          if (cached) {
            return Object.assign({}, prev, { loading: false });
          }
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
      !state.loading && !state.error && linksComponent(state.categories, palette)
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
          var rawLinks = Array.isArray(category.links) ? category.links : [];
          // Backend-supplied URLs are untrusted. Only links that survive safeHref
          // are renderable, and every downstream decision -- single-vs-dropdown,
          // whether the category shows at all -- is based on THIS list, not the raw
          // one. Otherwise a category whose links were all rejected would render an
          // empty dropdown and keep the panel visible when it should have hidden.
          var links = rawLinks.filter(function(link) { return link && safeHref(link.url); });
          var isSingleLink = links.length === 1;
          var forceExpandable = category.id === 'vault-secrets' || category.id === 'deployment-config';
          // Render whenever the backend gave us links. A 'degraded' category still
          // carries working links -- it means a detail could not be confirmed (e.g.
          // no Deployment exists, so the app name is used as the workload selector),
          // not that the links are wrong. Gating on status === 'ok' hid every
          // category except deployment-config, which is the only one the backend
          // ever marks ok, so the panel rendered as a single Config Repo button.
          var hasLinks = links.length > 0;
          var degradedHint = category.status === 'degraded'
            ? 'Best-effort: the exact workload could not be determined, so these links filter on the application name.'
            : undefined;
          // Suffix the index so two categories sharing an id (or a missing id)
          // cannot collide into the same React key.
          var categoryKey = (category.id != null ? category.id : 'cat') + '-' + idx;

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
            return React.createElement('a', {
              key: categoryKey,
              href: safeHref(links[0].url),
              target: '_blank',
              rel: 'noopener noreferrer',
              title: degradedHint,
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
              React.createElement('summary', { title: degradedHint, style: { cursor: 'pointer', listStyle: 'none' } },
                category.icon ? React.createElement('span', { style: { marginRight: '4px' } }, category.icon) : null,
                category.label,
                React.createElement('span', { style: { marginLeft: '6px', fontSize: '9px' } }, '▼')
              ),
              React.createElement('div', { style: { marginTop: '6px', backgroundColor: palette.menuBg, border: palette.menuBorder, borderRadius: '4px', overflow: 'hidden', minWidth: '220px' } },
              links.map(function(link, linkIdx) {
                return React.createElement('a', {
                  key: linkIdx,
                  href: safeHref(link.url),
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
