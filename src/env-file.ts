import { readFileSync, existsSync } from 'node:fs';

import { ConfigError } from './woocommerce/errors.js';

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function parseEnvFile(contents: string): Record<string, string> {
  const text = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = LINE.exec(line);
    if (!match) {
      throw new ConfigError(`Could not parse .env line ${index + 1}.`);
    }
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) {
      throw new ConfigError(`Could not parse .env line ${index + 1}.`);
    }
    values[key] = unquote(rawValue, index + 1);
  }
  return values;
}

export function loadEnvFile(target: NodeJS.ProcessEnv, filePath: string): void {
  if (!existsSync(filePath)) return;
  const parsed = parseEnvFile(readFileSync(filePath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) target[key] = value;
  }
}

function unquote(value: string, lineNumber: number): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return trimmed;
  if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== quote) {
    throw new ConfigError(`Could not parse .env line ${lineNumber}.`);
  }
  const inner = trimmed.slice(1, -1);
  if (quote === "'") return inner;
  return inner
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
