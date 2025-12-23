/**
 * scripts/ssl-manager.ts
 * SSL certificate management with Nginx and Certbot
 */

import type { DeploymentConfig } from './types.ts';
import { Logger } from './logger.ts';
import { ProcessManager } from './process-manager.ts';

export class SSLManager {
  private config: DeploymentConfig;

  constructor(config: DeploymentConfig) {
    this.config = config;
  }

  // Мы изменим эту функцию, чтобы она вызывалась из setup.ts
  public async configureNginxAndSSL(): Promise<void> {
    // Если домен не указан, мы ничего не делаем. Nginx останется с конфигом по умолчанию.
    if (!this.config.domainName) {
      Logger.log('No domain provided, skipping Nginx & SSL configuration.', 'ℹ️');
      return;
    }

    // Если домен указан, мы настраиваем Nginx и получаем SSL.
    Logger.log(`Starting Nginx & SSL setup for ${this.config.domainName}...`, '🔒');
    try {
      // 1. Создаем правильный конфиг Nginx сразу для HTTP и HTTPS.
      await this.createNginxVHost();

      // 2. Включаем конфиг и проверяем его синтаксис.
      await this.enableSite();

      // 3. Получаем или обновляем SSL-сертификат.
      await this.obtainCertificate();

      // 4. Перезапускаем Nginx, чтобы применить SSL-сертификат.
      await this.reloadNginx();

      Logger.success(`✅ Successfully configured Nginx and SSL for ${this.config.domainName}`);

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`❌ Nginx & SSL setup failed: ${errorMessage}`);
      Logger.warning('Mautic will be available via IP address and port, but not via domain name.');
      // Не прерываем деплой, так как это может быть некритично.
    }
  }

  private async createNginxVHost(): Promise<void> {
    Logger.log('Creating Nginx virtual host configuration...', '📄');

    // Этот конфиг более надежен:
    // 1. Явно указывает Certbot, где искать файлы для проверки.
    // 2. Сразу настраивает и HTTP (с редиректом на HTTPS), и HTTPS.
    // 3. Содержит правильные заголовки для проксирования.
    const nginxConfig = `
server {
    listen 80;
    server_name ${this.config.domainName};

    # Нужно для верификации домена Certbot'ом
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # Все остальные запросы на 80 порт перенаправляем на HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name ${this.config.domainName};

    # Пути к сертификатам (Certbot создаст их здесь)
    ssl_certificate /etc/letsencrypt/live/${this.config.domainName}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${this.config.domainName}/privkey.pem;
    
    # Рекомендованные настройки безопасности
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Проксирование трафика в контейнер Mautic
    location / {
        proxy_pass http://127.0.0.1:${this.config.port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
    }
}`;

    const configPath = `/etc/nginx/sites-available/${this.config.domainName}`;
    await Deno.writeTextFile(configPath, nginxConfig);
    Logger.success(`   - Nginx config created at ${configPath}`);
  }

  private async enableSite(): Promise<void> {
    const sourcePath = `/etc/nginx/sites-available/${this.config.domainName}`;
    const destPath = `/etc/nginx/sites-enabled/${this.config.domainName}`;

    // Удаляем старый конфиг по умолчанию, чтобы он не мешал
    await ProcessManager.runShell('rm -f /etc/nginx/sites-enabled/default', { ignoreError: true });

    // Создаем символическую ссылку для включения нашего сайта
    await ProcessManager.runShell(`ln -sf ${sourcePath} ${destPath}`);

    // Проверяем синтаксис Nginx
    Logger.log('Validating Nginx configuration...', '🔍');
    await ProcessManager.runShell('nginx -t');
    Logger.success('   - Nginx configuration is valid.');
  }

  private async obtainCertificate(): Promise<void> {
    Logger.log('Obtaining SSL certificate with Certbot (webroot method)...', '🌿');

    // Создаем директорию для webroot-проверки
    await ProcessManager.runShell('mkdir -p /var/www/certbot', { ignoreError: true });

    // Перезагружаем Nginx, чтобы он подхватил новый VHost для 80 порта
    await ProcessManager.runShell('systemctl reload nginx', { ignoreError: true });

    // Команда для получения сертификата
    const certbotCommand = [
      'certbot', 'certonly', '--webroot',
      '--webroot-path', '/var/www/certbot',
      '--email', this.config.emailAddress,
      '--domain', this.config.domainName,
      '--rsa-key-size', '4096',
      '--agree-tos',
      '--non-interactive',
      '--force-renewal'
    ].join(' ');

    const result = await ProcessManager.runShell(certbotCommand);
    if (!result.success) {
      throw new Error(`Certbot failed: ${result.output}`);
    }
    Logger.success('   - SSL certificate obtained/renewed successfully.');
  }

  private async reloadNginx(): Promise<void> {
    Logger.log('Reloading Nginx to apply SSL certificate...', '🔄');
    await ProcessManager.runShell('systemctl reload nginx');
  }
}