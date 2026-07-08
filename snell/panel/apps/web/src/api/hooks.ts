import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export function useNodes() {
  return useQuery({ queryKey: ["nodes"], queryFn: api.listNodes });
}
