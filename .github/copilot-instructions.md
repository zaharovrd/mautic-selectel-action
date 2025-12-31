# Mautic Deploy Action - Copilot Instructions

## Project Overview
GitHub Action for deploying MautiBox (Mautic 6 fork) to Selectel VPS with automated SSL, Docker Compose orchestration, and Russian language support.

## Architecture Overview

### Deployment Flow
1. **GitHub Action Entry** → `action.yml` validates inputs and environment variables
2. **Selectel VPS Provisioning** → `scripts/deploy_selectel.sh` creates/updates server via Selectel API
3. **VPS Setup** → `scripts/setup-vps.sh` configures Ubuntu system (Docker, dependencies)
4. **Deno Orchestration** → `scripts/setup.ts` executes modular deployment pipeline
5. **Application Installation** → `scripts/mautic-deployer.ts` handles Mautic setup, themes, plugins, language packs

### Deployment Technologies
- **Orchestration**: Deno + TypeScript (compiles to `build/setup` binary)
- **Containerization**: Docker Compose with three core services: `mautibox_web`, `mautibox_db`, `mautibox_cron`
- **Database**: MySQL 8.0 with separate root/user credentials
- **SSL/HTTPS**: Let's Encrypt certificates via Certbot + Nginx reverse proxy (when domain provided)
- **Platform**: Selectel VPS via vscale.io API (not DigitalOcean)

## Key Components & Patterns

### TypeScript/Deno Modules (`scripts/*.ts`)
**Class-based architecture with single responsibility**:
- `Logger` - File + console logging with emoji indicators to `/var/log/setup-dc.log`
- `ProcessManager` - Deno process execution with shell command support; `run()` for direct commands, `runShell()` for bash
- `DockerManager` - Docker inspection and container lifecycle; checks health status, manages `mautibox_web/db/cron/worker`
- `PackageManager` - APT lock handling with timeout/force-release; critical for race conditions on fresh VPS
- `MauticDeployer` - Complex deployment: checks installation state (4-point verification), installs themes/plugins/language packs via Composer or direct GitHub/ZIP downloads, cache warmup
- `SSLManager` - Certbot integration with Nginx reverse proxy; handles pre-validation setup, certificate acquisition, final configuration
- `config.ts` - Reads `.env` file into `DeploymentConfig` interface; validates required fields; optional fields use conditional assignment pattern

**Key Pattern**: Async/await error handling with `ignoreError: true` option for graceful failures; Logger emojis provide visual debugging.

### Configuration System
**Single source of truth: `.env` file**
- Generated from `templates/env.template` during setup
- Loaded by `config.ts` into typed `DeploymentConfig` object
- Passed to Docker via `.mautic_env` and shell environment variables
- Sensitive fields masked in logs (passwords, GitHub token)
- **Optional fields use conditional assignment**: `if (config['KEY']) deploymentConfig.key = config['KEY'];`

### Docker Compose Architecture (`templates/docker-compose.yml`)
- **Anchor pattern** for volume sharing: `&mautibox-volumes` reused across web/cron/worker services
- **Health checks** on db (mysqladmin ping) and web (curl) with start_period, interval, timeout, retries
- **Dependencies** enforce startup order: `web` waits for healthy `db`, `cron` waits for healthy `web`
- **Named volumes**: `mautic_config`, `mautic_plugins`, `mautic_themes`, `mautic_media`, `mautic_translations`, `mysql_data`, `logs`
- **Environment injection**: `.mautic_env` file provides DB credentials and Mautic config

### Package/Extension Management
**Flexible multi-format support** in `mautic-deployer.ts`:
1. **Packagist packages**: `vendor/package:^1.0` → installed via Composer
2. **GitHub public repos**: `https://github.com/user/repo/archive/main.zip` → direct download and extraction
3. **GitHub private repos**: Same URL + `?token=ghp_xxx` query param for auth
4. **Custom directory mapping**: `?directory=CustomDir` extracts to specific plugin/theme directory
5. **Multiline format**: Each package on separate line in `themes` or `plugins` input

## Development Workflows

### Building the Deno Binary
```bash
cd /path/to/mautic-do-action
deno compile --allow-all --output build/setup scripts/setup.ts
```
Compiled binary deployed to VPS as entry point for orchestration.

### Local Testing
1. Create `.env` from `templates/env.template` with test credentials
2. Run `./scripts/configure.sh` to generate Docker files
3. Execute `docker compose up -d` to test containers locally
4. Check logs: `docker compose logs -f mautibox_web`

