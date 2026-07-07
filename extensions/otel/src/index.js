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

  function readConfig() {
    var runtime = window.__OTEL_EXTENSION_CONFIG__ || {};
    return {
      extensionName: runtime.extensionName || DEFAULT_CONFIG.extensionName,
      // Guard against non-numeric config: Number('fast') -> NaN, and
      // setTimeout(fn, NaN) fires immediately, aborting every request.
      requestTimeoutMs: toPositiveInt(runtime.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs)
    };
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

  function getApplication(props) {
    return props && (props.application || props.item || props);
  }

  function getApplicationName(application) {
    return (application && application.metadata && application.metadata.name) || (application && application.name) || '';
  }

  // NOTE: these feed the Argocd-Application-Name (`<ns>:<name>`) and
  // Argocd-Project-Name proxy headers, which Argo CD's proxy-extension uses to
  // AUTHORIZE the request. The 'argocd'/'default' fallbacks are only safe for the
  // common single-namespace/default-project install; with apps-in-any-namespace or
  // non-default AppProjects a wrong fallback yields a 403 (surfaced as a
  // `[otel-extension]` console warning, panel stays blank). The status-panel props
  // Argo passes do carry metadata.namespace and spec.project, so the fallbacks
  // should not trigger in practice -- keep them only as a last resort.
  function getApplicationNamespace(application) {
    return (application && application.metadata && application.metadata.namespace) || (application && application.namespace) || 'argocd';
  }

  function getProjectName(application) {
    return (application && application.spec && application.spec.project) || 'default';
  }

  // Logo shown in place of the old "OTEL" header. Overridable via runtime config
  // (window.__OTEL_EXTENSION_CONFIG__.logoUrl); defaults to the GlueOps GitHub avatar
  // (which is itself cross-origin). Run the override through safeHref as scheme/
  // protocol hardening only: it rejects javascript:/data:/other non-http(s) schemes
  // and scheme-relative ("//host") tricks, falling back to the default when the value
  // is unusable. NOTE: safeHref allows ANY http(s) host -- this is NOT a same-origin
  // or host allowlist, so a configured http(s) logoUrl can still load cross-origin
  // (as the default github.com avatar already does).
  var DEFAULT_LOGO_URL = 'https://github.com/GlueOps.png';
  var CONFIGURED_LOGO_URL = window.__OTEL_EXTENSION_CONFIG__ && window.__OTEL_EXTENSION_CONFIG__.logoUrl;
  var GLUEOPS_LOGO_URL = safeHref(CONFIGURED_LOGO_URL) || DEFAULT_LOGO_URL;

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
    // caller (useOtelData) can distinguish an outage from an empty result and
    // set state.error. StatusPanel renders a blank/hidden panel on error today,
    // but keeping error and "genuinely no links" as distinct states preserves
    // that choice for the UI. A malformed but successful (2xx) body is tolerated
    // as "no links", not an error.
    return fetchJson(url, headers, config.requestTimeoutMs)
      .then(function(payload) {
        var safe = payload && typeof payload === 'object' ? payload : {};
        return {
          categories: Array.isArray(safe.categories) ? safe.categories : [],
          lastUpdated: safe.metadata ? safe.metadata.last_updated : null,
          // The backend flags best-effort/guessed results via top-level
          // status: 'degraded' + warnings[]. Surface them so the user knows the
          // links below may be inferred rather than confirmed.
          warnings: Array.isArray(safe.warnings) ? safe.warnings : []
        };
      });
  }

  function useOtelData(application) {
    var _React$useState = React.useState({
      loading: true,
      error: '',
      categories: [],
      warnings: [],
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
          warnings: result.warnings || [],
          lastUpdated: result.lastUpdated || new Date().toISOString(),
          config: config
        });
      }).catch(function(err) {
        if (!active) {
          return;
        }
        // The panel renders nothing on error (StatusPanel returns null) so a
        // missing backend blends in, but a genuinely broken/misrouted/401 backend
        // must still leave a signal for operators -- otherwise it is undiagnosable
        // from the UI. Log it; keep the render blank.
        try {
          console.warn('[otel-extension] failed to load context links:', err);
        } catch (logErr) {
          // Ignore console failures.
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

    // Fail gracefully with a blank panel that blends into the Argo CD UI. When
    // there is no application context, the extension is still loading, the
    // backend is unavailable/errored, or it returned no renderable links, render
    // NOTHING (return null) instead of a bordered box with a status message.
    // This lets the extension be deployed ahead of -- or without -- its backend:
    // no panel appears until real links are actually available, so a missing
    // backend is indistinguishable from a normal app that simply has no links.
    if (!appName || state.loading || state.error) {
      return null;
    }

    // linksComponent returns null both when there are no categories AND when
    // categories exist but every one was filtered out (e.g. all non-ok/degraded
    // status, or all URLs rejected by safeHref).
    var linksEl = linksComponent(state.categories, palette);
    if (!linksEl) {
      return null;
    }

    // Surface backend warnings[] (e.g. "workload names could not be discovered ...",
    // "application targets a remote cluster ...") as a small notice so a degraded
    // response is explained rather than looking like a normal one with fewer links.
    var warnings = Array.isArray(state.warnings) ? state.warnings : [];
    var warningsEl = warnings.length === 0 ? null : React.createElement(
      'div',
      { style: { marginTop: '8px', fontSize: '10px', color: palette.neutralChipText, opacity: 0.85 } },
      warnings.map(function(w, i) {
        return React.createElement('div', { key: 'warn-' + i }, '⚠ ' + w);
      })
    );

    return React.createElement(
      'div',
      { style: { padding: '8px', border: palette.panelBorder, borderRadius: '6px', backgroundColor: palette.panelBg, color: 'inherit' } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } },
        React.createElement(GlueOpsLogo, null)
      ),
      linksEl,
      warningsEl
    );
  }

  function linksComponent(categories, palette) {
    if (!categories || categories.length === 0) {
      return null;
    }

    var rendered = categories.map(function(category, idx) {
          if (!category || typeof category !== 'object') {
            return null;
          }
          // Suffix the index so two categories sharing an id (or a missing id)
          // can't collide into the same React key.
          var categoryKey = (category.id != null ? category.id : 'cat') + '-' + idx;
          var links = Array.isArray(category.links) ? category.links : [];
          // 'degraded' means the backend discovered workloads by best-effort guess
          // (e.g. status.resources[] was empty). The links still point somewhere
          // useful, so render them like 'ok' but mark them as inferred -- previously
          // any non-'ok' status hid the whole category, silently dropping links a
          // user could still follow.
          var renderableStatus = category.status === 'ok' || category.status === 'degraded';
          var isDegraded = category.status === 'degraded';
          // Only links whose URL passes safeHref are actually renderable (unsafe
          // ones map to null). Base renderability, single-vs-dropdown, and the
          // divider logic on THIS list, not the raw one -- otherwise an all-unsafe
          // category renders an empty dropdown and keeps the panel visible when it
          // should have been hidden.
          var safeLinks = renderableStatus
            ? links.filter(function(link) { return link && safeHref(link.url); })
            : [];
          var isSingleLink = safeLinks.length === 1;
          var forceExpandable = category.id === 'vault-secrets' || category.id === 'deployment-config';
          var hasLinks = safeLinks.length > 0;
          // Backend moved the secret count out of the label into a `count` field;
          // re-append it (and mark inferred categories) so the chip is as
          // informative as before without expanding it.
          var countSuffix = typeof category.count === 'number' ? ' (' + category.count + ')' : '';
          var categoryLabel = (category.label || '') + countSuffix + (isDegraded ? ' ~' : '');
          var degradedTitle = isDegraded ? 'Workload could not be confirmed; these links are a best-effort guess' : undefined;

          // Gate on safeLinks (renderable), not the raw list: a vault-secrets
          // category whose links were all rejected by safeHref should show the
          // same "no secrets" chip as a genuinely empty one, not vanish.
          if (category.id === 'vault-secrets' && category.status === 'ok' && safeLinks.length === 0) {
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
            var singleHref = safeHref(safeLinks[0].url);
            return React.createElement('a', {
              key: categoryKey,
              href: singleHref,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: degradedTitle,
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
                opacity: isDegraded ? 0.75 : 1,
                transition: 'all 0.2s ease'
              }
            },
              category.icon ? React.createElement('span', { style: { marginRight: '4px' } }, category.icon) : null,
              categoryLabel
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
              React.createElement('summary', { title: degradedTitle, style: { cursor: 'pointer', listStyle: 'none', opacity: isDegraded ? 0.75 : 1 } },
                category.icon ? React.createElement('span', { style: { marginRight: '4px' } }, category.icon) : null,
                categoryLabel,
                React.createElement('span', { style: { marginLeft: '6px', fontSize: '9px' } }, '▼')
              ),
              React.createElement('div', { style: { marginTop: '6px', backgroundColor: palette.menuBg, border: palette.menuBorder, borderRadius: '4px', overflow: 'hidden', minWidth: '220px' } },
              safeLinks.map(function(link, linkIdx) {
                return React.createElement('a', {
                  key: (link.url || 'link') + '-' + linkIdx,
                  href: safeHref(link.url),
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  style: {
                    display: 'block',
                    padding: '8px 10px',
                    textDecoration: 'none',
                    color: palette.menuItemText,
                    fontSize: '11px',
                    borderBottom: linkIdx < safeLinks.length - 1 ? palette.menuDivider : 'none',
                    backgroundColor: 'transparent',
                    cursor: 'pointer'
                  }
                }, link.label || link.url);
              })
            ))
          );
    }).filter(function(node) { return node; });

    // Every category was filtered out (all non-ok/degraded status, or every URL
    // rejected by safeHref), so there is nothing to show. Return null; StatusPanel
    // treats a null result as "no renderable links" and hides the whole panel,
    // rather than rendering a dangling, empty "Context Links" header.
    if (rendered.length === 0) {
      return null;
    }

    return React.createElement('div', { style: { marginTop: '8px' } },
      React.createElement('div', { style: { marginBottom: '8px', fontWeight: 600, fontSize: '12px', color: palette.heading } }, 'Context Links'),
      React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, rendered)
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
