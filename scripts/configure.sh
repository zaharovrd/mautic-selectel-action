#!/bin/bash
# scripts/configure.sh
set -e

echo "🔧 Running configuration..."
if [ ! -f .env ]; then 
    echo "❌ .env not found!"; exit 1; 
fi

# Вместо 'export $(...)' используем 'set -a' и 'source',
# что корректно обрабатывает кавычки и пробелы.
set -a
source .env
set +a

# Проверяем, что envsubst установлен. Это важно для alpine/минимальных образов.
if ! command -v envsubst &> /dev/null; then
    echo "envsubst command could not be found. Trying to install gettext..."
    # Попытка установить пакет, содержащий envsubst
    if command -v apt-get &> /dev/null; then
        apt-get update -y && apt-get install -y gettext-base
    elif command -v apk &> /dev/null; then
        apk add gettext
    else
        echo "❌ Cannot install gettext package. Please install it manually."
        exit 1
    fi
fi

#echo "📄 Generating .mautic_env from template..."
#envsubst < .mautic_env.template > .mautic_env

#chmod 600 .mautic_env
#echo "✅ .mautic_env created."