#!/bin/bash
# scripts/deploy_selectel.sh
# ==============================================================================
#      MAUTIC DEPLOYMENT SCRIPT FOR SELECTEL (VSCALE.IO API)
# 
# Этот скрипт выполняет следующие действия:
# 1. Работает с API Selectel для создания/поиска SSH-ключа.
# 2. Создает сервер (scalet), если он не существует.
# 3. Ожидает запуска сервера и получает его IP-адрес.
# 4. Выполняет первичную настройку сервера (аналог user-data).
# 5. Компилирует Deno-скрипт и копирует все необходимые файлы на сервер.
# 6. Запускает на сервере скрипт установки Mautic с Docker Compose.
# 7. Мониторит процесс установки и выводит результат.
# ==============================================================================

set -e

echo "🚀 Starting deployment to Selectel..."
echo "Debug URL from env var: $INPUT_LANGUAGE_PACK_URL"
echo "Mautic version to deploy/update: ${INPUT_MAUTIC_VERSION}"
SELECTEL_API_URL="https://api.vscale.io/v1"
SELECTEL_TOKEN="${INPUT_SELECTEL_TOKEN}"

if [ -n "$CURL_CACERT_PATH" ]; then
    echo " M   Using custom CA certificate at: ${CURL_CACERT_PATH}"
    CURL_OPTIONS="--cacert ${CURL_CACERT_PATH}"
else
    CURL_OPTIONS=""
fi

if [ -z "${SELECTEL_TOKEN}" ]; then echo "❌ FATAL ERROR: Selectel API token is not set."; exit 1; fi

TEMP_SSH_KEY_PATH=~/.ssh/mautic_deploy_temp_key
cleanup() { echo "🧹 Cleaning up temporary SSH key..."; rm -f "${TEMP_SSH_KEY_PATH}" "${TEMP_SSH_KEY_PATH}.pub"; }
trap cleanup EXIT

MAUTIC_PORT=${INPUT_MAUTIC_PORT:-8001}
echo "📝 Configuration..."

echo "🔐 Setting up SSH authentication..."
mkdir -p ~/.ssh
echo "${INPUT_SSH_PRIVATE_KEY}" > "${TEMP_SSH_KEY_PATH}"
chmod 600 "${TEMP_SSH_KEY_PATH}"

echo "🔑 Generating public key..."
if ! ssh-keygen -y -f "${TEMP_SSH_KEY_PATH}" > "${TEMP_SSH_KEY_PATH}.pub" 2>/dev/null; then echo "❌ Error: Failed to generate public key"; exit 1; fi
SSH_PUBLIC_KEY_CONTENT=$(cat "${TEMP_SSH_KEY_PATH}.pub")
KEY_NAME="mautic-deploy-key-$(date +%s)"

echo "🔍 Finding or creating SSH key in Selectel account..."
ALL_KEYS_JSON=$(curl -s $CURL_OPTIONS -X GET "${SELECTEL_API_URL}/sshkeys" -H "X-Token: ${SELECTEL_TOKEN}")

if [ -z "${ALL_KEYS_JSON}" ]; then echo "❌ FATAL ERROR: Received an empty response from Selectel API."; exit 1; fi

if echo "${ALL_KEYS_JSON}" | jq -e 'type == "object" and has("error_message")' > /dev/null; then echo "❌ FATAL API ERROR: $(echo "${ALL_KEYS_JSON}" | jq -r '.error_message')"; exit 1; fi

SSH_KEY_ID=$(echo "${ALL_KEYS_JSON}" | jq -r --arg key "${SSH_PUBLIC_KEY_CONTENT}" '.[] | select(.key == $key) | .id')

if [ -z "$SSH_KEY_ID" ] || [ "$SSH_KEY_ID" == "null" ]; then
    echo "🔑 Key not found. Adding new key..."
    ADD_KEY_PAYLOAD=$(jq -n --arg name "$KEY_NAME" --arg key "$SSH_PUBLIC_KEY_CONTENT" '{name: $name, key: $key}')
    NEW_KEY_JSON=$(curl -s $CURL_OPTIONS -X POST "${SELECTEL_API_URL}/sshkeys" -H "Content-Type: application/json" -H "X-Token: ${SELECTEL_TOKEN}" -d "${ADD_KEY_PAYLOAD}")
    SSH_KEY_ID=$(echo "${NEW_KEY_JSON}" | jq -r '.id')
    if [ -z "$SSH_KEY_ID" ] || [ "$SSH_KEY_ID" == "null" ]; then echo "❌ Error: Failed to add SSH key. Response: ${NEW_KEY_JSON}"; exit 1; fi
    echo "✅ New SSH key added (ID: ${SSH_KEY_ID})"
