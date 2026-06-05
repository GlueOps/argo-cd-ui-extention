(function() {
  'use strict';

  function initExtension() {
    if (typeof window.extensionsAPI === 'undefined') {
      setTimeout(initExtension, 500);
      return;
    }

    const extensionsAPI = window.extensionsAPI;

    function OtelPanel(props) {
      const application = props && (props.application || props.item || props);
      const appName =
        (application && application.metadata && application.metadata.name) ||
        application?.name ||
        '';

      return React.createElement(
        'div',
        { style: { padding: '8px', fontSize: '12px' } },
        appName
          ? 'OTEL: initializing for ' + appName
          : 'OTEL: application not found'
      );
    }

    if (typeof extensionsAPI.registerStatusPanelExtension === 'function') {
      extensionsAPI.registerStatusPanelExtension(OtelPanel, 'OTEL', 'otel');
    }
    if (typeof extensionsAPI.registerAppViewExtension === 'function') {
      extensionsAPI.registerAppViewExtension(OtelPanel, 'Observability', 'fa-heartbeat');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initExtension);
  } else {
    initExtension();
  }
})();
