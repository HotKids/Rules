const TOKEN_KEY = "snell_access_token";
const MODE_KEY = "snell_auth_storage";

type AuthStorageMode = "local" | "session" | "memory";

let memoryToken = "";

export const UNAUTHORIZED_EVENT = "snell:unauthorized";

function mode(): AuthStorageMode {
  const value = localStorage.getItem(MODE_KEY);
  return value === "session" || value === "memory" ? value : "local";
}

function storeFor(modeValue: AuthStorageMode): Storage | null {
  if (modeValue === "memory") return null;
  return modeValue === "session" ? sessionStorage : localStorage;
}

export const getToken = (): string => {
  const currentMode = mode();
  if (currentMode === "memory") return memoryToken;
  return storeFor(currentMode)?.getItem(TOKEN_KEY) ?? "";
};

export const setToken = (t: string, storageMode: AuthStorageMode = "local"): void => {
  localStorage.setItem(MODE_KEY, storageMode);
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  memoryToken = "";
  const store = storeFor(storageMode);
  if (store) store.setItem(TOKEN_KEY, t);
  else memoryToken = t;
};

export const clearToken = (): void => {
  memoryToken = "";
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
};

export const hasToken = (): boolean => getToken() !== "";