### Adding New Inputs
1. Add input definition to `action.yml` with description and required flag
2. Pass as environment variable in `action.yml` step: `INPUT_NEW_PARAM: ${{ inputs.new-param }}`
3. Update `scripts/types.ts` `DeploymentConfig` interface if needed
4. Handle in `scripts/config.ts` with conditional assignment for optional fields
5. Use in module (e.g., `this.config.newParam`)
6. Document in README.md workflow example

### Managing Shell Script Execution
- Main entry: `scripts/deploy_selectel.sh` orchestrates Selectel API calls and VPS communication
- VPS setup: `scripts/setup-vps.sh` runs on remote server (called via SSH with `ssh -i key` pattern)
- Deno scripts run locally first (`setup.ts` compiles), then binary runs on VPS
- **Error handling**: `set -e` in bash scripts, `try/catch` in TypeScript with Logger.error() calls

## Critical Patterns & Gotchas

### API Integration (Selectel vscale.io)
- `deploy_selectel.sh` uses `curl` with `X-Token` header for Selectel API
- SSH key lookup happens first: finds or creates key in Selectel account
- Server creation: checks if VPS with name exists (updates) or creates new
- **Gotcha**: Timeout for VPS startup is 300s; IP polling every 15s

### Configuration Masking
Secrets never logged:
```typescript
const configToLog = { ...config };
configToLog.mauticPassword = '*** MASKED ***';
configToLog.githubToken = configToLog.githubToken ? '*** MASKED ***' : 'Not provided';
```

### APT Lock Handling
`PackageManager.waitForLocks()` handles VPS initialization race:
1. Checks lock files in `/var/lib/dpkg/lock-*`
2. Detects running apt/dpkg processes
3. Waits up to 600s (10 min) for automatic unlock
4. **Force release** if timeout: kills processes, removes locks, runs `dpkg --configure -a`

### Installation State Detection
`MauticDeployer.isInstalled()` requires 3 of 4 checks to pass:
- Docker compose file exists
- Data directories exist (`mautic_data`, `mysql_data`)
- Database container running and healthy
- Config files present (`.mautic_env`)

### Deno Permission Requirements
All scripts use `--allow-all` flag because they need:
- File system (read/write logs, configs)
- Environment variables
- Process execution (docker, curl, etc.)
- Network (curl for downloads)

## Code Quality & Conventions

### Language Mix Rationale
- **Bash** (`*.sh`): VPS provisioning, API interactions (lightweight, immediate)
- **TypeScript/Deno** (`*.ts`): Complex orchestration, modular logic, type safety, compilation to binary
- **YAML** (`action.yml`): GitHub Action spec, workflow examples
- **Dockerfile/Compose**: Container definitions

### Error Messages Use Emojis
- `❌` errors, `✅` success, `⏳` waiting, `🔒` locks, `🚀` startup, `📋` config, `🔧` setup
- Facilitates visual log scanning in GitHub Actions UI

### Naming Conventions
- Classes: PascalCase (`Logger`, `ProcessManager`, `MauticDeployer`)
- Functions: camelCase, async prefix optional (`async obtainCertificate()`)
- Environment variables: SCREAMING_SNAKE_CASE (`MAUTIC_PASSWORD`, `MYSQL_ROOT_PASSWORD`)
- Docker containers: `mautibox_*` prefix (web, db, cron, worker)
- Volumes: `mautic_*` or `mysql_data`

## Testing & Validation

### Pre-deployment Checks
- Input validation in `action.yml` step
- `DeploymentConfig` interface prevents missing required fields
- Docker Compose validation: `docker compose config`
- Health checks run before dependent services start

### Debugging
- Deployment log uploaded to GitHub Actions artifacts: `mautic-deployment-log`
- All logs written to `/var/log/setup-dc.log` on VPS
- Container logs: `docker compose logs -f [service]`
- SSH into VPS: `ssh -i ~/.ssh/mautic_deploy_temp_key root@VPS_IP`

## Maintenance & Updates

### Mautic Version Updates
- Change `mautic-version` input in workflow (default: `6.0.5-apache`)
- Script detects existing installation and performs upgrade
- Docker pulls new image, recreates containers while preserving volumes

### Selectel API Changes
- Monitor `SELECTEL_API_URL` endpoint (currently `https://api.vscale.io/v1`)
- Check response format in `deploy_selectel.sh` curl calls
- Update image IDs if `ubuntu_22.04_64_001_master` changes

### Russian Language Default
- `locale` input defaults to `ru` (Russian)
- `default-timezone` defaults to `Europe/Moscow`
- Language pack URL points to GitHub: `language-packs/mautibox_ru.zip`
- Configurable per deployment if needed