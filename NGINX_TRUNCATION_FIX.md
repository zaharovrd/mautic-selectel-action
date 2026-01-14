# Исправление обрывания Nginx конфигурации - Правильное решение

## Настоящая проблема

Файл конфигурации Nginx обрывался **не из-за гонки состояний**, а из-за **экранирования кавычек в bash**.

Когда содержимое файла передается через `ProcessManager.runShell()`, bash интерпретирует кавычки внутри строк:

```nginx
add_header Content-Security-Policy "default-src 'self' http: https: data: blob: 'unsafe-inline'" always;
                                     ↑
    Bash видит это и преждевременно закрывает строку!
```

## Корневая причина

Шаблон содержит строки с кавычками:
```nginx
proxy_set_header Connection "upgrade";
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Content-Security-Policy "default-src 'self' http: https: data: blob: 'unsafe-inline'" always;
```

Когда эти данные проходят через bash, происходит:
1. Bash начинает интерпретировать кавычки
2. Внутренние кавычки конфликтуют с bash-синтаксисом
3. Команда обрывается, файл остается неполным

## Решение: Использовать Deno.writeTextFile вместо runShell

### ❌ Неправильно (старый код):
```typescript
const nginxConfig = `server { ... add_header "..." ... }`;
await ProcessManager.runShell(`echo '${nginxConfig}' > ${configPath}`);
// ↑ Bash интерпретирует содержимое!
```

### ✅ Правильно (новый код):
```typescript
const nginxConfig = `server { ... add_header "..." ... }`;
await Deno.writeTextFile(configPath, nginxConfig, { create: true });
// ↑ Deno пишет напрямую в FS, минуя bash!
```

## Улучшения в исправленном коде

### 1. **Прямая запись через Deno API**
```typescript
await Deno.writeTextFile(tempPath, nginxConfig, { create: true });
```
- Минует bash-интерпретацию
- Безопасна для любых символов
- Атомарна на уровне ОС

### 2. **Комплексная верификация с использованием Deno API**
```typescript
// Вместо: runShell('wc -l ...') 
// Используем:
const tempContent = await Deno.readTextFile(tempPath);
const contentLines = tempContent.split('\n').length;
const tempSize = new TextEncoder().encode(tempContent).length;

Logger.log(`  - Expected size: ${expectedSize} bytes, got: ${tempSize} bytes`, '📊');
```

### 3. **Нет использования runShell для операций с файлами**
```typescript
// ❌ Не делаем:
await ProcessManager.runShell(`ln -sf ${configPath} ${enabledPath}`);
await ProcessManager.runShell(`wc -l ${configPath}`);
await ProcessManager.runShell(`tail -c 50 ${configPath}`);

// ✅ Вместо этого:
await Deno.rename(tempPath, configPath);
const fileStats = await Deno.stat(configPath);
const content = await Deno.readTextFile(configPath);
```

### 4. **Финальная проверка целостности**
```typescript
// После certbot:
const finalRecheck = await Deno.readTextFile(configPath);
if (!finalRecheck.trimEnd().endsWith('}')) {
  throw new Error(`Configuration file is truncated`);
}
```

## Что изменилось в ssl-manager.ts

### setupNginx()
- ✅ Используется `Deno.writeTextFile()` для атомарной записи
- ✅ Проверка целостности через Deno API (размер в байтах)
- ✅ Логирование последних 5 строк файла перед rename
- ✅ Логирование последних 5 строк после rename

### generateCertificate()
- ✅ Проверка файла после certbot через Deno API только
- ✅ Логирование последних 10 строк файла
- ✅ Проверка что файл заканчивается на `}`
- ✅ Нет использования `wc -l` или `tail` через runShell

## Тестирование

После деплоя проверьте:

```bash
# Посмотреть полный файл
cat /etc/nginx/sites-available/demo.mautibox.ru

# Проверить что файл полный
tail -c 1 /etc/nginx/sites-available/demo.mautibox.ru | od -c
# Должен быть: 000000000 } \n
```

## Ключевой вывод

**Никогда не передавайте данные, содержащие кавычки и спецсимволы, через bash CLI.**

Используйте нативные API:
- Deno для файловых операций
- Прямые системные вызовы
- Специализированные языковые функции

Это гарантирует:
- ✅ Безопасность
- ✅ Предсказуемость
- ✅ Полноту файлов
- ✅ Нет утечек памяти