else
    echo "✅ Found existing SSH key in Selectel (ID: ${SSH_KEY_ID})"
fi

echo "🖥️  Checking if VPS '${INPUT_VPS_NAME}' exists..."
ALL_SERVERS_JSON=$(curl -s $CURL_OPTIONS -X GET "${SELECTEL_API_URL}/scalets" -H "X-Token: ${SELECTEL_TOKEN}")
SERVER_EXISTS_CTID=$(echo "${ALL_SERVERS_JSON}" | jq -r --arg name "${INPUT_VPS_NAME}" '.[] | select(.name == $name) | .ctid')

IS_UPDATE="false"
if [ -z "$SERVER_EXISTS_CTID" ] || [ "$SERVER_EXISTS_CTID" == "null" ]; then
    echo "📦 Creating new VPS '${INPUT_VPS_NAME}'..."
    
    IMAGE_ID="ubuntu_22.04_64_001_master" 
    echo "🔧 Using image ID: ${IMAGE_ID}"
    
    CREATE_SERVER_PAYLOAD=$(jq -n --arg make_from "$IMAGE_ID" --arg rplan "${INPUT_VPS_RPLAN}" --arg name "${INPUT_VPS_NAME}" --argjson keys "[$SSH_KEY_ID]" --arg location "${INPUT_VPS_LOCATION}" '{make_from: $make_from, rplan: $rplan, do_start: true, name: $name, keys: $keys, location: $location}')
    CREATED_SERVER_JSON=$(curl -s $CURL_OPTIONS -X POST "${SELECTEL_API_URL}/scalets" -H "Content-Type: application/json" -H "X-Token: ${SELECTEL_TOKEN}" -d "${CREATE_SERVER_PAYLOAD}")
    SERVER_CTID=$(echo "${CREATED_SERVER_JSON}" | jq -r '.ctid')
    if [ -z "$SERVER_CTID" ] || [ "$SERVER_CTID" == "null" ]; then echo "❌ Error: Failed to create VPS. Response: ${CREATED_SERVER_JSON}"; exit 1; fi
    echo "✅ VPS creation initiated (CTID: ${SERVER_CTID})."
else
    echo "✅ VPS '${INPUT_VPS_NAME}' already exists (CTID: ${SERVER_EXISTS_CTID}). Treating as an update."
    SERVER_CTID=$SERVER_EXISTS_CTID
    IS_UPDATE="true"
fi

echo "🔍 Getting VPS IP address..."
VPS_IP=""
TIMEOUT=300; COUNTER=0
while [ -z "$VPS_IP" ]; do
    if [ $COUNTER -ge $TIMEOUT ]; then echo "❌ Timeout waiting for IP."; exit 1; fi
    SERVER_DETAILS_JSON=$(curl -s $CURL_OPTIONS -X GET "${SELECTEL_API_URL}/scalets/${SERVER_CTID}" -H "X-Token: ${SELECTEL_TOKEN}")
    SERVER_STATUS=$(echo "${SERVER_DETAILS_JSON}" | jq -r '.status')
    if [ "$SERVER_STATUS" = "started" ]; then
        VPS_IP=$(echo "${SERVER_DETAILS_JSON}" | jq -r '.public_address.address')
        if [ -n "$VPS_IP" ] && [ "$VPS_IP" != "null" ]; then echo "✅ VPS is active. IP: $VPS_IP"; break; fi
    fi
    echo "⏳ Waiting for VPS to be ready (Status: ${SERVER_STATUS})..."
    sleep 10
    COUNTER=$((COUNTER + 10))
done

