const TOKEN_KEY = "snell_access_token";

export const UNAUTHORIZED_EVENT = "snell:unauthorized";

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);
export const hasToken = (): boolean => getToken() !== "";
