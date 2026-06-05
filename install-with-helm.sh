#!/bin/bash
set -euo pipefail

NAMESPACE=${NAMESPACE:-argocd}
CLUSTER_PROFILE=${CLUSTER_PROFILE:-venus}
BASE_VALUES_FILE=${BASE_VALUES_FILE:-values/shared/otel-extension.yaml}
CLUSTER_VALUES_FILE=${CLUSTER_VALUES_FILE:-values/clusters/${CLUSTER_PROFILE}.yaml}
DRY_RUN=${DRY_RUN:-false}

if ! command -v helm >/dev/null 2>&1; then
  echo "helm is required"
  exit 1
fi
if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required"
  exit 1
fi

if [ ! -f "$BASE_VALUES_FILE" ]; then
  echo "Base values file not found: $BASE_VALUES_FILE"
  exit 1
fi

if [ ! -f "$CLUSTER_VALUES_FILE" ]; then
  echo "Cluster values file not found: $CLUSTER_VALUES_FILE"
  exit 1
fi

echo "Installing/Upgrading Argo CD for profile: $CLUSTER_PROFILE"
echo "Using values files:"
echo "  - $BASE_VALUES_FILE"
echo "  - $CLUSTER_VALUES_FILE"

helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1 || true
helm repo update

if [ "$DRY_RUN" = "true" ]; then
  helm template argocd argo/argo-cd \
    -f "$BASE_VALUES_FILE" \
    -f "$CLUSTER_VALUES_FILE" \
    -n "$NAMESPACE" >/dev/null
  echo "Dry run complete"
  exit 0
fi

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install argocd argo/argo-cd \
  -f "$BASE_VALUES_FILE" \
  -f "$CLUSTER_VALUES_FILE" \
  -n "$NAMESPACE" \
  --wait \
  --timeout 10m

echo "Argo CD installed for profile: $CLUSTER_PROFILE"
echo "For local build-based extension deployment, run: ./deploy.sh"
