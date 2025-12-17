#!/bin/bash
# install.sh
# MautiBox On-Premises Installer

set -e

echo "🚀 Welcome to MautiBox On-Premises Installer!"

# --- Шаг 1: Проверка зависимостей ---
echo "🔍 Checking for required tools (Docker, Docker Compose, Git)..."
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker before running this script."
    echo "Follow the official guide: https://docs.docker.com/engine/install/"
    exit 1
fi
if ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose is not installed or not available as 'docker compose'."
    echo "Follow the official guide: https://docs.docker.com/compose/install/"
    exit 1
fi
if ! command -v git &> /dev/null; then
    echo "❌ Git is not installed. Please install it with 'sudo apt-get update && sudo apt-get install -y git'"
    exit 1
fi
echo "✅ All required tools are present."

# --- Шаг 2: Проверка конфигурации ---
if [ ! -f .env ]; then
    echo "⚠️ .env file not found."
    if [ -f templates/env.template ]; then
        echo "📄 Creating .env from template. Please edit it with your details."
        cp templates/env.template .env
        nano .env # Открываем nano для редактирования. Можно использовать vi или любой другой.
    else
        echo "❌ templates/env.template not found. Cannot proceed."
        exit 1
    fi
fi

echo "🔐 Please review your configuration in .env. Press [Enter] to continue or [Ctrl+C] to abort."
read -p ""

# --- Шаг 3: Запуск конфигуратора ---
echo "🔧 Running configuration script..."
# Переходим в директорию со скриптами, если нужно
chmod +x ./scripts/configure.sh
./scripts/configure.sh

# --- Шаг 4: Запуск Docker Compose ---
echo "🐳 Starting MautiBox containers... This may take a few minutes."
# Запускаем docker compose с переменными из .env
docker compose --env-file .env up -d

echo "✅ Docker containers have been started."

# --- Шаг 5: Ожидание запуска и выполнение установки Mautic ---
echo "⏳ Waiting for Mautic to be ready before running the installation..."
sleep 60 # Даем контейнерам время на инициализацию

echo "⚙️ Running final Mautic setup (mautic:install, plugins, etc.)..."
# Мы не можем использовать скомпилированный Deno-скрипт здесь, так как он собран для GH Actions.
# Вместо этого, можно сделать упрощенную версию установки.
# Но для универсальности лучше скачать и запустить Deno.
if ! command -v deno &> /dev/null; then
    echo "📦 Deno not found. Installing..."
    curl -fsSL https://deno.land/install.sh | sh
    export PATH="$HOME/.deno/bin:$PATH"
    echo 'export PATH="$HOME/.deno/bin:$PATH"' >> ~/.bashrc
fi

# Запускаем Deno-скрипт напрямую
deno run --allow-all ./scripts/setup.ts

echo "🎉 MautiBox installation is complete!"
source .env
if [ -n "$DOMAIN_NAME" ]; then
    echo "🌐 Your Mautic instance should be available at: https://${DOMAIN_NAME}"
else
    # Получаем IP-адрес для вывода
    IP_ADDRESS=$(hostname -I | awk '{print $1}')
    echo "🌐 Your Mautic instance should be available at: http://${IP_ADDRESS}:${MAUTIC_PORT}"
fi
echo "📧 Admin user: ${EMAIL_ADDRESS}"
echo "Enjoy using MautiBox!"