import type { IconPack } from "./custom-icons";

type Vector = { viewBox: string; body: string };
type VectorPack = Record<string, Vector>;
type LazyPack = Exclude<IconPack, "badges">;

const loaders: Record<LazyPack, () => Promise<{ default: VectorPack }>> = {
  minimal: () => import("./generated-icon-pack-minimal"),
  duotone: () => import("./generated-icon-pack-duotone"),
  neon: () => import("./generated-icon-pack-neon"),
  carbon: () => import("./generated-icon-pack-carbon"),
  iconoir: () => import("./generated-icon-pack-iconoir"),
  fluent: () => import("./generated-icon-pack-fluent"),
};
const loaded: Partial<Record<LazyPack, VectorPack>> = {};
const pending: Partial<Record<LazyPack, Promise<void>>> = {};
const listeners = new Set<() => void>();

export function subscribeIconPacks(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getIconPack(pack: IconPack): VectorPack | null {
  return pack === "badges" ? null : loaded[pack] ?? null;
}

export function loadIconPack(pack: IconPack) {
  if (pack === "badges" || loaded[pack]) return;
  pending[pack] ??= loaders[pack]().then(({ default: vectors }) => {
    loaded[pack] = vectors;
    for (const listener of listeners) listener();
  }).catch(() => { delete pending[pack]; });
}
