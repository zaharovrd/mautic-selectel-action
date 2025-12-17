/**
 * Configuration loading and validation
 * scripts/config.ts
 */

import type { DeploymentConfig } from './types.ts';
import { Logger } from './logger.ts';

export async function loadDeploymentConfig(): Promise<DeploymentConfig> {
  try {
    const envFilePath = '.env';
    Logger.log(`Loading configuration from ${envFilePath}...`, '📋');

    const envContent = await Deno.readTextFile(envFilePath);
    const config: Record<string, string> = {};

    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key) {
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

    // Возвращаем полный объект DeploymentConfig, исправляя ошибки
    return {
      // ИСПРАВЛЕНИЕ TS4111: Используем доступ через квадратные скобки ['...']
      // ИСПРАВЛЕНИЕ TS2322: Используем оператор '??' для предоставления значения по умолчанию,
      // если свойство отсутствует, чтобы тип всегда был 'string', а не 'string | undefined'.

      vpsName: config['VPS_NAME'] ?? 'mautibox-vps',
      ipAddress: config['IP_ADDRESS'] ?? '',
      port: config['MAUTIC_PORT'] ?? '8001',
      domainName: config['DOMAIN_NAME'], // Это поле опционально в DeploymentConfig, '??' не нужно
      baseDomain: config['BASE_DOMAIN'], // Это поле тоже опционально

      emailAddress: config['EMAIL_ADDRESS'] ?? '',
      mauticPassword: config['MAUTIC_PASSWORD'] ?? '',

      clientEmail: config['CLIENT_EMAIL'], // Опциональное поле
      clientMauticPassword: config['CLIENT_MAUTIC_PASSWORD'], // Опциональное поле

      mauticVersion: config['MAUTIC_VERSION'] ?? '6.0.7-apache',

      mauticThemes: config['MAUTIC_THEMES'], // Опциональное поле
      mauticPlugins: config['MAUTIC_PLUGINS'], // Опциональное поле
      mauticLanguagePackUrl: config['MAUTIC_LANGUAGE_PACK_URL'], // Опциональное поле

      mauticLocale: config['MAUTIC_LOCALE'] ?? 'ru',
      defaultTimezone: config['DEFAULT_TIMEZONE'] ?? 'Europe/Moscow',

      mysqlDatabase: config['MYSQL_DATABASE'] ?? 'mautibox_db',
      mysqlUser: config['MYSQL_USER'] ?? 'mautibox_user',
      mysqlPassword: config['MYSQL_PASSWORD'] ?? '',
      mysqlRootPassword: config['MYSQL_ROOT_PASSWORD'] ?? '',

      githubToken: config['GITHUB_TOKEN'] // Опциональное поле
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage.includes('No such file or directory')) {
      throw new Error("Configuration file .env not found. Please create it or run the configure.sh script.");
    }
    throw new Error(`Failed to load deployment configuration: ${errorMessage}`);
  }
}