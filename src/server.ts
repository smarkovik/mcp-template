import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerConfig, ParameterSchema, ParamType } from './types.js';
import { routeToolCall } from './router.js';

function buildZodSchema(params: ParameterSchema[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const param of params) {
    let zodType: z.ZodTypeAny = buildZodType(param.type);

    if (param.default !== undefined) {
      zodType = zodType.default(param.default);
    }

    if (!param.required) {
      zodType = zodType.optional();
    }

    shape[param.name] = zodType.describe(param.description);
  }

  return shape;
}

function buildZodType(type: ParamType): z.ZodTypeAny {
  switch (type) {
    case 'string': return z.string();
    case 'number': return z.number();
    case 'integer': return z.number().int();
    case 'boolean': return z.boolean();
    case 'object': return z.record(z.string(), z.unknown());
    case 'array': return z.array(z.unknown());
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown param type: ${_exhaustive}`);
    }
  }
}

export function createMcpServer(config: ServerConfig): McpServer {
  const server = new McpServer({
    name: process.env['MCP_SERVER_NAME'] ?? config.server.name,
    version: config.version,
  });

  for (const tool of config.tools) {
    const zodShape = buildZodSchema(tool.input.schema);

    server.tool(
      tool.name,
      tool.description,
      zodShape,
      async (args) => {
        const result = await routeToolCall(tool.name, args as Record<string, unknown>, config);

        if (result['error'] === true) {
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }
    );
  }

  return server;
}
