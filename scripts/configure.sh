#!/bin/bash
# scripts/configure.sh
set -e
echo "🔧 Running configuration..."
if [ ! -f .env ]; then echo "❌ .env not found!"; exit 1; fi
export $(grep -v '^#' .env | xargs)
envsubst < .mautic_env.template > .mautic_env
chmod 600 .mautic_env
echo "✅ .mautic_env created."