/**
 * Configuration loading and validation
 * scripts/config.ts
 */

import type { DeploymentConfig } from './types.ts';
import { Logger } from './logger.ts'; // Добавим логгер для ясности

export async function loadDeploymentConfig(): Promise<DeploymentConfig> {
  try {
    // Читаем стандартный .env файл вместо deploy.env
    const envFilePath = '.env';
    Logger.log(`Loading configuration from ${envFilePath}...`, '📋');

    const envContent = await Deno.readTextFile(envFilePath);
    const config: Record<string, string> = {};

    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        // Ваша логика парсинга сохранена
        const [key, ...valueParts] = trimmed.split('=');
        if (key) {
          // Убираем возможные кавычки по краям значения
          let value = valueParts.join('=').trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.substring(1, value.length - 1);
          }
          config[key.trim()] = value;
        }
      }
    }

    // Проверяем обязательные поля
    const required = [
      'EMAIL_ADDRESS', 'MAUTIC_PASSWORD', 'MAUTIC_VERSION',
      'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD'
    ];

    for (const field of required) {
      if (!config[field]) {
        throw new Error(`Required variable ${field} is not set in ${envFilePath}`);
      }
    }

    // Возвращаем полный объект DeploymentConfig, включая новые поля
    return {
      vpsName: config.VPS_NAME || 'mautibox-vps',
      ipAddress: config.IP_ADDRESS || '',
      port: config.MAUTIC_PORT || '8001',
      domainName: config.DOMAIN_NAME,
      baseDomain: config.BASE_DOMAIN,
      emailAddress: config.EMAIL_ADDRESS,
      mauticPassword: config.MAUTIC_PASSWORD,
      clientEmail: config.CLIENT_EMAIL,
      clientMauticPassword: config.CLIENT_MAUTIC_PASSWORD,
      mauticVersion: config.MAUTIC_VERSION,
      mauticThemes: config.MAUTIC_THEMES,
      mauticPlugins: config.MAUTIC_PLUGINS,
      mauticLanguagePackUrl: config.MAUTIC_LANGUAGE_PACK_URL,
      mauticLocale: config.MAUTIC_LOCALE || 'ru',
      defaultTimezone: config.DEFAULT_TIMEZONE || 'Europe/Moscow',
      mysqlDatabase: config.MYSQL_DATABASE,
      mysqlUser: config.MYSQL_USER,
      mysqlPassword: config.MYSQL_PASSWORD,
      mysqlRootPassword: config.MYSQL_ROOT_PASSWORD,
      githubToken: config.GITHUB_TOKEN
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage.includes('No such file or directory')) {
      throw new Error("Configuration file .env not found. Please create it or run the configure.sh script.");
    }
    throw new Error(`Failed to load deployment configuration: ${errorMessage}`);
  }
}