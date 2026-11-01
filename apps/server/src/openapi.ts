import { parse as parseYaml } from "yaml";

export interface ApiOperation {
  /** tool-safe operation name */
  name: string;
  method: string;
  path: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema for path/query params
  bodySchema?: Record<string, unknown>;
}

interface RawParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string; enum?: unknown[]; default?: unknown };
}

export interface ParsedSpec {
  baseUrl: string;
  operations: ApiOperation[];
  securityNote: string;
}

export function parseOpenApi(specText: string, baseUrlOverride?: string): ParsedSpec {
  const trimmed = specText.trim();
  const spec = trimmed.startsWith("{")
    ? (JSON.parse(trimmed) as Record<string, never>)
    : (parseYaml(trimmed) as Record<string, never>);
  const openapi = spec as unknown as {
    servers?: { url: string }[];
    paths?: Record<string, Record<string, unknown>>;
    info?: { title?: string; version?: string };
  };
  const baseUrl = baseUrlOverride || openapi.servers?.[0]?.url;
  if (!baseUrl) throw new Error("spec has no servers[0].url and no baseUrl override given");

  const operations: ApiOperation[] = [];
  for (const [route, pathItem] of Object.entries(openapi.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = (pathItem as Record<string, unknown>)[method] as
        | { operationId?: string; summary?: string; description?: string; parameters?: RawParameter[]; requestBody?: unknown }
        | undefined;
      if (!op) continue;
      const params = (op.parameters ?? []).filter((p) => p.in === "query" || p.in === "path");
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const p of params) {
        properties[p.name] = {
          type: p.schema?.type ?? "string",
          description: `${p.in} parameter. ${p.description ?? ""}`.trim(),
          ...(p.schema?.enum ? { enum: p.schema.enum } : {}),
        };
        if (p.in === "path" || p.required) required.push(p.name);
      }
      const bodySchema = extractBodySchema(op.requestBody);
      if (bodySchema) {
        properties.body = { type: "object", description: "request body", ...(bodySchema as object) } as Record<string, unknown>;
      }
      const name =
        op.operationId ||
        `${method}_${route.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
      operations.push({
        name: name.replace(/[^a-zA-Z0-9._-]/g, "_"),
        method: method.toUpperCase(),
        path: route,
        description: op.summary || op.description || `${method.toUpperCase()} ${route}`,
        parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
        bodySchema,
      });
    }
  }
  if (operations.length === 0) throw new Error("spec contains no operations");
  return { baseUrl, operations, securityNote: openapi.info?.title ?? "openapi" };
}

function extractBodySchema(requestBody: unknown): Record<string, unknown> | undefined {
  const rb = requestBody as
    | { content?: Record<string, { schema?: Record<string, unknown> }> }
    | undefined;
  const json = rb?.content?.["application/json"]?.schema;
  if (!json) return undefined;
  const props = (json.properties ?? {}) as Record<string, unknown>;
  const req = (json.required ?? []) as string[];
  return { properties: props, ...(req.length ? { required: req } : {}) };
}

export async function executeOperation(
  baseUrl: string,
  op: ApiOperation,
  args: Record<string, unknown>,
  auth?: { type: "bearer" | "apiKey"; token?: string; header?: string }
): Promise<unknown> {
  let url = `${baseUrl.replace(/\/$/, "")}${op.path}`;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (key === "body") continue;
    if (url.includes(`{${key}}`)) {
      url = url.replaceAll(`{${key}}`, encodeURIComponent(String(value)));
    } else {
      query.set(key, String(value));
    }
  }
  const qs = query.toString();
  const headers: Record<string, string> = { accept: "application/json" };
  if (auth?.token) {
    if (auth.type === "bearer") headers.authorization = `Bearer ${auth.token}`;
    else headers[auth.header ?? "x-api-key"] = auth.token;
  }
  let body: string | undefined;
  if (op.method !== "GET" && args.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(args.body);
  }
  const res = await fetch(qs ? `${url}?${qs}` : url, {
    method: op.method,
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text().catch(() => "");
  let parsed: unknown = text.slice(0, 20_000);
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, ok: res.ok, body: parsed };
}