# --- ШАГ 1: УПРАВЛЕНИЕ DNS И ПРОВЕРКА ---
if [ -n "$INPUT_DOMAIN" ] && [ -n "$INPUT_BASE_DOMAIN" ]; then
    echo "🌐 Managing DNS for domain ${INPUT_DOMAIN} via base domain ${INPUT_BASE_DOMAIN}..."
    
    echo "🔍 Finding Domain ID for base domain '${INPUT_BASE_DOMAIN}'..."
    DOMAINS_JSON=$(curl -s $CURL_OPTIONS -X GET "${SELECTEL_API_URL}/domains/" -H "X-Token: ${SELECTEL_TOKEN}")
    DOMAIN_ID=$(echo "${DOMAINS_JSON}" | jq -r --arg name "${INPUT_BASE_DOMAIN}" '.[] | select(.name == $name) | .id')

    if [ -z "$DOMAIN_ID" ] || [ "$DOMAIN_ID" == "null" ]; then
        echo "❌ CRITICAL: Base domain '${INPUT_BASE_DOMAIN}' not found in your Selectel account or is not delegated to Selectel DNS."
        exit 1
    fi
    echo "✅ Found Domain ID: ${DOMAIN_ID}"

    echo "🔍 Checking for existing A-record for '${INPUT_DOMAIN}'..."
    RECORDS_JSON=$(curl -s $CURL_OPTIONS -X GET "${SELECTEL_API_URL}/domains/${DOMAIN_ID}/records/" -H "X-Token: ${SELECTEL_TOKEN}")
    EXISTING_RECORD=$(echo "${RECORDS_JSON}" | jq -c --arg name "${INPUT_DOMAIN}" '.[] | select(.type == "A" and .name == $name)')

    if [ -n "$EXISTING_RECORD" ] && [ "$EXISTING_RECORD" != "null" ]; then
        EXISTING_IP=$(echo "$EXISTING_RECORD" | jq -r '.content')
        RECORD_ID=$(echo "$EXISTING_RECORD" | jq -r '.id')
        echo "✅ Found existing A-record (ID: ${RECORD_ID}) pointing to ${EXISTING_IP}"
        
        if [ "$EXISTING_IP" != "$VPS_IP" ]; then
            echo "🔄 IP address has changed. Updating record..."
            UPDATE_PAYLOAD=$(jq -n --arg name "$INPUT_DOMAIN" --arg type "A" --arg content "$VPS_IP" --argjson ttl 300 '{name: $name, type: $type, content: $content, ttl: $ttl}')
            curl -s $CURL_OPTIONS -X PUT "${SELECTEL_API_URL}/domains/${DOMAIN_ID}/records/${RECORD_ID}" -H "X-Token: ${SELECTEL_TOKEN}" -H "Content-Type: application/json" -d "${UPDATE_PAYLOAD}" > /dev/null
            echo "✅ A-record updated to point to ${VPS_IP}"
        else
            echo "👍 IP address is already correct."
        fi
    else
        echo "📦 No existing A-record found. Creating new one..."
        CREATE_PAYLOAD=$(jq -n --arg name "$INPUT_DOMAIN" --arg type "A" --arg content "$VPS_IP" --argjson ttl 300 '{name: $name, type: $type, content: $content, ttl: $ttl}')
        curl -s $CURL_OPTIONS -X POST "${SELECTEL_API_URL}/domains/${DOMAIN_ID}/records/" -H "X-Token: ${SELECTEL_TOKEN}" -H "Content-Type: application/json" -d "${CREATE_PAYLOAD}" > /dev/null
        echo "✅ New A-record created for '${INPUT_DOMAIN}' pointing to ${VPS_IP}"
    fi
    
    echo "🌐 Waiting for DNS propagation for ${INPUT_DOMAIN}..."
    TIMEOUT=300; COUNTER=0
    while true; do
        if [ $COUNTER -ge $TIMEOUT ]; then echo "❌ Timeout waiting for DNS propagation."; exit 1; fi
        VERIFY_IP=$(dig +short "$INPUT_DOMAIN" @8.8.8.8)
        if [ "$VERIFY_IP" == "$VPS_IP" ]; then
            echo "✅ DNS record is live and points correctly to ${VPS_IP}!"
            break
        fi
        echo "⏳ Waiting for DNS... (current IP: ${VERIFY_IP:-'not found'})"
        sleep 15
        COUNTER=$((COUNTER + 15))
    done
