import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export const nodeQueryKey = ["nodes"] as const;

export function useNodes() {
  return useQuery({ queryKey: nodeQueryKey, queryFn: api.listNodes });
}
