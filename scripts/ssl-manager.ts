/**
 * scripts/ssl-manager.ts
 * SSL certificate management with Nginx
 */

import type { DeploymentConfig } from './types.ts';
import { Logger } from './logger.ts';
import { ProcessManager } from './process-manager.ts';

export class SSLManager {
  private config: DeploymentConfig;

  constructor(config: DeploymentConfig) {
    this.config = config;
  }

  async setupSSL(): Promise<boolean> {
    if (!this.config.domainName) {
      Logger.info('No domain specified, skipping SSL setup');
      return true;
    }

    Logger.log(`Setting up SSL for domain: ${this.config.domainName}`, '🔒');

    try {
      // Setup Nginx
      await this.setupNginx();

      // Generate SSL certificate
      const certSuccess = await this.generateCertificate();

      if (!certSuccess) {
        Logger.warning('SSL certificate generation failed, but continuing...');
        return false;
      }

      // Update Mautic configuration with domain name and regenerate secret key
      await this.updateMauticConfig();

      Logger.success('SSL setup completed successfully');
      return true;

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`SSL setup failed: ${errorMessage}`);
      return false;
    }
  }

  private async setupNginx(): Promise<void> {
    Logger.log('Configuring Nginx...', '🌐');

    try {
      // Type guard: ensure domainName is defined
      if (!this.config.domainName) {
        throw new Error('Domain name is required for Nginx setup');
      }

      // Step 1: Check if nginx config was already uploaded by deploy script
      const uploadedConfigPath = `/var/www/nginx-virtual-host-${this.config.domainName}`;
      const configPath = `/etc/nginx/sites-available/${this.config.domainName}`;

      Logger.log('Checking for pre-uploaded nginx configuration...', '🔍');

      let nginxConfig: string;

      try {
        // Try to read the uploaded config file
        nginxConfig = await Deno.readTextFile(uploadedConfigPath);
        Logger.log('✓ Found pre-uploaded configuration file', '✔️');
        Logger.log(`Using uploaded config from: ${uploadedConfigPath}`, '📋');
      } catch {
        // If not found, generate it from template as fallback
        Logger.log('Pre-uploaded config not found, generating from template...', '⚠️');
        const templatePath = 'templates/nginx-virtual-host-template';
        nginxConfig = await Deno.readTextFile(templatePath);

        // Replace placeholders with actual values
        Logger.log('Substituting configuration values...', '📝');
        nginxConfig = nginxConfig
          .replace(/DOMAIN_NAME/g, this.config.domainName)
          .replace(/PORT/g, String(this.config.port));
      }

      // Step 2: Write to temporary file first (atomic write with verification)
      const tempPath = `${configPath}.tmp`;

      Logger.log(`Writing configuration to temporary file: ${tempPath}`, '💾');
      // Write with explicit UTF-8 encoding to ensure proper file handling
      await Deno.writeTextFile(tempPath, nginxConfig, { create: true });

      // Step 3: Verify the temporary file was written completely
      Logger.log('Verifying temporary file integrity...', '✔️');
      const tempContent = await Deno.readTextFile(tempPath);
      const contentLines = tempContent.split('\n').length;
      const originalLines = nginxConfig.split('\n').length;
      const tempSize = new TextEncoder().encode(tempContent).length;
      const expectedSize = new TextEncoder().encode(nginxConfig).length;

      Logger.log(`  - Expected lines: ${originalLines}, got: ${contentLines}`, '📊');
      Logger.log(`  - Expected size: ${expectedSize} bytes, got: ${tempSize} bytes`, '📊');

      if (contentLines !== originalLines || tempSize !== expectedSize) {
        throw new Error(
          `File write verification failed: lines (${originalLines} vs ${contentLines}), size (${expectedSize} vs ${tempSize})`
        );
      }
      Logger.log(`✓ Temporary file verified (${contentLines} lines, ${tempSize} bytes)`, '✔️');

      // Step 4: Atomic rename - move temp file to final location
      Logger.log(`Moving configuration to final location: ${configPath}`, '🔄');
      await Deno.rename(tempPath, configPath);

      // Step 5: Verify final file exists and has correct content
      Logger.log('Verifying final file...', '✔️');
      const finalContent = await Deno.readTextFile(configPath);
      const finalSize = new TextEncoder().encode(finalContent).length;
      const finalLines = finalContent.split('\n').length;

      Logger.log(`  - Final file size: ${finalSize} bytes (expected: ${expectedSize})`, '📊');
      Logger.log(`  - Final file lines: ${finalLines} (expected: ${originalLines})`, '📊');

      // Log file tail to verify completeness
      const fileTail = finalContent.split('\n').slice(-5).join('\n');
      Logger.log('  - File ends with:', '📄');
      Logger.log(fileTail, '📋');

      if (!finalContent.includes('proxy_pass http://localhost:')) {
        throw new Error('Final configuration file does not contain required proxy_pass directive');
      }

      if (!finalContent.trimEnd().endsWith('}')) {
        throw new Error('Final configuration file does not end with closing brace');
      }

      Logger.log('✓ Final configuration file verified', '✔️');

      // Step 6: Create symlink to enabled sites
      Logger.log('Creating symlink in sites-enabled...', '🔗');
      const enabledPath = `/etc/nginx/sites-enabled/${this.config.domainName}`;

      // Remove existing symlink if present
      try {
        await Deno.remove(enabledPath);
        Logger.log('Removed existing symlink', '🗑️');
      } catch {
        // Symlink doesn't exist yet, that's fine
      }

      // Create new symlink
      await ProcessManager.runShell(`ln -sf ${configPath} ${enabledPath}`);
      Logger.log('✓ Symlink created', '🔗');

      // Step 7: Wait a moment for filesystem to sync
      Logger.log('Waiting for filesystem sync...', '⏳');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 8: Test Nginx configuration
      Logger.log('Testing Nginx configuration...', '🧪');
      const testResult = await ProcessManager.runShell('nginx -t', { ignoreError: true });

      if (!testResult.success) {
        throw new Error(`Nginx configuration test failed: ${testResult.output}`);
      }
      Logger.log('✓ Nginx configuration test passed', '✔️');

      // Step 9: Reload Nginx service
      Logger.log('Reloading Nginx service...', '🔄');
      const reloadResult = await ProcessManager.runShell('systemctl reload nginx', { ignoreError: true });

      if (!reloadResult.success) {
        throw new Error(`Failed to reload Nginx: ${reloadResult.output}`);
      }
      Logger.log('✓ Nginx reloaded successfully', '✔️');

      // Step 11: Final verification - check file is complete
      Logger.log('Performing final configuration verification...', '📋');
      const finalVerify = await ProcessManager.runShell(
        `tail -c 100 ${configPath} | cat -A`,
        { ignoreError: true }
      );
      Logger.log(`Final file tail (should end with '}'): ${finalVerify.output}`, '📄');

      if (!finalContent.includes('}')) {
        throw new Error('Final configuration file appears to be incomplete (missing closing brace)');
      }

      Logger.success('Nginx configured successfully');

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Nginx configuration failed: ${errorMessage}`);
    }
  }

  private async generateCertificate(): Promise<boolean> {
    Logger.log('Generating SSL certificate...', '🔐');

    try {
      const configPath = `/etc/nginx/sites-available/${this.config.domainName}`;

      // Ensure config file is fully written and synced before certbot touches it
      Logger.log('Verifying Nginx configuration before certbot...', '🔍');
      const preCheckResult = await ProcessManager.runShell(
        `test -f ${configPath} && stat -c "Size: %s bytes" ${configPath}`,
        { ignoreError: true }
      );
      Logger.log(`Pre-certbot check: ${preCheckResult.output}`, '📊');

      // Wait to ensure all file operations are complete
      Logger.log('Waiting for filesystem operations to complete...', '⏳');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Run certbot with explicit nginx plugin and proper error handling
      Logger.log(`Running certbot for domain: ${this.config.domainName}`, '🔐');
      const certbotResult = await ProcessManager.runShell(
        `certbot --nginx -d ${this.config.domainName} --non-interactive --agree-tos --email ${this.config.emailAddress} --redirect --keep-until-expiring`,
        { ignoreError: true }
      );

      Logger.log('Certbot output:', '📋');
      Logger.log(certbotResult.output, '📄');

      if (!certbotResult.success) {
        // Check if certificate already exists (not necessarily an error)
        const certCheckResult = await ProcessManager.runShell(
          `certbot certificates -d ${this.config.domainName}`,
          { ignoreError: true }
        );

        if (certCheckResult.success && this.config.domainName && certCheckResult.output.includes(this.config.domainName)) {
          Logger.warning('Certificate already exists for domain, continuing...');
          return true;
        }

        Logger.error(`Certbot failed: ${certbotResult.output}`);
        return false;
      }

      // Wait for Nginx to reload after certbot
      Logger.log('Waiting for Nginx to reload...', '⏳');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify final configuration
      Logger.log('Verifying final Nginx configuration after certbot...', '🔍');
      const finalConfig = await Deno.readTextFile(configPath);
      const finalConfigSize = new TextEncoder().encode(finalConfig).length;
      const finalConfigLines = finalConfig.split('\n').length;

      Logger.log(`  - Final config size: ${finalConfigSize} bytes`, '📊');
      Logger.log(`  - Final config lines: ${finalConfigLines}`, '📊');

      // Log last 10 lines to see if file is complete
      const configTail = finalConfig.split('\n').slice(-10).join('\n');
      Logger.log('  - File ends with:', '📄');
      Logger.log(configTail, '📋');

      if (!finalConfig.includes('listen 443 ssl')) {
        Logger.warning('Warning: SSL redirect configuration may not be complete');
      } else {
        Logger.success('✓ SSL configuration successfully applied by certbot');
      }

      // Verify file completeness - must end with }
      if (!finalConfig.trimEnd().endsWith('}')) {
        Logger.error('ERROR: Configuration file appears to be truncated!');
        Logger.log(`File tail characters: ${finalConfig.slice(-100)}`, '⚠️');
        throw new Error('Configuration file truncated after certbot ran');
      }

      // Check file integrity one more time - using Deno API only (no shell)
      try {
        const fileStats = await Deno.stat(configPath);
        Logger.log(`Final file stats: ${fileStats.size} bytes`, '📊');

        // Re-read one final time to ensure it's complete
        const finalRecheck = await Deno.readTextFile(configPath);
        if (finalRecheck.length === 0) {
          throw new Error('Configuration file is empty after certbot!');
        }
        if (!finalRecheck.trimEnd().endsWith('}')) {
          throw new Error(`Configuration file is truncated (size: ${finalRecheck.length} bytes)`);
        }
        Logger.log('✓ File integrity confirmed', '✔️');
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        Logger.error(`File integrity check failed: ${errMsg}`);
        throw error;
      }

      Logger.success('SSL certificate generated successfully');
      return true;

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`Certificate generation error: ${errorMessage}`);
      return false;
    }
  }

  private async updateMauticConfig(): Promise<void> {
    Logger.log('Updating Mautic configuration with domain name...', '⚙️');

    try {
      const configPath = '/var/www/html/docroot/../config/local.php';

      // Generate a new secret key
      Logger.log('Generating new secret key...', '🔐');
      const secretKeyResult = await ProcessManager.runShell(
        `php -r "echo bin2hex(random_bytes(32));"`,
        { ignoreError: true }
      );

      if (!secretKeyResult.success) {
        Logger.warning('Could not generate secret key using PHP, using fallback method');
      }

      const secretKey = secretKeyResult.success
        ? secretKeyResult.output.trim()
        : `${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

      Logger.log(`Generated secret key: ${secretKey.substring(0, 16)}...`, '🔐');

      // Update site_url and secret_key in local.php
      const siteUrl = `https://${this.config.domainName}`;

      Logger.log(`Updating site_url to: ${siteUrl}`, '🌐');

      // Update site_url
      const updateSiteUrlCmd = `sed -i "s|'site_url' => '[^']*'|'site_url' => '${siteUrl}'|g" ${configPath}`;
      const updateSiteUrlResult = await ProcessManager.runShell(updateSiteUrlCmd, { ignoreError: true });

      if (!updateSiteUrlResult.success) {
        Logger.warning(`Failed to update site_url: ${updateSiteUrlResult.output}`);
      } else {
        Logger.success('✓ site_url updated successfully');
      }

      // Update secret_key
      const updateSecretKeyCmd = `sed -i "s/'secret_key' => '[^']*'/'secret_key' => '${secretKey}'/g" ${configPath}`;
      const updateSecretKeyResult = await ProcessManager.runShell(updateSecretKeyCmd, { ignoreError: true });

      if (!updateSecretKeyResult.success) {
        Logger.warning(`Failed to update secret_key: ${updateSecretKeyResult.output}`);
      } else {
        Logger.success('✓ secret_key updated successfully');
      }

      // Verify the changes
      Logger.log('Verifying configuration updates...', '🔍');
      const verifyResult = await ProcessManager.runShell(
        `grep -E "site_url|secret_key" ${configPath}`,
        { ignoreError: true }
      );

      if (verifyResult.success) {
        Logger.log('Updated configuration values:', '📄');
        Logger.log(verifyResult.output, '📋');
      }

      // Clear cache to apply new configuration
      Logger.log('Clearing cache to apply new configuration...', '🗑️');
      const cacheResult = await ProcessManager.runShell(
        `docker exec mautibox_web bash -c 'cd /var/www/html && rm -rf var/cache/prod/* 2>/dev/null || true'`,
        { ignoreError: true }
      );

      if (cacheResult.success) {
        Logger.success('✓ Cache cleared successfully');
      } else {
        Logger.warning('Cache clearing encountered an issue but continuing');
      }

      Logger.success('Mautic configuration updated successfully');

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.warning(`Error updating Mautic configuration: ${errorMessage}`);
      // Don't throw - this is a non-critical update
    }
  }
}