# Если домен передан, но без базового домена (ручная настройка)
elif [ -n "$INPUT_DOMAIN" ]; then
    echo "🌐 Verifying domain (manual DNS setup)..."
    DOMAIN_IP=$(dig +short "$INPUT_DOMAIN")
    if [ "$DOMAIN_IP" != "$VPS_IP" ]; then 
        echo "❌ Domain $INPUT_DOMAIN does not point to $VPS_IP. Please update your DNS records manually and re-run."
        exit 1
    fi
    echo "✅ Domain correctly points to VPS"
fi

# --- ШАГ 2: ПОДГОТОВКА NGINX (ЕСЛИ ЕСТЬ ДОМЕН) ---
if [ -n "$INPUT_DOMAIN" ]; then
    echo "🔧 Preparing nginx configuration for ${INPUT_DOMAIN}..."
    cp "${ACTION_PATH}/templates/nginx-virtual-host-template" "nginx-virtual-host-${INPUT_DOMAIN}"
    sed -i "s/DOMAIN_NAME/${INPUT_DOMAIN}/g" "nginx-virtual-host-${INPUT_DOMAIN}"
    sed -i "s/PORT/${MAUTIC_PORT}/g" "nginx-virtual-host-${INPUT_DOMAIN}"
    echo "✅ Nginx config prepared."
fi

if [ "$IS_UPDATE" == "false" ]; then
echo "🔧 Running initial server setup for a new server..."
echo "🔐 Waiting for SSH key-based authentication to be ready..."
SSH_TIMEOUT=300; SSH_COUNTER=0
while ! ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i "${TEMP_SSH_KEY_PATH}" root@${VPS_IP} "echo 'SSH connection successful'" 2>/dev/null; do
    if [ $SSH_COUNTER -ge $SSH_TIMEOUT ]; then
        echo "❌ SSH connection timeout. Server is not accepting the key."
        exit 1
    fi
    echo "⏳ Waiting for SSH key auth... (${SSH_COUNTER}s)"
    sleep 10
    SSH_COUNTER=$((SSH_COUNTER + 10))
done
echo "✅ SSH key authentication is available"

ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i "${TEMP_SSH_KEY_PATH}" root@${VPS_IP} 'bash -s' < "${ACTION_PATH}/scripts/setup-vps.sh"
echo "✅ Initial server setup complete."
else
    echo "🔄 Skipping initial server setup for existing VPS."
fi


echo "📋 Creating deployment config..."
cat > .env <<EOF
VPS_NAME=${INPUT_VPS_NAME}
IP_ADDRESS=${VPS_IP}
DOMAIN_NAME=${INPUT_DOMAIN:-}
BASE_DOMAIN=${INPUT_BASE_DOMAIN:-}
MAUTIC_VERSION=${INPUT_MAUTIC_VERSION}
MAUTIC_PORT=${MAUTIC_PORT:-8001}
EMAIL_ADDRESS=${INPUT_EMAIL}
MAUTIC_PASSWORD=${INPUT_MAUTIC_ADMIN_PASSWORD}
CLIENT_EMAIL=${INPUT_CLIENT_EMAIL:-}
CLIENT_MAUTIC_PASSWORD=${INPUT_CLIENT_MAUTIC_PASSWORD:-}
MYSQL_DATABASE=${INPUT_MYSQL_DATABASE}
MYSQL_USER=${INPUT_MYSQL_USER}
MYSQL_PASSWORD=${INPUT_MYSQL_PASSWORD}
MYSQL_ROOT_PASSWORD=${INPUT_MYSQL_ROOT_PASSWORD}
MAUTIC_THEMES=${INPUT_THEMES:-}
MAUTIC_PLUGINS=${INPUT_PLUGINS:-}
MAUTIC_LANGUAGE_PACK_URL=${INPUT_LANGUAGE_PACK_URL:-}
GITHUB_TOKEN=${INPUT_GITHUB_TOKEN:-}
MAUTIC_LOCALE=${INPUT_LOCALE:-"ru"}
DEFAULT_TIMEZONE=${INPUT_DEFAULT_TIMEZONE:-"Europe/Moscow"}
MAUTIC_TRUSTED_PROXIES=["127.0.0.1"]
MAUTIC_REVERSE_PROXY=true
EOF

