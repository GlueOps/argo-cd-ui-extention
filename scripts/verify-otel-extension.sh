#!/bin/bash
set -euo pipefail

NAMESPACE=${NAMESPACE:-argocd}
CLUSTER_PROFILE=${CLUSTER_PROFILE:-earth}
EXPECTED_GRAFANA_URL=${EXPECTED_GRAFANA_URL:-https://grafana.nonprod.earth.onglueops.rocks}
EXPECTED_VAULT_URL=${EXPECTED_VAULT_URL:-https://vault.nonprod.earth.onglueops.rocks}
KUBE_CONTEXT=${KUBE_CONTEXT:-}

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required"
  exit 1
fi

if [ -n "$KUBE_CONTEXT" ]; then
  kubectl config use-context "$KUBE_CONTEXT" >/dev/null
fi

current_context=$(kubectl config current-context)
echo "Context: $current_context"
echo "Namespace: $NAMESPACE"
echo "Profile: $CLUSTER_PROFILE"

pass_count=0
fail_count=0

pass() {
  pass_count=$((pass_count + 1))
  echo "PASS: $1"
}

fail() {
  fail_count=$((fail_count + 1))
  echo "FAIL: $1"
}

info() {
  echo "INFO: $1"
}

# 1) argocd-server pod exists
pod_name=$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=argocd-server -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [ -n "$pod_name" ]; then
  pass "argocd-server pod found: $pod_name"
else
  fail "argocd-server pod not found"
fi

# 2) extension file exists in pod
if [ -n "$pod_name" ] && kubectl -n "$NAMESPACE" exec "$pod_name" -- test -f /tmp/extensions/resources/otel-extension/extensions.js >/dev/null 2>&1; then
  pass "otel extension file present in argocd-server pod"
else
  fail "otel extension file missing in argocd-server pod"
fi

# 3) proxy extension enabled
proxy_enabled=$(kubectl -n "$NAMESPACE" get configmap argocd-cmd-params-cm -o jsonpath='{.data.server\.enable\.proxy\.extension}' 2>/dev/null || true)
if [ "$proxy_enabled" = "true" ]; then
  pass "proxy extension enabled in argocd-cmd-params-cm"
else
  fail "proxy extension not enabled (current: ${proxy_enabled:-unset})"
fi

# 4) extension.config contains otel-extension
ext_cfg=$(kubectl -n "$NAMESPACE" get configmap argocd-cm -o jsonpath='{.data.extension\.config}' 2>/dev/null || true)
if echo "$ext_cfg" | grep -q "name: otel-extension"; then
  pass "argocd-cm extension.config contains otel-extension"
else
  fail "argocd-cm extension.config missing otel-extension"
fi

# 5) extension.config contains expected grafana URL
if echo "$ext_cfg" | grep -q "$EXPECTED_GRAFANA_URL"; then
  pass "argocd-cm extension.config contains expected grafana URL"
else
  fail "argocd-cm extension.config does not contain expected grafana URL"
  info "Expected: $EXPECTED_GRAFANA_URL"
fi

# 6) RBAC includes invoke permissions for otel-extension
rbac_cfg=$(kubectl -n "$NAMESPACE" get configmap argocd-rbac-cm -o jsonpath='{.data.policy\.csv}' 2>/dev/null || true)
if echo "$rbac_cfg" | grep -q "extensions, invoke, otel-extension, allow"; then
  pass "argocd-rbac-cm allows extensions invoke for otel-extension"
else
  fail "argocd-rbac-cm missing invoke permissions for otel-extension"
fi

# 7) external endpoint reachability checks from runner
if command -v curl >/dev/null 2>&1; then
  if curl -fsSL "$EXPECTED_GRAFANA_URL/api/health" >/dev/null 2>&1; then
    pass "grafana endpoint is reachable from runner"
  else
    fail "grafana endpoint is not reachable from runner"
  fi

  if curl -fsSL "$EXPECTED_VAULT_URL/v1/sys/health" >/dev/null 2>&1; then
    pass "vault endpoint is reachable from runner"
  else
    fail "vault endpoint is not reachable from runner"
  fi
else
  info "curl not found, skipped external reachability checks"
fi

echo
if [ "$fail_count" -eq 0 ]; then
  echo "Verification summary: all $pass_count checks passed"
  exit 0
fi

echo "Verification summary: $pass_count passed, $fail_count failed"
exit 1
