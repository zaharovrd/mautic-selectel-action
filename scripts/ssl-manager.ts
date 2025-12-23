// scripts/ssl-manager.ts

import type { DeploymentConfig } from './types.ts';
import { Logger } from './logger.ts';
import { ProcessManager } from './process-manager.ts';

export class SSLManager {
  private config: DeploymentConfig;

  constructor(config: DeploymentConfig) {
    this.config = config;
  }

  public async configureNginxAndSSL(): Promise<void> {
    if (!this.config.domainName) {
      Logger.log('No domain provided, skipping Nginx & SSL configuration.', 'ℹ️');
      return;
    }

    Logger.log(`Starting Nginx & SSL setup for ${this.config.domainName}...`, '🔒');
    try {
      await this.prepareForCertbot();
      await this.obtainCertificate();
      await this.createFinalNginxConfig();
      await this.reloadNginx();

      Logger.success(`✅ Successfully configured Nginx and SSL for ${this.config.domainName}`);

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`❌ Nginx & SSL setup failed: ${errorMessage}`);
    }
  }

  private async prepareForCertbot(): Promise<void> {
    Logger.log('1. Preparing Nginx for Certbot validation...', '🔧');

    // --- ИЗМЕНЕНИЕ: Используем `alias` вместо `root` ---
    const preCertbotConfig = `
server {
    listen 80;
    listen [::]:80;
    server_name ${this.config.domainName};

    location /.well-known/acme-challenge/ {
        # 'alias' работает надежнее для этой задачи
        alias /var/www/certbot/.well-known/acme-challenge/;
        # Убираем все ограничения
        allow all;
    }

    location / {
       return 404;
    }
}`;

    const configPath = `/etc/nginx/sites-available/${this.config.domainName}`;
    await Deno.writeTextFile(configPath, preCertbotConfig);

    await ProcessManager.runShell('rm -f /etc/nginx/sites-enabled/default', { ignoreError: true });
    await ProcessManager.runShell(`ln -sf ${configPath} /etc/nginx/sites-enabled/`);

    await ProcessManager.runShell('nginx -t');
    await this.reloadNginx();
    Logger.success('   - Nginx is ready for validation.');
  }

  private async obtainCertificate(): Promise<void> {
    Logger.log('2. Obtaining SSL certificate with Certbot...', '🌿');

    const webrootPath = '/var/www/certbot';

    // --- ИЗМЕНЕНИЕ: Создаем нужную структуру и выставляем права ---
    await ProcessManager.runShell(`mkdir -p ${webrootPath}/.well-known/acme-challenge`);
    await ProcessManager.runShell(`chown -R www-data:www-data ${webrootPath}`);
    Logger.success(`   - Webroot directory ${webrootPath} prepared with correct permissions.`);

    const certbotCommand = [
      'certbot', 'certonly', '--webroot',
      '--webroot-path', webrootPath,
      '--email', this.config.emailAddress,
      '--domain', this.config.domainName,
      '--rsa-key-size', '4096',
      '--agree-tos',
      '--non-interactive',
    ].join(' ');

    const result = await ProcessManager.runShell(certbotCommand);

    // После выполнения команды certbot, проверим наличие ключевых файлов
    const checkFilesResult = await ProcessManager.runShell(
      `test -f /etc/letsencrypt/options-ssl-nginx.conf && test -f /etc/letsencrypt/ssl-dhparams.pem`,
      { ignoreError: true }
    );

    if (!result.success || !checkFilesResult.success) {
      Logger.error(`Certbot process output:\n${result.output}`);
      throw new Error(`Certbot failed to obtain certificate or create required SSL config files.`);
    }

    Logger.success('   - SSL certificate and required files are in place.');
  }

  private async createFinalNginxConfig(): Promise<void> {
    Logger.log('3. Creating final Nginx configuration with SSL...', '📄');
    const finalNginxConfig = `
server {
    listen 80;
    listen [::]:80;
    server_name ${this.config.domainName};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${this.config.domainName};

    ssl_certificate /etc/letsencrypt/live/${this.config.domainName}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${this.config.domainName}/privkey.pem;
    
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

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
    await Deno.writeTextFile(configPath, finalNginxConfig);

    await ProcessManager.runShell('nginx -t');
    Logger.success('   - Final Nginx config is valid.');
  }

  private async reloadNginx(): Promise<void> {
    Logger.log('4. Reloading Nginx to apply new configuration...', '🔄');
    await ProcessManager.runShell('systemctl reload nginx');
  }
}