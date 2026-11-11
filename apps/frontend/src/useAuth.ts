"use client";

import { useSyncExternalStore } from "react";
import { getAuth, getServerAuth, subscribeAuth } from "@/api";

/** Current operator token and whether the backend has asked for one. */
export function useAuth() {
  return useSyncExternalStore(subscribeAuth, getAuth, getServerAuth);
}
