import { describe, expect, it } from "vitest";

import {
  clashingRwDestinations,
  decideCutover,
  hasHostPortBindings,
  networksToCarry,
  newcomerName,
  parseSharedVolumeOptIn,
  rwVolumeDest,
} from "./cutover";

const BASE = {
  incumbentRunning: true,
  incumbentRwDests: ["/data"],
  ports: ["3000"],
  volumes: ["data:/data"],
  slug: "shop",
  serviceName: "web",
  sharedOptIn: new Set<string>(),
};

describe("cutover helpers", () => {
  it("treats only explicit host publishes as port collisions", () => {
    expect(hasHostPortBindings(["3000", "3000/tcp"])).toBe(false);
    expect(hasHostPortBindings(["8080:3000"])).toBe(true);
    expect(hasHostPortBindings(["127.0.0.1:8080:3000/tcp"])).toBe(true);
  });

  it("reads read/write destinations from volume specs", () => {
    expect(rwVolumeDest("data:/data")).toBe("/data");
    expect(rwVolumeDest("/srv/x:/app/x/:rw")).toBe("/app/x");
    expect(rwVolumeDest("data:/data:z")).toBe("/data");
    expect(rwVolumeDest("data:/data:ro")).toBeNull();
    expect(rwVolumeDest("data:/data:ro,z")).toBeNull();
    expect(rwVolumeDest("/anonymous")).toBeNull();
  });

  it("parses the opt-in list and ignores malformed entries", () => {
    const set = parseSharedVolumeOptIn(" shop/web:/data,\n other/app:/cache/ bad-entry shop:/x /y ");
    expect([...set].sort()).toEqual(["other/app:/cache", "shop/web:/data"]);
    expect(parseSharedVolumeOptIn(undefined).size).toBe(0);
    expect(parseSharedVolumeOptIn("").size).toBe(0);
  });

  it("keeps the replace path for a shared read/write mount that is not opted in", () => {
    expect(decideCutover(BASE)).toEqual({ mode: "replace", reason: "shared-rw-volume", clashes: ["/data"] });
  });

  it("allows overlap for an opted-in shared mount", () => {
    expect(decideCutover({ ...BASE, sharedOptIn: parseSharedVolumeOptIn("shop/web:/data") })).toEqual({ mode: "overlap" });
  });

  it("scopes the opt-in to the exact project, service and destination", () => {
    for (const entry of ["shop/worker:/data", "other/web:/data", "shop/web:/data/sub"]) {
      expect(decideCutover({ ...BASE, sharedOptIn: parseSharedVolumeOptIn(entry) }).mode).toBe("replace");
    }
  });

  it("still requires every clashing mount to be opted in", () => {
    const opts = {
      ...BASE,
      incumbentRwDests: ["/data", "/cache"],
      volumes: ["data:/data", "cache:/cache"],
      sharedOptIn: parseSharedVolumeOptIn("shop/web:/data"),
    };
    expect(clashingRwDestinations(opts)).toEqual(["/cache"]);
    expect(decideCutover(opts).mode).toBe("replace");
  });

  it("never overlaps on host port bindings, even with the opt-in", () => {
    expect(
      decideCutover({ ...BASE, ports: ["8080:3000"], sharedOptIn: parseSharedVolumeOptIn("shop/web:/data") }),
    ).toEqual({ mode: "replace", reason: "host-ports" });
  });

  it("replaces when there is no running incumbent", () => {
    expect(decideCutover({ ...BASE, incumbentRunning: false })).toEqual({ mode: "replace", reason: "no-incumbent" });
  });

  it("overlaps when nothing is shared", () => {
    expect(decideCutover({ ...BASE, volumes: [], incumbentRwDests: [] })).toEqual({ mode: "overlap" });
  });

  it("carries networks the newcomer lacks, with aliases minus the incumbent identity", () => {
    const carry = networksToCarry({
      incumbentNetworks: {
        "openship-shop": { Aliases: ["web"] },
        shared: { Aliases: ["web-public", "openship-shop-web", "abcdef123456"] },
        extra: { Aliases: null },
        host: {},
      },
      newcomerNetworks: ["openship-shop"],
      incumbentIdentity: ["/openship-shop-web", "abcdef123456789", "abcdef123456"],
    });
    expect(carry).toEqual([
      { network: "shared", aliases: ["web-public"] },
      { network: "extra", aliases: [] },
    ]);
  });

  it("builds a newcomer name that cannot collide with the stable name", () => {
    expect(newcomerName({ deploymentId: "dep_AbC-123", serviceName: "web" })).toBe("openship-cutover-depAbC123-web");
  });
});
