/**
 * scripts/types.ts
 * Type definitions for Mautic deployment system
 */

export interface PackageConfig {
  url: string;
  directory?: string;
  token?: string;
}

export interface DeploymentConfig {
  // --- VPS & Domain ---
  vpsName: string;                    // Unique name for the VPS, used for branding/identification.
  ipAddress: string;
  domainName?: string;
  baseDomain?: string;                // Base domain for automated DNS management (e.g., "mautibox.ru").

  // --- Mautic Core Admin ---
  emailAddress: string;               // Admin user email.
  mauticPassword: string;             // Admin user password.

  // --- Mautic Client User ---
  clientEmail?: string;               // Email for the non-admin client user.
  clientMauticPassword?: string;      // Password for the non-admin client user.

  // --- Mautic Configuration ---
  mauticVersion: string;
  port: string;
  mauticLocale: string;               // Changed from optional to required for consistency.
  defaultTimezone: string;

  // --- Customization ---
  mauticThemes?: string;
  mauticPlugins?: string;
  mauticLanguagePackUrl?: string;
  githubToken?: string;               // For private themes/plugins from GitHub.

  // --- Database ---
  mysqlDatabase: string;
  mysqlUser: string;
  mysqlPassword: string;
  mysqlRootPassword: string;
}

export interface ContainerInfo {
  name: string;
  image: string;
  status: string;
  health?: string | undefined;
}

export interface ProcessResult {
  success: boolean;
  output: string;
  exitCode: number;
}

export interface ProcessOptions {
  cwd?: string;
  timeout?: number;
  ignoreError?: boolean;
}