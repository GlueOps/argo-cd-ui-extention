#!/bin/bash
set -euo pipefail

NAMESPACE=${NAMESPACE:-argocd}
_OTEL_BACKEND_URL_EXPLICIT=${OTEL_BACKEND_URL:+yes}
OTEL_BACKEND_URL=${OTEL_BACKEND_URL:-http://otel-extension-api.${NAMESPACE}.svc.cluster.local:8000}

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required"
  exit 1
fi

echo "Building extension bundle"
./build.sh

echo "Creating extension configmap"
kubectl -n "$NAMESPACE" create configmap otel-extension-tar \
  --from-file=extension.tar.gz=extension.tar.gz \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Enable Argo proxy extension"
kubectl -n "$NAMESPACE" patch configmap argocd-cmd-params-cm --type merge \
  -p '{"data":{"server.enable.proxy.extension":"true"}}'

if [ -z "$_OTEL_BACKEND_URL_EXPLICIT" ]; then
  echo "Checking otel-extension-api service exists"
  if ! kubectl -n "$NAMESPACE" get service otel-extension-api >/dev/null 2>&1; then
    echo "ERROR: Service 'otel-extension-api' not found in namespace '$NAMESPACE'."
    echo "Deploy the backend first (e.g. via Helm) or set OTEL_BACKEND_URL to an existing service."
    exit 1
  fi
fi

echo "Configure extension proxy backend"
kubectl -n "$NAMESPACE" patch configmap argocd-cm --type merge -p "{\"data\":{\"extension.config\":\"extensions:\\n- name: otel-extension\\n  backend:\\n    services:\\n    - url: ${OTEL_BACKEND_URL}\\n\"}}"

echo "Configure extension RBAC"
kubectl -n "$NAMESPACE" patch configmap argocd-rbac-cm --type merge \
  -p '{"data":{"policy.csv":"p, role:readonly, extensions, invoke, otel-extension, allow\np, role:admin, extensions, invoke, otel-extension, allow\ng, admin, role:admin"}}'

echo "Patch argocd-server deployment with extension installer"
kubectl -n "$NAMESPACE" patch deployment argocd-server --type json -p '[
  {"op":"add","path":"/spec/template/spec/initContainers/-","value":{"name":"otel-extension-installer","image":"quay.io/argoprojlabs/argocd-extension-installer:v0.0.5@sha256:27e72f047298188e2de1a73a1901013c274c4760c92f82e6e46cd5fbd0957c6b","env":[{"name":"EXTENSION_NAME","value":"otel-extension"},{"name":"EXTENSION_URL","value":"file:///extension/extension.tar.gz"},{"name":"EXTENSION_VERSION","value":"0.1.1"},{"name":"EXTENSION_ENABLED","value":"true"}],"volumeMounts":[{"name":"extensions","mountPath":"/tmp/extensions/"},{"name":"otel-extension-tar","mountPath":"/extension","readOnly":true}],"securityContext":{"runAsUser":1000,"allowPrivilegeEscalation":false}}},
  {"op":"add","path":"/spec/template/spec/volumes/-","value":{"name":"otel-extension-tar","configMap":{"name":"otel-extension-tar"}}},
  {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts/-","value":{"name":"extensions","mountPath":"/tmp/extensions/"}}
]'

echo "Restarting argocd-server"
kubectl -n "$NAMESPACE" rollout restart deployment argocd-server
kubectl -n "$NAMESPACE" rollout status deployment argocd-server --timeout=300s

echo "Verifying extension file"
POD=$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=argocd-server -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$NAMESPACE" exec "$POD" -- ls -lh /tmp/extensions/resources/otel-extension/extensions.js

echo "Deployment complete"
