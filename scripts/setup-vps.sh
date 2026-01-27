# scripts/setup-vps.sh
#!/bin/bash
# ==============================================================================
#      VPS PREPARATION SCRIPT
# ==============================================================================

set -e
export DEBIAN_FRONTEND=noninteractive

echo "🔄 Updating system packages..."
apt-get update

echo "📦 Installing prerequisites for Docker repository..."
apt-get install -y ca-certificates curl gnupg

echo "🔑 Adding Docker’s official GPG key..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --batch --yes -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "🏦 Setting up the Docker repository..."
echo \
  "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

echo "🔄 Updating package lists again after adding Docker repo..."
apt-get update

echo "📦 Installing all required packages (Docker, Nginx, Firewall, etc.)..."
apt-get install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin \
  nginx \
  certbot \
  python3-certbot-nginx \
  ufw \
  fail2ban \
  curl wget unzip git nano htop cron netcat vim

echo "💾 Creating swap file for memory-intensive operations..."
if ! grep -q "/swapfile" /etc/fstab; then
    echo "Creating 2GB swap file..."
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sysctl vm.swappiness=10
    echo 'vm.swappiness=10' >> /etc/sysctl.conf
    echo "✅ Swap file created and configured"
    free -h
else
    echo "✅ Swap file already exists."
fi

echo "🔥 Configuring firewall..."
ufw --force enable
ufw allow ssh
ufw allow 80
ufw allow 443
echo "✅ Firewall configured (SSH, HTTP, HTTPS allowed)"

echo "🚀 Starting and enabling core services..."
systemctl start nginx
systemctl enable nginx
systemctl start docker
systemctl enable docker
systemctl enable ssh
systemctl start ssh

# Ensure nginx directories exist
mkdir -p /etc/nginx/sites-available
mkdir -p /etc/nginx/sites-enabled
rm -f /etc/nginx/sites-enabled/default

# Configure SSH to allow root login. Use reload instead of restart for safety.
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
systemctl reload sshd

echo "📁 Creating deployment directories..."
mkdir -p /var/www
mkdir -p /var/log
chown -R root:root /var/www

# --- DANGEROUS COMMAND REMOVED ---
# The line 'chmod 755 /dev' was here. It is harmful and has been removed.

echo "🧹 Cleaning up..."
apt-get autoremove -y
apt-get autoclean -y

echo "✅ VPS setup completed successfully"
echo "🔍 Docker service status: $(systemctl is-active docker)"
echo "🔍 Nginx service status: $(systemctl is-active nginx)"
echo "🔍 UFW firewall status: $(ufw status | head -1)"

echo "🛡️ Configuring Fail2Ban..."

# Create custom jail configuration
mkdir -p /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.d/mautibox-protection.local << EOF
# Этот файл содержит наши локальные переопределения и новые правила

# Правило для защиты от сканеров WordPress/CMS
[wordpress-scan]
enabled  = true
port     = http,https
filter   = wordpress-scan
logpath  = /var/log/nginx/access.log
maxretry = 2
findtime = 600
bantime  = 86400

# Правило для защиты SSH
[sshd]
enabled  = true
port     = ssh
maxretry = 3
findtime = 600
bantime  = 86400

# Простое правило для защиты от DoS-атак на веб-сервер
[nginx-dos]
enabled  = true
port     = http,https
filter   = nginx-dos
logpath  = /var/log/nginx/access.log
maxretry = 100
findtime = 60
bantime  = 600

[nginx-botsearch]
enabled  = true
logpath  = /var/log/nginx/access.log
maxretry = 1
bantime  = 86400
EOF

# Create custom filter for nginx-dos
cat > /etc/fail2ban/filter.d/nginx-dos.conf << EOF
[Definition]
failregex = ^<HOST> -.*- .*HTTP/.*" .* .*$
ignoreregex =
EOF

# Create custom filter for wordpress-scan
cat > /etc/fail2ban/filter.d/wordpress-scan.conf << EOF
[Definition]
# Ищем попытки доступа к файлам/папкам WordPress и другим популярным векторам
failregex = ^<HOST> .* "(GET|POST) .*(/wp-login.php|/wp-admin|/wp-includes|/xmlrpc.php|wlwmanifest.xml|\.env).*"
ignoreregex =
EOF

# Create custom filter for wordpress-scan
cat > /etc/fail2ban/filter.d/botsearch-common.local << EOF
[Init]
block = \/?(<webmail>|<phpmyadmin>|<wordpress>|<scanners>|cgi-bin|mysqladmin)[^,]*
scanners = SDK/webLanguage|\.env|\.git|\.aws/credentials|phpinfo\.php|config\.inc\.php|readme\.html|license\.txt|adminer\.php
EOF

echo "🚀 Starting and enabling Fail2Ban..."
systemctl enable fail2ban
systemctl start fail2ban

echo "✅ Fail2Ban configured and started."
echo "🔍 Fail2Ban service status: $(systemctl is-active fail2ban)"
