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

    // --- ИСПРАВЛЕНИЕ ДЛЯ TS2375 ---

    // 1. Создаем базовый объект с обязательными полями.
    const deploymentConfig: DeploymentConfig = {
      vpsName: config['VPS_NAME'] ?? 'mautibox-vps',
      ipAddress: config['IP_ADDRESS'] ?? '',
      port: config['MAUTIC_PORT'] ?? '8001',
      emailAddress: config['EMAIL_ADDRESS'] ?? '',
      mauticPassword: config['MAUTIC_PASSWORD'] ?? '',
      mauticVersion: config['MAUTIC_VERSION'] ?? '6.0.7-apache',
      mauticLocale: config['MAUTIC_LOCALE'] ?? 'ru',
      defaultTimezone: config['DEFAULT_TIMEZONE'] ?? 'Europe/Moscow',
      mysqlDatabase: config['MYSQL_DATABASE'] ?? 'mautibox_db',
      mysqlUser: config['MYSQL_USER'] ?? 'mautibox_user',
      mysqlPassword: config['MYSQL_PASSWORD'] ?? '',
      mysqlRootPassword: config['MYSQL_ROOT_PASSWORD'] ?? '',
    };

    // 2. Условно добавляем опциональные свойства, только если они существуют.
    if (config['DOMAIN_NAME']) deploymentConfig.domainName = config['DOMAIN_NAME'];
    if (config['BASE_DOMAIN']) deploymentConfig.baseDomain = config['BASE_DOMAIN'];
    if (config['CLIENT_EMAIL']) deploymentConfig.clientEmail = config['CLIENT_EMAIL'];
    if (config['CLIENT_MAUTIC_PASSWORD']) deploymentConfig.clientMauticPassword = config['CLIENT_MAUTIC_PASSWORD'];
    if (config['MAUTIC_THEMES']) deploymentConfig.mauticThemes = config['MAUTIC_THEMES'];
    if (config['MAUTIC_PLUGINS']) deploymentConfig.mauticPlugins = config['MAUTIC_PLUGINS'];
    if (config['MAUTIC_LANGUAGE_PACK_URL']) deploymentConfig.mauticLanguagePackUrl = config['MAUTIC_LANGUAGE_PACK_URL'];
    if (config['GITHUB_TOKEN']) deploymentConfig.githubToken = config['GITHUB_TOKEN'];

    // 3. Возвращаем полностью сформированный и типизированный объект.
    return deploymentConfig;

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage.includes('No such file or directory')) {
      throw new Error("Configuration file .env not found. Please create it or run the configure.sh script.");
    }
    throw new Error(`Failed to load deployment configuration: ${errorMessage}`);
  }
}