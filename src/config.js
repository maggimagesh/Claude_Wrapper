/**
 * Config file handling.
 *
 * Precedence: CLI flags > config file > defaults. The file is optional and a
 * broken one is a warning, not a crash -- the wrapper still works without it.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const CONFIG_PATH = join(homedir(), '.config', 'claudecode-wrapper', 'config.json');

export const DEFAULTS = {
  reply: 'terse',
  slots: 'auto',
  stats: true,
  stream: false,
  model: null,
  bin: 'claude',
  permissionMode: null,
};

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...parsed };
  } catch (error) {
    process.stderr.write(`claudecode-wrapper: ignoring invalid config at ${CONFIG_PATH} (${error.message})\n`);
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const merged = { ...loadConfig(), ...config };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  return CONFIG_PATH;
}
