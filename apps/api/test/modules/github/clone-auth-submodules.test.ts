import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Magnolia port of the 0.8.0 submodule patch onto v0.9.1 (oblien/openship#979):
 *   - an App installation token is re-minted to cover SAME-OWNER private
 *     submodules listed in .gitmodules (relative ../x.git URLs inherit the
 *     parent's userinfo and otherwise 404);
 *   - the chosen credential source is logged (never the token);
 *   - an empty credential chain for a private repo fails loudly instead of
 *     cloning anonymously into "Repository not found".
 */

const {
  tokenFor,
  requireTokenFor,
  canResolveTokenFor,
  isPublicRepo,
  probeAnonymousRepoVisibility,
  resolveServerGitCredential,
  getLocalGhToken,
  probeServerGitAccess,
  resolveGitHubApiBaseUrl,
} = vi.hoisted(() => ({
  tokenFor: vi.fn(),
  requireTokenFor: vi.fn(),
  canResolveTokenFor: vi.fn(),
  isPublicRepo: vi.fn(),
  probeAnonymousRepoVisibility: vi.fn(),
  resolveServerGitCredential: vi.fn(),
  getLocalGhToken: vi.fn(),
  probeServerGitAccess: vi.fn(),
  resolveGitHubApiBaseUrl: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/github/github.token", () => ({ tokenFor, requireTokenFor, canResolveTokenFor }));
vi.mock("@repo/platform/engine/modules/github/github.http", () => ({ isPublicRepo, probeAnonymousRepoVisibility }));
vi.mock("@repo/platform/engine/modules/github/server-github.service", () => ({ resolveServerGitCredential }));
vi.mock("@repo/platform/engine/modules/github/github-source.service", () => ({ resolveGitHubApiBaseUrl }));
vi.mock("@repo/platform/engine/modules/github/github.local-auth", () => ({
  getLocalGhToken,
  hasLocalGitIdentity: async () => !!(await getLocalGhToken()),
}));
vi.mock("@repo/platform/engine/modules/github/server-git-ambient", () => ({ probeServerGitAccess }));

import { resolveBuildGitToken } from "@repo/platform/engine/modules/github/clone-auth";
import { MAX_SUBMODULE_REPOS } from "@repo/platform/engine/modules/github/gitmodules";

const OWNER = "Magnolia-Tech-Services-LLC";
const PARENT_TOKEN = "ghs_parentPARENTparentPARENT0001";
const WIDE_TOKEN = "ghs_widerWIDERwiderWIDERwider0002";
const ctx = { userId: "owner-user", organizationId: "org1" } as any;
const base = { ctx, projectId: "p1", owner: OWNER, repo: "graft" };

function gitmodulesResponse(text: string, status = 200): Response {
  const body = JSON.stringify({ encoding: "base64", content: Buffer.from(text).toString("base64") });
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn();
let logs: string[];
let consoleLines: string[];

beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  consoleLines = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void consoleLines.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void consoleLines.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void consoleLines.push(a.join(" ")));
  getLocalGhToken.mockResolvedValue(null);
  resolveGitHubApiBaseUrl.mockResolvedValue(null);
  isPublicRepo.mockResolvedValue(false);
  probeAnonymousRepoVisibility.mockResolvedValue("not-found");
  resolveServerGitCredential.mockResolvedValue(null);
  probeServerGitAccess.mockResolvedValue(null);
  canResolveTokenFor.mockResolvedValue(null);
  requireTokenFor.mockRejectedValue(new Error("GITHUB_REMOTE_TOKEN_REQUIRED"));
  tokenFor.mockImplementation(async (_c: unknown, _p: string, tc: { extraRepositories?: string[] }) =>
    tc.extraRepositories?.length
      ? { token: WIDE_TOKEN, source: "app-installation" }
      : { token: PARENT_TOKEN, source: "app-installation" },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const onLog = (m: string) => void logs.push(m);

describe("submodule token expansion", () => {
  it("re-mints the App token to cover same-owner submodules only (api-host / local clone)", async () => {
    fetchMock.mockResolvedValue(
      gitmodulesResponse(
        `[submodule "lib/auth"]\n\tpath = lib/auth\n\turl = ../magnolia-auth.git\n` +
          `[submodule "x"]\n\turl = https://github.com/other-owner/x.git\n` +
          `[submodule "y"]\n\turl = https://gitlab.com/${OWNER}/y.git\n`,
      ),
    );
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "local", onLog, gitRef: "abc123" });
    expect(res).toEqual({ token: WIDE_TOKEN });
    // .gitmodules read with the parent token, at the deployed ref
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${OWNER}/graft/contents/.gitmodules?ref=abc123`);
    expect(init.headers.Authorization).toBe(`Bearer ${PARENT_TOKEN}`);
    // remint: App-only, exactly the same-owner submodule
    const remint = tokenFor.mock.calls.find((c) => c[2].extraRepositories);
    expect(remint![1]).toBe("local");
    expect(remint![2]).toMatchObject({ owner: OWNER, repo: "graft", only: ["app-installation"], extraRepositories: ["magnolia-auth"] });
  });

  it("does the same on the remote (server) chain", async () => {
    fetchMock.mockResolvedValue(gitmodulesResponse(`url = ../magnolia-auth.git\n`));
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "server", onLog });
    expect(res).toEqual({ token: WIDE_TOKEN });
    const remint = tokenFor.mock.calls.find((c) => c[2].extraRepositories);
    expect(remint![1]).toBe("remote");
  });

  it("keeps the parent-only token when there is no .gitmodules (404), without warning", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "local", onLog });
    expect(res).toEqual({ token: PARENT_TOKEN });
    expect(tokenFor).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).not.toMatch(/falling back/);
  });

  it("falls back to the parent token with a warning when reading .gitmodules fails", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "local", onLog });
    expect(res).toEqual({ token: PARENT_TOKEN });
    expect(logs.join("\n")).toMatch(/reading \.gitmodules for .*graft failed .*falling back to a parent-only token/);
  });

  it("falls back with a warning on a non-404 HTTP error", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "local", onLog });
    expect(res).toEqual({ token: PARENT_TOKEN });
    expect(logs.join("\n")).toMatch(/HTTP 500/);
  });

  it("caps the expansion and warns", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `url = ../sub-${i}.git`).join("\n");
    fetchMock.mockResolvedValue(gitmodulesResponse(lines));
    await resolveBuildGitToken({ ...base, buildStrategy: "local", onLog });
    const remint = tokenFor.mock.calls.find((c) => c[2].extraRepositories);
    expect(remint![2].extraRepositories).toHaveLength(MAX_SUBMODULE_REPOS);
    expect(logs.join("\n")).toMatch(/capping token expansion/);
  });

  it("keeps the parent token (with a warning) if the remint returns nothing", async () => {
    fetchMock.mockResolvedValue(gitmodulesResponse(`url = ../magnolia-auth.git\n`));
    tokenFor.mockImplementation(async (_c: unknown, _p: string, tc: { extraRepositories?: string[] }) =>
      tc.extraRepositories?.length ? null : { token: PARENT_TOKEN, source: "app-installation" },
    );
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "local", onLog });
    expect(res).toEqual({ token: PARENT_TOKEN });
    expect(logs.join("\n")).toMatch(/remint .* returned no token/);
  });

  it("never expands a non-App token (PAT / OAuth reach everything already)", async () => {
    tokenFor.mockResolvedValue({ token: "ghp_patPATpatPATpatPATpat0003", source: "project" });
    const res = await resolveBuildGitToken({ ...base, buildStrategy: "server", onLog });
    expect(res).toEqual({ token: "ghp_patPATpatPATpatPATpat0003" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("credential source logging", () => {
  it("logs the chosen source and repo count, never the token", async () => {
    fetchMock.mockResolvedValue(gitmodulesResponse(`url = ../magnolia-auth.git\nurl = ../magnolia-ui.git\n`));
    await resolveBuildGitToken({ ...base, buildStrategy: "local", onLog });
    const line = logs.find((l) => l.startsWith("clone auth:"));
    expect(line).toBe(`clone auth: source=app-installation repos=3 owner=${OWNER} repo=graft strategy=local`);
    const all = [...logs, ...consoleLines].join("\n");
    expect(all).not.toContain(PARENT_TOKEN);
    expect(all).not.toContain(WIDE_TOKEN);
  });

  it("labels PAT and OAuth sources", async () => {
    tokenFor.mockResolvedValue({ token: "t1", source: "user-oauth" });
    await resolveBuildGitToken({ ...base, buildStrategy: "local", onLog });
    expect(logs.find((l) => l.startsWith("clone auth:"))).toMatch(/source=user-oauth repos=all/);
    logs = [];
    tokenFor.mockResolvedValue({ token: "t2", source: "user-pat" });
    await resolveBuildGitToken({ ...base, buildStrategy: "server", onLog });
    expect(logs.find((l) => l.startsWith("clone auth:"))).toMatch(/source=pat-user repos=all/);
  });
});

describe("empty App step (Canopy 'Repository not found')", () => {
  beforeEach(() => {
    tokenFor.mockResolvedValue(null);
  });

  it("fails loudly instead of cloning a private repo anonymously (api-host clone)", async () => {
    await expect(
      resolveBuildGitToken({ ...base, repo: "canopy", buildStrategy: "local", onLog }),
    ).rejects.toThrow(/No GitHub credential resolved for Magnolia-Tech-Services-LLC\/canopy.*not publicly readable/);
    const all = logs.join("\n");
    expect(all).toMatch(/App installation step returned EMPTY .*no installation row/);
    expect(all).toMatch(/clone auth: source=none \(resolution failed/);
  });

  it("explains an installation that exists but minted nothing", async () => {
    canResolveTokenFor.mockResolvedValue("app-installation");
    await expect(
      resolveBuildGitToken({ ...base, repo: "canopy", buildStrategy: "local", onLog }),
    ).rejects.toThrow(/mint returned no token/);
  });

  it("flags a missing actor (org owner lookup failed)", async () => {
    await expect(
      resolveBuildGitToken({ ...base, ctx: { userId: "", organizationId: "org1" } as any, repo: "canopy", buildStrategy: "local", onLog }),
    ).rejects.toThrow(/actor=MISSING/);
  });

  it("also fails loudly on the docker api-host fallback of a server build", async () => {
    await expect(
      resolveBuildGitToken({ ...base, repo: "canopy", buildStrategy: "server", allowApiHostFallback: true, onLog }),
    ).rejects.toThrow(/not publicly readable/);
  });

  it("still clones anonymously when the repo is public", async () => {
    probeAnonymousRepoVisibility.mockResolvedValue("public");
    const res = await resolveBuildGitToken({ ...base, repo: "oss", buildStrategy: "local", onLog });
    expect(res).toEqual({});
    expect(logs.find((l) => l.startsWith("clone auth:"))).toMatch(/source=none \(public repo\) repos=0/);
  });

  it("proceeds (with a warning) when visibility cannot be determined", async () => {
    probeAnonymousRepoVisibility.mockResolvedValue("unknown");
    const res = await resolveBuildGitToken({ ...base, repo: "maybe", buildStrategy: "local", onLog });
    expect(res).toEqual({});
    expect(logs.join("\n")).toMatch(/visibility could not be confirmed; attempting an anonymous clone/);
  });
});