chmod 600 .env
cp "${ACTION_PATH}/templates/docker-compose.yml" .
cp "${ACTION_PATH}/templates/.mautic_env.template" .
echo "🔨 Compiling Deno script to binary..."
if ! command -v deno &> /dev/null; then echo "📦 Installing Deno..."; curl -fsSL https://deno.land/install.sh | sh; export PATH="$HOME/.deno/bin:$PATH"; fi
mkdir -p build
deno compile --allow-all --target x86_64-unknown-linux-gnu --output ./build/setup "${ACTION_PATH}/scripts/setup.ts"
if [ ! -f "./build/setup" ]; then echo "❌ Failed to compile Deno script"; exit 1; fi
echo "✅ Compiled successfully"

# --- Шаг: Загрузка и применение кастомного перевода ---
echo "🌐 Cloning custom language pack..."
# Создаем временный SSH ключ для GitHub (если репозиторий приватный)
if [ -n "${MAUTIBOX_GITHUB_TOKEN:-}" ]; then
    echo "🔑 Using GitHub token for authentication..."
    # Добавляем ключ в агента SSH для HTTPS клонирования с токеном
    # Или клонируем по SSH, если настроен deploy key
    GIT_CLONE_URL="https://${MAUTIBOX_GITHUB_TOKEN}@github.com/zaharovrd/language-packs.git"
else
    echo "⚠️ No GitHub token provided, trying public access..."
    GIT_CLONE_URL="https://github.com/zaharovrd/language-packs.git"
fi

# Клонируем репозиторий с переводами
TEMP_LANG_DIR=$(mktemp -d)
if ! git clone --depth 1 "$GIT_CLONE_URL" "$TEMP_LANG_DIR" 2>/dev/null; then
    echo "⚠️ Could not clone language pack, proceeding without custom translations"
    rm -rf "$TEMP_LANG_DIR"
else
    echo "✅ Language pack cloned successfully"
    
    # Проверяем структуру архива
    if [ -f "$TEMP_LANG_DIR/mautibox_ru.zip" ]; then
        echo "📦 Found processed translation archive"
        # Копируем архив на сервер вместе с другими файлами
        cp "$TEMP_LANG_DIR/mautibox_ru.zip" ./
        # Добавляем в список файлов для копирования на сервер
        FILES_TO_COPY="$FILES_TO_COPY mautibox_ru.zip"
        
        # Также добавляем команду для распаковки в setup.ts
        cat > apply-translation.sh << 'EOF'
#!/bin/bash
echo "🌐 Applying custom Russian translation..."
if [ -f /var/www/mautibox_ru.zip ]; then
    echo "📦 Unpacking translation archive..."
    unzip -q /var/www/mautibox_ru.zip -d /tmp/mautic_translation/
    
    # Копируем файлы перевода в Mautic
    if [ -d "/tmp/mautic_translation/" ]; then
        echo "📄 Copying translation files to Mautic..."
        # Находим и копируем все файлы перевода
        find /tmp/mautic_translation/ -name "*.ini" -o -name "*.properties" | while read -r file; do
            # Определяем относительный путь
            rel_path="${file#/tmp/mautic_translation/}"
            # Создаем целевую директорию
            target_dir="/var/www/html/translations/$(dirname "$rel_path")"
            mkdir -p "$target_dir"
            cp "$file" "$target_dir/"
        done
        
        echo "✅ Custom translation applied successfully"
        
        # Устанавливаем русский язык по умолчанию в конфигурации Mautic
        if [ -f "/var/www/html/config/local.php" ]; then
            echo "🔧 Setting Russian as default language..."
            sed -i "s/'locale' => '[^']*'/'locale' => 'ru_RU'/" /var/www/html/config/local.php 2>/dev/null || \
            echo "Could not update locale in config"
        fi
    fi
    rm -rf /tmp/mautic_translation/
else
    echo "⚠️ No translation archive found"
