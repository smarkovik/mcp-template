import { readFileSync } from 'fs';
import { resolve } from 'path';
import { load as parseYaml } from 'js-yaml';
import { createRequire } from 'module';
import type { ServerConfig, AuthConfig } from './types.js';

const require = createRequire(import.meta.url);
// AJV ships as CJS; require() gives us the constructor directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
type AjvValidateFunction = ((data: unknown) => boolean) & {
  errors?: Array<{ instancePath: string; message?: string }> | null;
};
const AjvConstructor = require('ajv') as new (opts?: { allErrors?: boolean }) => {
  compile(schema: unknown): AjvValidateFunction;
};
const schema = require('../schema/config.schema.json');

const ajv = new AjvConstructor({ allErrors: true });
const validate = ajv.compile(schema);

const ENV_VAR_RE = /\$\{([^}]+)\}/g;

function interpolateEnvVars(value: string): string {
  return value.replace(ENV_VAR_RE, (_, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      throw new Error(`Environment variable "${name}" is not set`);
    }
    return resolved;
  });
}

function resolveAuth(auth: AuthConfig | undefined): void {
  if (!auth) return;
  if (auth.value) auth.value = interpolateEnvVars(auth.value);
  if (auth.username) auth.username = interpolateEnvVars(auth.username);
  if (auth.password) auth.password = interpolateEnvVars(auth.password);
}

function resolveAuthEnvVars(config: ServerConfig): void {
  resolveAuth(config.defaults?.auth);
  for (const tool of config.tools) {
    resolveAuth(tool.auth);
  }
}

export function loadConfig(): ServerConfig {
  const configPath = resolve(
    process.env['MCP_CONFIG_PATH'] ?? './config/tools.yaml'
  );

  let raw: unknown;
  try {
    const content = readFileSync(configPath, 'utf-8');
    raw = parseYaml(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`CONFIG_INVALID: Failed to read or parse config: ${msg}`), {
      code: 'CONFIG_INVALID',
    });
  }

  const valid = validate(raw);
  if (!valid) {
    const errors = validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ');
    throw Object.assign(new Error(`CONFIG_INVALID: ${errors}`), {
      code: 'CONFIG_INVALID',
    });
  }

  const config = raw as ServerConfig;

  try {
    resolveAuthEnvVars(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`CONFIG_INVALID: ${msg}`), {
      code: 'CONFIG_INVALID',
    });
  }

  return config;
}
