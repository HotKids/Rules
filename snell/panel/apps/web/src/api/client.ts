import type {
  CreateNodeInput,
  InstallCommandResponse,
  NodeDTO,
  PatchNodeInput,
  RelayNodeInput,
  SettingsResponse,
  SnellVersionsResponse,
} from "@snell-panel/shared";
import { clearToken, getToken, UNAUTHORIZED_EVENT } from "../lib/auth";

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getToken()}`,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { ...init, headers });

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as {
      error?: string;
    };
    throw new Error(body.error || "Request failed");
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  versions: () => req<SnellVersionsResponse>("/api/snell-versions"),
  settings: () => req<SettingsResponse>("/api/settings"),
  resetSubscribeToken: () =>
    req<SettingsResponse>("/api/settings/subscribe-token/reset", { method: "POST" }),

  listNodes: () => req<{ nodes: NodeDTO[] }>("/api/nodes").then((r) => r.nodes),
  createNode: (body: CreateNodeInput) =>
    req<{ node: NodeDTO }>("/api/nodes", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.node),
  patchNode: (id: string, body: PatchNodeInput) =>
    req<{ node: NodeDTO }>(`/api/nodes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((r) => r.node),
  deleteNode: (id: string) =>
    req<{ ok: boolean }>(`/api/nodes/${id}`, { method: "DELETE" }),
  relayNode: (id: string, body: RelayNodeInput) =>
    req<{ node: NodeDTO }>(`/api/nodes/${id}/relay`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.node),
  installCommand: (id: string) =>
    req<InstallCommandResponse>(`/api/nodes/${id}/install`),
  upgradeCommand: (id: string) =>
    req<InstallCommandResponse>(`/api/nodes/${id}/upgrade`),
};
