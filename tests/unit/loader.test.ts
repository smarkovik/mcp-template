import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We dynamically import loadConfig to avoid module-level side effects
async function getLoadConfig() {
  const mod = await import('../../src/loader.js');
  return mod.loadConfig;
}

const TMP = join(tmpdir(), 'mcp-proxy-loader-test');

function writeConfig(yaml: string): string {
  mkdirSync(TMP, { recursive: true });
  const path = join(TMP, 'tools.yaml');
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env['MCP_CONFIG_PATH'];
  delete process.env['TEST_API_KEY'];
});

const MINIMAL_VALID_YAML = `
version: "1.0"
server:
  name: test-server
  description: A test server
tools:
  - name: ping
    description: ping tool
    protocol: rest
    endpoint: https://example.com/ping
    method: GET
    input:
      schema: []
      mapping: []
    output:
      mapping: []
`;

describe('loadConfig', () => {
  it('loads a valid config', async () => {
    const path = writeConfig(MINIMAL_VALID_YAML);
    process.env['MCP_CONFIG_PATH'] = path;
    const loadConfig = await getLoadConfig();
    const config = loadConfig();
    expect(config.server.name).toBe('test-server');
    expect(config.tools).toHaveLength(1);
    expect(config.tools[0]?.name).toBe('ping');
  });

  it('throws CONFIG_INVALID for missing required field', async () => {
    const path = writeConfig(`
version: "1.0"
tools:
  - name: ping
    description: ping
    protocol: rest
    endpoint: https://example.com
    method: GET
    input:
      schema: []
      mapping: []
    output:
      mapping: []
`);
    process.env['MCP_CONFIG_PATH'] = path;
    const loadConfig = await getLoadConfig();
    expect(() => loadConfig()).toThrow('CONFIG_INVALID');
  });

  it('throws CONFIG_INVALID for unknown protocol', async () => {
    const path = writeConfig(`
version: "1.0"
server:
  name: s
  description: d
tools:
  - name: ping
    description: d
    protocol: graphql
    endpoint: https://example.com
    method: GET
    input:
      schema: []
      mapping: []
    output:
      mapping: []
`);
    process.env['MCP_CONFIG_PATH'] = path;
    const loadConfig = await getLoadConfig();
    expect(() => loadConfig()).toThrow('CONFIG_INVALID');
  });

  it('throws CONFIG_INVALID when config file does not exist', async () => {
    process.env['MCP_CONFIG_PATH'] = join(TMP, 'nonexistent.yaml');
    const loadConfig = await getLoadConfig();
    expect(() => loadConfig()).toThrow('CONFIG_INVALID');
  });

  it('resolves env vars in auth value', async () => {
    process.env['TEST_API_KEY'] = 'secret-key-123';
    const path = writeConfig(`
version: "1.0"
server:
  name: s
  description: d
defaults:
  auth:
    type: apikey
    header: Authorization
    value: Bearer \${TEST_API_KEY}
tools:
  - name: ping
    description: ping
    protocol: rest
    endpoint: https://example.com/ping
    method: GET
    input:
      schema: []
      mapping: []
    output:
      mapping: []
`);
    process.env['MCP_CONFIG_PATH'] = path;
    const loadConfig = await getLoadConfig();
    const config = loadConfig();
    expect(config.defaults?.auth?.value).toBe('Bearer secret-key-123');
  });

  it('throws CONFIG_INVALID when referenced env var is missing', async () => {
    const path = writeConfig(`
version: "1.0"
server:
  name: s
  description: d
defaults:
  auth:
    type: apikey
    header: Authorization
    value: Bearer \${MISSING_VAR_XYZ}
tools:
  - name: ping
    description: ping
    protocol: rest
    endpoint: https://example.com/ping
    method: GET
    input:
      schema: []
      mapping: []
    output:
      mapping: []
`);
    process.env['MCP_CONFIG_PATH'] = path;
    const loadConfig = await getLoadConfig();
    expect(() => loadConfig()).toThrow('CONFIG_INVALID');
  });

  it('applies tool-level auth override independently from defaults', async () => {
    process.env['TEST_API_KEY'] = 'global-key';
    const path = writeConfig(`
version: "1.0"
server:
  name: s
  description: d
defaults:
  auth:
    type: apikey
    header: Authorization
    value: Bearer \${TEST_API_KEY}
tools:
  - name: ping
    description: ping
    protocol: rest
    endpoint: https://example.com/ping
    method: GET
    auth:
      type: none
    input:
      schema: []
      mapping: []
    output:
      mapping: []
`);
    process.env['MCP_CONFIG_PATH'] = path;
    const loadConfig = await getLoadConfig();
    const config = loadConfig();
    expect(config.tools[0]?.auth?.type).toBe('none');
    expect(config.defaults?.auth?.value).toBe('Bearer global-key');
  });
});
