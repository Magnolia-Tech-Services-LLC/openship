/**
 * Build-first cutover helpers for deployServiceWorkload.
 * Newcomer names must NOT match magnolia-mesh exact alias map keys.
 */
export type CutoverConfig = {
  ports: string[];
  volumes: string[];
  publicPort?: number;
  slug: string;
  serviceName: string;
  deploymentId: string;
};
/** Explicit host publish (hostPort:containerPort or ip:host:container). Bare "3000" is not a host collision. */
export function hasHostPortBindings(ports: string[]): boolean {
  return ports.some((p) => {
    const mapping = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : p;
    return mapping.includes(":");
  });
}
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
export function rwVolumeDest(spec: string): string | null {
  const body = spec.replace(/:(ro|rw|z|Z|nocopy)$/i, "");
  const parts = body.split(":");
  if (parts.length < 2) return null;
  return parts[parts.length - 1] || null;
}
