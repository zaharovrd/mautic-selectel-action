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
      // Step 1: Read the full template with all proxy settings
      Logger.log('Reading Nginx template...', '🔍');
      const templatePath = 'templates/nginx-virtual-host-template';
      let nginxConfig = await Deno.readTextFile(templatePath);

      // Step 2: Replace placeholders with actual values
      Logger.log('Substituting configuration values...', '📝');
      nginxConfig = nginxConfig
        .replace(/DOMAIN_NAME/g, this.config.domainName)
        .replace(/PORT/g, String(this.config.port));

      // Step 3: Write to temporary file first (atomic write with verification)
      const configPath = `/etc/nginx/sites-available/${this.config.domainName}`;
      const tempPath = `${configPath}.tmp`;

      Logger.log(`Writing configuration to temporary file: ${tempPath}`, '💾');
      await Deno.writeTextFile(tempPath, nginxConfig);

      // Step 4: Verify the temporary file was written completely
      Logger.log('Verifying temporary file integrity...', '✔️');
      const tempContent = await Deno.readTextFile(tempPath);
      const contentLines = tempContent.split('\n').length;
      const originalLines = nginxConfig.split('\n').length;

      if (contentLines !== originalLines) {
        throw new Error(
          `File write verification failed: expected ${originalLines} lines, got ${contentLines}`
        );
      }
      Logger.log(`✓ Temporary file verified (${contentLines} lines)`, '✔️');

      // Step 5: Atomic rename - move temp file to final location
      Logger.log(`Moving configuration to final location: ${configPath}`, '🔄');
      await Deno.rename(tempPath, configPath);

      // Step 6: Verify final file exists and has correct content
      Logger.log('Verifying final file...', '✔️');
      const finalContent = await Deno.readTextFile(configPath);
      if (!finalContent.includes('proxy_pass http://localhost:')) {
        throw new Error('Final configuration file does not contain required proxy_pass directive');
      }
      Logger.log('✓ Final configuration file verified', '✔️');

      // Step 7: Create symlink to enabled sites
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

      // Step 8: Wait a moment for filesystem to sync
      Logger.log('Waiting for filesystem sync...', '⏳');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 9: Test Nginx configuration
      Logger.log('Testing Nginx configuration...', '🧪');
      const testResult = await ProcessManager.runShell('nginx -t', { ignoreError: true });

      if (!testResult.success) {
        throw new Error(`Nginx configuration test failed: ${testResult.output}`);
      }
      Logger.log('✓ Nginx configuration test passed', '✔️');

      // Step 10: Reload Nginx service
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

        if (certCheckResult.success && certCheckResult.output.includes(this.config.domainName)) {
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

      if (!finalConfig.includes('listen 443 ssl')) {
        Logger.warning('Warning: SSL redirect configuration may not be complete');
      } else {
        Logger.success('✓ SSL configuration successfully applied by certbot');
      }

      // Check file integrity one more time
      const finalCheckResult = await ProcessManager.runShell(
        `wc -l ${configPath} && tail -c 50 ${configPath} | cat -A`,
        { ignoreError: true }
      );
      Logger.log(`Final verification: ${finalCheckResult.output}`, '📊');

      Logger.success('SSL certificate generated successfully');
      return true;

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`Certificate generation error: ${errorMessage}`);
      return false;
    }
  }
}