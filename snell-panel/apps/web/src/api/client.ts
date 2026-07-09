import type {
  ApiError,
  CreateNodeInput,
  InstallCommandResponse,
  NodeDTO,
  PatchNodeInput,
  RelayNodeInput,
  SettingsResponse,
  SnellVersionsResponse,
} from "@snell-panel/shared";
import { clearToken, getToken, UNAUTHORIZED_EVENT } from "../lib/auth";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

type JsonBody = Record<string, unknown> | unknown[];

interface ApiRequestInit extends Omit<RequestInit, "body"> {
  body?: RequestInit["body"] | JsonBody;
}

function isJsonBody(body: ApiRequestInit["body"]): body is JsonBody {
  return (
    body !== undefined &&
    typeof body !== "string" &&
    !(body instanceof FormData) &&
    !(body instanceof URLSearchParams) &&
    !(body instanceof Blob) &&
    !(body instanceof ArrayBuffer)
  );
}

function buildRequest(init: ApiRequestInit): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${getToken()}`);

  let body = init.body;
  if (isJsonBody(body)) {
    body = JSON.stringify(body);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }

  return { ...init, headers, body };
}

async function readError(res: Response): Promise<string> {
  const fallback = res.statusText || "Request failed";
  const body = (await res.json().catch(() => null)) as ApiError | null;
  return body?.error || fallback;
}

async function req<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const res = await fetch(path, buildRequest(init));

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiRequestError("Unauthorized", res.status);
  }
  if (!res.ok) {
    throw new ApiRequestError(await readError(res), res.status);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const unwrapNode = (response: { node: NodeDTO }) => response.node;

export const api = {
  versions: () => req<SnellVersionsResponse>("/api/snell-versions"),
  settings: () => req<SettingsResponse>("/api/settings"),
  resetSubscribeToken: () =>
    req<SettingsResponse>("/api/settings/subscribe-token/reset", { method: "POST" }),

  listNodes: () => req<{ nodes: NodeDTO[] }>("/api/nodes").then((r) => r.nodes),
  createNode: (body: CreateNodeInput) =>
    req<{ node: NodeDTO }>("/api/nodes", { method: "POST", body }).then(unwrapNode),
  patchNode: (id: string, body: PatchNodeInput) =>
    req<{ node: NodeDTO }>(`/api/nodes/${id}`, { method: "PATCH", body }).then(unwrapNode),
  deleteNode: (id: string) =>
    req<{ ok: boolean }>(`/api/nodes/${id}`, { method: "DELETE" }),
  relayNode: (id: string, body: RelayNodeInput) =>
    req<{ node: NodeDTO }>(`/api/nodes/${id}/relay`, { method: "POST", body }).then(unwrapNode),
  installCommand: (id: string) =>
    req<InstallCommandResponse>(`/api/nodes/${id}/install`),
  upgradeCommand: (id: string) =>
    req<InstallCommandResponse>(`/api/nodes/${id}/upgrade`),
};