fi
EOF
        chmod +x apply-translation.sh
        scp -o StrictHostKeyChecking=no -i "${TEMP_SSH_KEY_PATH}" apply-translation.sh root@${VPS_IP}:/var/www/
    else
        echo "⚠️ No mautibox_ru.zip found in repository"
    fi
    
    # Очищаем временную директорию
    rm -rf "$TEMP_LANG_DIR"
fi

echo "🚀 Deploying to server..."
ssh -o StrictHostKeyChecking=no -i "${TEMP_SSH_KEY_PATH}" root@${VPS_IP} "mkdir -p /var/www"

scp -o StrictHostKeyChecking=no -i "${TEMP_SSH_KEY_PATH}" \
    .env \
    "${ACTION_PATH}/templates/docker-compose.yml" \
    "${ACTION_PATH}/templates/.mautic_env.template" \
    "${ACTION_PATH}/scripts/configure.sh" \
    build/setup \
    root@${VPS_IP}:/var/www/

# После копирования даем права на исполнение обоим скриптам
ssh -o StrictHostKeyChecking=no -i "${TEMP_SSH_KEY_PATH}" root@${VPS_IP} "cd /var/www && chmod +x setup configure.sh"

echo "⚙️  Running setup on server..."
ssh -f -o StrictHostKeyChecking=no \
   -o ExitOnForwardFailure=yes \
   -i "${TEMP_SSH_KEY_PATH}" \
   root@${VPS_IP} \
   "cd /var/www && nohup ./setup > /var/log/setup-dc.log 2>&1"

echo "⏳ Waiting a moment for the remote process to initialize..."
sleep 10

echo "📊 Monitoring setup progress..."
SSH_COMMAND_TO_MONITOR="
TIMEOUT=500
COUNTER=0
SUCCESS_MSG='🎉 Mautic setup completed successfully'
LOG_FILE='/var/log/setup-dc.log'

while [ \$COUNTER -lt \$TIMEOUT ]; do
    if [ -f \"\$LOG_FILE\" ] && grep -q \"\$SUCCESS_MSG\" \"\$LOG_FILE\"; then
        echo '✅ Setup completed successfully!'
        exit 0
    fi
    
    if ! pgrep -f './setup' > /dev/null; then
        if [ -f \"\$LOG_FILE\" ] && grep -q \"\$SUCCESS_MSG\" \"\$LOG_FILE\"; then
            echo '✅ Setup process finished and was successful!'
            exit 0
        else
            echo '❌ Setup process ended unexpectedly without success message.'
            exit 1
        fi
    fi
    
    echo '⏳ Setup running... (waiting 30s)'
    sleep 30
    COUNTER=\$((COUNTER + 30))
done

echo '❌ Deployment timed out after \$TIMEOUT seconds.'
exit 1
"

if ! ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=60 -i "${TEMP_SSH_KEY_PATH}" root@${VPS_IP} "${SSH_COMMAND_TO_MONITOR}"; then
    echo "❌ Deployment script on server failed or timed out."
    echo "📥 Downloading final part of setup log for analysis..."
    scp -o StrictHostKeyChecking=no -i "${TEMP_SSH_KEY_PATH}" root@${VPS_IP}:/var/log/setup-dc.log ./setup-dc.log > /dev/null 2>&1 || echo "Could not retrieve log file."
    echo "--- LOG START ---"
    tail -n 100 ./setup-dc.log
    echo "--- LOG END ---"
    exit 1
fi

echo "📥 Downloading full setup log..."
scp -o StrictHostKeyChecking=no -i "${TEMP_SSH_KEY_PATH}" root@${VPS_IP}:/var/log/setup-dc.log ./setup-dc.log > /dev/null 2>&1 || echo "Could not retrieve log file."

if [ -n "$INPUT_DOMAIN" ]; then MAUTIC_URL="https://${INPUT_DOMAIN}"; else MAUTIC_URL="http://${VPS_IP}:${MAUTIC_PORT}"; fi
echo "vps-ip=${VPS_IP}" >> $GITHUB_OUTPUT
echo "mautic-url=${MAUTIC_URL}" >> $GITHUB_OUTPUT
echo "deployment-log=./setup-dc.log" >> $GITHUB_OUTPUT
echo "✅ Outputs set successfully"
echo "🎉 Deployment completed successfully!"
echo "🌐 Your Mautic instance is available at: ${MAUTIC_URL}"
