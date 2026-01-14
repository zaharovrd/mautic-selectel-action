# Исправление гонки состояний в SSL конфигурации Nginx

## Проблема

При указании домена конфигурация Nginx обрывалась на середине файла:

```nginx
server {
    listen 80;
    server_name demo.mautibox.ru;
    
    location / {
        proxy_pass http://localhost:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
# ОБРЫВАЕТСЯ ТУТ!
```

### Причина: Race Condition (гонка состояний)

Проблема была в методе `setupSSL()` класса `SSLManager`:

1. **setupNginx()** создавала минимальный конфиг и писала его в `/etc/nginx/sites-available/domain.name`
2. **generateCertificate()** сразу же вызывал `certbot --nginx`, который перезаписывал тот же файл
3. **Гонка**: операции происходили почти одновременно, и `certbot` начинал писать в файл, пока `setupNginx()` еще не завершила свою запись
4. **Результат**: файловая система испытывала конфликт, и файл становился неполным

### Проблемные строки в оригинальном коде

```typescript
// ssl-manager.ts - оригинальный код
private async setupNginx(): Promise<void> {
  // ... код ...
  await Deno.writeTextFile(`/etc/nginx/sites-available/${this.config.domainName}`, nginxConfig);
  await ProcessManager.runShell(`ln -sf ...`);
  await ProcessManager.runShell('nginx -t', ...);
  // НО! Метод не ждет завершения - как только nginx -t завершится,
  // setupSSL() переходит к setupCertificate()
}

// И сразу же в setupSSL():
const certSuccess = await this.generateCertificate(); // ← Это может перезаписать файл!
```

## Решение

### 1. Использование полного шаблона вместо минимального конфига

**Было:**
```typescript
const nginxConfig = `server { listen 80; ... }`.trim();
```

**Стало:**
```typescript
const templatePath = 'templates/nginx-virtual-host-template';
let nginxConfig = await Deno.readTextFile(templatePath);
nginxConfig = nginxConfig
  .replace(/DOMAIN_NAME/g, this.config.domainName)
  .replace(/PORT/g, String(this.config.port));
```

Полный шаблон содержит все необходимые параметры: WebSocket поддержка, timeouts, gzip, security headers и т.д.

### 2. Атомарная запись файла

**Было:**
```typescript
await Deno.writeTextFile(configPath, nginxConfig);
```

**Стало:**
```typescript
// Запись в временный файл
await Deno.writeTextFile(tempPath, nginxConfig);

// Проверка целостности
const tempContent = await Deno.readTextFile(tempPath);
if (tempContent.split('\n').length !== nginxConfig.split('\n').length) {
  throw new Error('File write verification failed');
}

// Атомарная операция rename (не может быть прервана)
await Deno.rename(tempPath, configPath);

// Верификация финального файла
const finalContent = await Deno.readTextFile(configPath);
if (!finalContent.includes('proxy_pass http://localhost:')) {
  throw new Error('Final configuration file is incomplete');
}
```

**Преимущества:**
- `rename` - атомарная операция на уровне ОС (неделима)
- Проверка целостности перед финализацией
- Исключает возможность частичной записи

### 3. Явная синхронизация между операциями

**Было:**
```typescript
await this.setupNginx();      // завершается
const certSuccess = await this.generateCertificate(); // сразу запускается
```

**Стало:**
```typescript
// В setupNginx() ПОСЛЕ успешного reload nginx:
Logger.log('Waiting for filesystem sync...', '⏳');
await new Promise(resolve => setTimeout(resolve, 1000));

// В generateCertificate() ПЕРЕД certbot:
Logger.log('Waiting for filesystem operations to complete...', '⏳');
await new Promise(resolve => setTimeout(resolve, 2000));

// Также добавлена проверка файла перед certbot:
const preCheckResult = await ProcessManager.runShell(
  `test -f ${configPath} && stat -c "Size: %s bytes" ${configPath}`,
  { ignoreError: true }
);
```

### 4. Комплексная верификация на каждом шаге

**Добавлены проверки:**
- ✓ Проверка временного файла
- ✓ Проверка финального файла после rename
- ✓ Верификация symlink
- ✓ Тестирование Nginx конфигурации (`nginx -t`)
- ✓ Проверка перед certbot
- ✓ Проверка финальной конфигурации после certbot

## Изменения в коде

### файл: `scripts/ssl-manager.ts`

#### Метод `setupNginx()` - полностью переписан

**Что изменилось:**
1. Загружает полный шаблон из `templates/nginx-virtual-host-template`
2. Заменяет плейсхолдеры на реальные значения
3. Пишет в `.tmp` файл для атомарности
4. Проверяет целостность временного файла
5. Атомарно переимует в финальное место
6. Проверяет финальный файл
7. Создает symlink
8. Тестирует конфиг
9. Перезагружает Nginx
10. Финальная верификация целостности

#### Метод `generateCertificate()` - улучшена синхронизация

**Что изменилось:**
1. Проверяет файл перед запуском certbot
2. Ждет 2 секунды для полной синхронизации FS
3. Запускает certbot с флагом `--keep-until-expiring`
4. Ловит случай, когда сертификат уже существует
5. Проверяет финальную конфигурацию
6. Выполняет финальную верификацию целостности

## Тестирование

### Чтобы проверить исправление:

```bash
# 1. Посмотреть финальный конфиг
cat /etc/nginx/sites-available/demo.mautibox.ru

# 2. Должно быть 40+ строк, заканчиваться на }
wc -l /etc/nginx/sites-available/demo.mautibox.ru

# 3. Проверить наличие всех секций
grep "proxy_pass" /etc/nginx/sites-available/demo.mautibox.ru
grep "gzip on" /etc/nginx/sites-available/demo.mautibox.ru
grep "add_header" /etc/nginx/sites-available/demo.mautibox.ru

# 4. Проверить SSL конфиг (после certbot)
grep "listen 443 ssl" /etc/nginx/sites-available/demo.mautibox.ru
```

## Результат

Теперь конфигурация Nginx будет:
- **Полная** - содержит все параметры из шаблона
- **Целостная** - атомарная запись исключает частичные файлы
- **Синхронизированная** - явные ожидания между операциями
- **Верифицированная** - проверки на каждом шаге
- **Логируемая** - детальный лог каждого шага для отладки

Файл больше не будет обрываться!
