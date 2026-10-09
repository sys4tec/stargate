import { readFileSync } from "node:fs";
import { logger } from "../logs/logger.js";
import type { Task } from "../../types/task.js";
import type { InternalSystemRequestConfig } from "../../types/internal-system-request-config.js";
import { Metrics } from "../metrics/metrics.js";


export type TaskResult = {
  ok: boolean;
  status: number | null;
  responseBody: string;
  error?: string;
};

// Loaded once at module import. Value is reused for every task — the file is
// never re-read at runtime. Restart the process to pick up changes.
const internalSystemRequestConfig = loadInternalSystemRequestConfig();

function loadInternalSystemRequestConfig(): InternalSystemRequestConfig | null {
  const path = process.env.INTERNAL_SYSTEM_REQUEST_CONFIG;
  if (!path) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as InternalSystemRequestConfig;
    logger.info("internal_system_config_loaded", {
      path,
      headerNames: parsed.headers ? Object.keys(parsed.headers) : [],
    });
    return parsed;
  } catch (err) {
    logger.error("internal_system_config_load_failed", {
      path,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

export class TaskProcessor {
  async process(task: Task): Promise<TaskResult> {
    const baseUrl = process.env.INTERNAL_SYSTEM_URL;
    const authHeaderName = process.env.INTERNAL_AUTHORIZATION_HEADER_NAME ?? 'Authorization';
    const authHeaderValue = process.env.INTERNAL_AUTHORIZATION_HEADER_VALUE;

    if (!baseUrl) {
      Metrics.tickTasksFailed()
      logger.error("task_processor_misconfigured", {
        hasUrl: Boolean(baseUrl),
        hasAuth: Boolean(authHeaderName) && Boolean(authHeaderValue),
      });
      const result: TaskResult = {
        ok: false,
        status: null,
        responseBody: "",
        error:
          "INTERNAL_SYSTEM_URL or INTERNAL_AUTHORIZATION_HEADER not configured",
      };
      await this.report(task, result);
      return result;
    }

    const url = `${baseUrl}${task.uri}`;
    const headers: Record<string, string> = {};
    if (internalSystemRequestConfig?.headers) {
      Object.assign(headers, internalSystemRequestConfig.headers);
    }
    if (task.headers) {
      Object.assign(headers, task.headers);
    }
    if (authHeaderName && authHeaderValue) {
      headers[authHeaderName] = authHeaderValue;
    }
    const init: RequestInit = {
      method: task.method,
      headers,
    };

    // A body of exactly { body_b64: "<base64>" } is sent as raw bytes (e.g. a
    // multipart payload built by the client, with its Content-Type passed in
    // task.headers).
    const b64 = extractBodyB64(task.body);
    let bodyEncoding: "b64" | "json" | null = null;

    if (b64 !== null && !isBodyless(task.method)) {
      if (!isValidBase64(b64)) {
        Metrics.tickTasksFailed()
        logger.error("task_body_b64_invalid", {
          id: task.stargate_task_id,
          method: task.method,
          uri: task.uri,
          length: b64.length,
        });
        const result: TaskResult = {
          ok: false,
          status: null,
          responseBody: "",
          error: "body_b64 is not valid base64",
        };
        await this.report(task, result);
        return result;
      }
      init.body = new Uint8Array(Buffer.from(b64, "base64"));
      bodyEncoding = "b64";
    } else if (task.body !== null && task.body !== undefined && !isBodyless(task.method)) {
      init.body = JSON.stringify(task.body);
      bodyEncoding = "json";
      if (!hasHeader(headers, "Content-Type")) {
        headers["Content-Type"] = "application/json";
      }
    }

    const startedAt = Date.now();
    logger.info("task_started", {
      id: task.stargate_task_id,
      method: task.method,
      uri: task.uri,
      target: url,
      headers: headers,
      hasBody: init.body !== undefined,
      bodyEncoding,
      bodyBytes:
        init.body instanceof Uint8Array
          ? init.body.byteLength
          : typeof init.body === "string"
            ? Buffer.byteLength(init.body)
            : 0,
    });

    let result: TaskResult;
    try {
      const res = await fetch(url, init);
      const responseBody = await res.text();
      logger.info("task_processed", {
        id: task.stargate_task_id,
        method: task.method,
        uri: task.uri,
        status: res.status,
        ok: res.ok,
        durationMs: Date.now() - startedAt,
      });
      Metrics.tickTasksCompleted()
      result = {
        ok: res.ok,
        status: res.status,
        responseBody,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Metrics.tickTasksFailed()
      logger.error("task_process_error", {
        id: task.stargate_task_id,
        method: task.method,
        uri: task.uri,
        message,
        durationMs: Date.now() - startedAt,
      });
      result = {
        ok: false,
        status: null,
        responseBody: "",
        error: message,
      };
    }

    await this.report(task, result);
    return result;
  }

  private async report(task: Task, result: TaskResult): Promise<void> {
    const stargateUrl = process.env.ALLOY_API_URL;
    const apiKey = process.env.ALLOY_API_KEY;

    if (!stargateUrl || !apiKey) {
      Metrics.tickTasksReportFailed()
      logger.error("task_report_misconfigured", {
        id: task.stargate_task_id,
        hasUrl: Boolean(stargateUrl),
        hasKey: Boolean(apiKey),
      });
      return;
    }

    const url = `${stargateUrl}/api/private/stargate/${encodeURIComponent(task.stargate_task_id)}`;
    const body = JSON.stringify({
      ok: result.ok,
      status: result.status,
      body: tryParseJson(result.responseBody),
      error: result.error,
    });

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
        },
        body,
      });
      Metrics.tickTasksReportCompleted()
      logger.info("task_reported", {
        id: task.stargate_task_id,
        status: res.status,
        ok: res.ok,
      });
    } catch (err) {
      Metrics.tickTasksReportFailed()
      logger.error("task_report_error", {
        id: task.stargate_task_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function isBodyless(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

// Returns the base64 string only when body is exactly { body_b64: string };
// anything else (extra keys, arrays, non-string value) stays a JSON body.
function extractBodyB64(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "body_b64") return null;
  const value = (body as { body_b64: unknown }).body_b64;
  return typeof value === "string" ? value : null;
}

function isValidBase64(s: string): boolean {
  return s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
}

function tryParseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
