#!/bin/bash
set -euo pipefail

NAMESPACE=${NAMESPACE:-argocd}

if ! command -v helm >/dev/null 2>&1; then
  echo "helm is required"
  exit 1
fi
if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required"
  exit 1
fi

echo "Installing/Upgrading Argo CD with helm-values.yaml"
helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1 || true
helm repo update
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
helm upgrade --install argocd argo/argo-cd -f helm-values.yaml -n "$NAMESPACE" --wait --timeout 10m

echo "Argo CD installed. For local build-based extension deployment, run: ./deploy.sh"
