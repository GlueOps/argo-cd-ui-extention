#!/bin/bash
set -euo pipefail

NAMESPACE=${NAMESPACE:-argocd}
# Default to the generic profile so the expected URL here MATCHES the declarative
# default in the shared values (helm-values.yaml / values/shared/otel-extension.yaml),
# both of which put the backend in $NAMESPACE (argocd). The venus cluster runs the
# backend in glueops-core, so verify it with CLUSTER_PROFILE=venus -- mirroring
# values/clusters/venus.yaml. Override EXPECTED_OTEL_BACKEND_URL directly otherwise.
CLUSTER_PROFILE=${CLUSTER_PROFILE:-default}

# The backend Service can live in a DIFFERENT namespace than the argocd
# control-plane: the venus profile runs it in glueops-core, not argocd.
case "$CLUSTER_PROFILE" in
  venus) DEFAULT_BACKEND_NAMESPACE="glueops-core" ;;
  *)     DEFAULT_BACKEND_NAMESPACE="$NAMESPACE" ;;
esac
EXPECTED_OTEL_BACKEND_URL=${EXPECTED_OTEL_BACKEND_URL:-http://argocd-extension-backend-api.${DEFAULT_BACKEND_NAMESPACE}.svc.cluster.local:8000}
KUBE_CONTEXT=${KUBE_CONTEXT:-}

# Parse the backend Service name + namespace out of the expected in-cluster URL
# (http(s)://<svc>.<ns>.svc.cluster.local[:port][/path]) so the Service existence
# check (#7) targets the namespace the backend actually runs in -- not the
# control-plane $NAMESPACE. ONLY the standard cluster-DNS form is treated as an
# in-cluster Service. An external host (e.g. https://grafana.example.com) has no
# Service to look up, so BACKEND_IS_CLUSTER_SERVICE stays "no" and check #7 is
# skipped rather than failing against an unrelated default Service.
BACKEND_IS_CLUSTER_SERVICE=no
BACKEND_SERVICE=""
BACKEND_NAMESPACE=""
backend_authority=${EXPECTED_OTEL_BACKEND_URL#*://}   # strip scheme
backend_authority=${backend_authority%%/*}            # strip any /path
backend_authority=${backend_authority%%:*}            # strip :port
case "$backend_authority" in
  *.svc.cluster.local)
    backend_host=${backend_authority%.svc.cluster.local}
    # A resolvable Service needs BOTH a service and a namespace label, i.e. the
    # host has to contain a dot ("<svc>.<ns>"). The degenerate "foo.svc.cluster.local"
    # (no namespace label -> no dot in backend_host) is not a Service. Note: a
    # legitimate same-name Service like "grafana.grafana" DOES have a dot and is
    # handled correctly here -- do NOT reject svc==ns.
    case "$backend_host" in
      *.*)
        svc=${backend_host%%.*}
        ns=${backend_host#*.}
        ns=${ns%%.*}
        if [ -n "$svc" ] && [ -n "$ns" ]; then
          BACKEND_IS_CLUSTER_SERVICE=yes
          BACKEND_SERVICE="$svc"
          BACKEND_NAMESPACE="$ns"
        fi
        ;;
    esac
    ;;
esac

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
if [ "$BACKEND_IS_CLUSTER_SERVICE" = "yes" ]; then
  echo "Backend service: $BACKEND_SERVICE (namespace $BACKEND_NAMESPACE)"
else
  echo "Backend service: external/non-cluster URL ($EXPECTED_OTEL_BACKEND_URL) -- Service check skipped"
fi

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

# 5) extension.config contains expected backend URL
if echo "$ext_cfg" | grep -Fq "$EXPECTED_OTEL_BACKEND_URL"; then
  pass "argocd-cm extension.config contains expected otel backend URL"
else
  fail "argocd-cm extension.config does not contain expected otel backend URL"
  info "Expected: $EXPECTED_OTEL_BACKEND_URL"
fi

# 6) RBAC includes invoke permissions for otel-extension
rbac_cfg=$(kubectl -n "$NAMESPACE" get configmap argocd-rbac-cm -o jsonpath='{.data.policy\.csv}' 2>/dev/null || true)
if echo "$rbac_cfg" | grep -q "extensions, invoke, otel-extension, allow"; then
  pass "argocd-rbac-cm allows extensions invoke for otel-extension"
else
  fail "argocd-rbac-cm missing invoke permissions for otel-extension"
fi

# 7) backend service exists (in the namespace parsed from the expected URL, which
#    may differ from the argocd control-plane namespace -- e.g. glueops-core on venus).
#    Skipped for an external/non-cluster EXPECTED_OTEL_BACKEND_URL: there is no
#    in-cluster Service to look up, so a lookup would only ever be a false failure.
if [ "$BACKEND_IS_CLUSTER_SERVICE" != "yes" ]; then
  info "backend URL is external/non-cluster ($EXPECTED_OTEL_BACKEND_URL); skipping in-cluster Service check"
elif kubectl -n "$BACKEND_NAMESPACE" get service "$BACKEND_SERVICE" >/dev/null 2>&1; then
  pass "$BACKEND_SERVICE service exists in namespace $BACKEND_NAMESPACE"
else
  fail "$BACKEND_SERVICE service not found in namespace $BACKEND_NAMESPACE"
fi

echo
if [ "$fail_count" -eq 0 ]; then
  echo "Verification summary: all $pass_count checks passed"
  exit 0
fi

echo "Verification summary: $pass_count passed, $fail_count failed"
exit 1
