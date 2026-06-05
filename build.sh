#!/bin/bash
set -e

cd extensions/otel
npm install
npm run build
cd ../..

rm -rf resources
mkdir -p resources/otel-extension
cp extensions/otel/dist/extensions.js resources/otel-extension/extensions.js
tar -czf extension.tar.gz resources/
rm -rf resources

echo "Built extension.tar.gz"
tar -tzf extension.tar.gz
