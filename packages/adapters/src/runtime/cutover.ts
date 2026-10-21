/**
 * Pure helpers for the build-first overlap cutover in
 * `DockerRuntime.deployServiceWorkload`.
 *
 * Overlap: start the replacement under a temporary name, wait until it serves,
 * move the incumbent's extra networks and aliases to it, then retire the
 * incumbent. Replace (the upstream behaviour): stop and remove the incumbent
 * first, then create. Overlap is only safe when the two containers can run side
 * by side, so anything that could collide forces replace.
 */
export type CutoverConfig = {
  ports: string[];
  volumes: string[];
  publicPort?: number;
  slug: string;
  serviceName: string;
  deploymentId: string;
};

/** Env var holding the shared read/write mount opt-in list. */
export const CUTOVER_SHARED_VOLUMES_ENV = "OPENSHIP_CUTOVER_SHARED_VOLUMES";

/** Explicit host publish (hostPort:containerPort or ip:host:container). Bare "3000" is not a host collision. */
export function hasHostPortBindings(ports: string[]): boolean {
  return ports.some((p) => {
    const mapping = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : p;
    return mapping.includes(":");
  });
}

/** Temporary name for the replacement while the incumbent still serves. */
export function newcomerName(cfg: Pick<CutoverConfig, "deploymentId" | "serviceName">): string {
  const id = cfg.deploymentId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  return `openship-cutover-${id}-${cfg.serviceName}`;
}

export function stableName(cfg: Pick<CutoverConfig, "slug" | "serviceName">): string {
  return `openship-${cfg.slug}-${cfg.serviceName}`;
}

export function prevName(cfg: Pick<CutoverConfig, "slug" | "serviceName">): string {
  return `${stableName(cfg)}-prev`;
}

function normalizeDest(dest: string): string {
  return dest.length > 1 ? dest.replace(/\/+$/, "") : dest;
}

/**
 * Container destination of a read/write volume spec, or null when the spec is
 * read-only or has no destination (anonymous volume).
 */
export function rwVolumeDest(spec: string): string | null {
  const modeMatch = spec.match(/:([a-zA-Z,]+)$/);
  let body = spec;
  if (modeMatch && /^(ro|rw|z|Z|nocopy|cached|delegated|consistent)(,(ro|rw|z|Z|nocopy|cached|delegated|consistent))*$/.test(modeMatch[1]!)) {
    if (modeMatch[1]!.split(",").includes("ro")) return null;
    body = spec.slice(0, -modeMatch[0].length);
  }
  const parts = body.split(":");
  if (parts.length < 2) return null;
  const dest = parts[parts.length - 1];
  return dest ? normalizeDest(dest) : null;
}

/** Key used in the opt-in list: `<project-slug>/<service>:<container-destination>`. */
export function sharedVolumeKey(slug: string, serviceName: string, dest: string): string {
  return `${slug}/${serviceName}:${normalizeDest(dest)}`;
}

/**
 * Parse the shared-volume opt-in list. Entries are separated by whitespace or
 * commas and look like `<project-slug>/<service>:<container-destination>`.
 * Malformed entries are ignored, so a typo can only ever keep the safe default.
 */
export function parseSharedVolumeOptIn(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const entry of raw.split(/[\s,]+/)) {
    const m = entry.match(/^([^/\s:]+)\/([^/\s:]+):(\/\S*)$/);
    if (!m) continue;
    out.add(sharedVolumeKey(m[1]!, m[2]!, m[3]!));
  }
  return out;
}

/**
 * Read/write destinations the replacement would share with the running
 * incumbent and that are NOT opted in. Any result forces the replace path.
 */
export function clashingRwDestinations(opts: {
  incumbentRwDests: Iterable<string>;
  volumes: string[];
  slug: string;
  serviceName: string;
  sharedOptIn: ReadonlySet<string>;
}): string[] {
  const live = new Set([...opts.incumbentRwDests].map(normalizeDest));
  const clashes: string[] = [];
  for (const spec of opts.volumes) {
    const dest = rwVolumeDest(spec);
    if (!dest || !live.has(dest)) continue;
    if (opts.sharedOptIn.has(sharedVolumeKey(opts.slug, opts.serviceName, dest))) continue;
    if (!clashes.includes(dest)) clashes.push(dest);
  }
  return clashes;
}

export type CutoverDecision =
  | { mode: "overlap" }
  | { mode: "replace"; reason: "no-incumbent" | "host-ports" | "shared-rw-volume"; clashes?: string[] };

export function decideCutover(opts: {
  incumbentRunning: boolean;
  incumbentRwDests: Iterable<string>;
  ports: string[];
  volumes: string[];
  slug: string;
  serviceName: string;
  sharedOptIn: ReadonlySet<string>;
}): CutoverDecision {
  if (!opts.incumbentRunning) return { mode: "replace", reason: "no-incumbent" };
  if (hasHostPortBindings(opts.ports)) return { mode: "replace", reason: "host-ports" };
  const clashes = clashingRwDestinations(opts);
  if (clashes.length > 0) return { mode: "replace", reason: "shared-rw-volume", clashes };
  return { mode: "overlap" };
}

/**
 * Networks the incumbent is attached to that the replacement is not (for
 * example an operator-managed shared network), with the aliases to carry.
 * The incumbent's own name and id are never carried as aliases.
 */
export function networksToCarry(opts: {
  incumbentNetworks: Record<string, { Aliases?: string[] | null } | undefined>;
  newcomerNetworks: Iterable<string>;
  incumbentIdentity: Array<string | undefined | null>;
}): Array<{ network: string; aliases: string[] }> {
  const already = new Set(opts.newcomerNetworks);
  const skip = new Set(opts.incumbentIdentity.filter((v): v is string => !!v).map((v) => v.replace(/^\//, "")));
  const out: Array<{ network: string; aliases: string[] }> = [];
  for (const [network, endpoint] of Object.entries(opts.incumbentNetworks)) {
    if (already.has(network)) continue;
    if (network === "host" || network === "none") continue;
    const aliases = [...new Set((endpoint?.Aliases ?? []).filter((a) => a && !skip.has(a)))];
    out.push({ network, aliases });
  }
  return out;
}
