"use client";
import { useSyncExternalStore } from "react";
import { isRemotePlatform } from "./remote-platform";
const subscribe = () => () => {};
// Match the server's first render, then apply the paired phone transport before
// interaction. Reading localStorage directly in render causes stale SSR links.
export function useRemotePlatform() { return useSyncExternalStore(subscribe, isRemotePlatform, () => false); }
