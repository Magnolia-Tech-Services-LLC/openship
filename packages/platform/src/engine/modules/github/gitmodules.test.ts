import { describe, expect, it } from "vitest";
import {
  gitmodulesTextFromContentsBody,
  installationTokenRepositories,
  MAX_SUBMODULE_REPOS,
  parseSameOwnerSubmoduleRepos,
} from "./gitmodules";

const OWNER = "Magnolia-Tech-Services-LLC";

const GRAFT_GITMODULES = `[submodule "lib/auth"]
\tpath = lib/auth
\turl = ../magnolia-auth.git
[submodule "lib/ui"]
\tpath = lib/ui
\turl = https://github.com/Magnolia-Tech-Services-LLC/magnolia-ui.git
[submodule "vendor/other-owner"]
\tpath = vendor/other-owner
\turl = https://github.com/someone-else/lib.git
[submodule "vendor/gitlab"]
\tpath = vendor/gitlab
\turl = https://gitlab.com/Magnolia-Tech-Services-LLC/mirror.git
[submodule "lib/ssh"]
\tpath = lib/ssh
\turl = git@github.com:Magnolia-Tech-Services-LLC/magnolia-ssh.git
`;

describe("parseSameOwnerSubmoduleRepos", () => {
  it("keeps same-owner relative, https and ssh submodules; drops other owners and hosts", () => {
    expect(parseSameOwnerSubmoduleRepos(GRAFT_GITMODULES, OWNER, "graft")).toEqual([
      "magnolia-auth",
      "magnolia-ui",
      "magnolia-ssh",
    ]);
  });

  it("resolves ../ relative URLs against the parent, case-insensitively on owner", () => {
    const text = `[submodule "a"]\n  url = ../magnolia-auth.git\n`;
    expect(parseSameOwnerSubmoduleRepos(text, "magnolia-tech-services-llc", "Canopy")).toEqual([
      "magnolia-auth",
    ]);
  });

  it("ignores ./ (nested path under the parent), the parent itself, and ../../ escapes", () => {
    const text = [
      "url = ./nested.git",
      "url = ../canopy.git",
      "url = ../../evil-owner/x.git",
    ].join("\n");
    expect(parseSameOwnerSubmoduleRepos(text, OWNER, "canopy")).toEqual([]);
  });

  it("de-duplicates and ignores comments and unparseable lines", () => {
    const text = [
      "# url = ../commented.git",
      "; url = ../commented2.git",
      "url = ../magnolia-auth.git",
      "url = https://github.com/Magnolia-Tech-Services-LLC/Magnolia-Auth",
      "url = not a url",
      "url =",
      "url = ssh://git@github.com/Magnolia-Tech-Services-LLC/magnolia-ssh.git",
      "url = https://github.com/Magnolia-Tech-Services-LLC/repo/extra/path.git",
    ].join("\n");
    expect(parseSameOwnerSubmoduleRepos(text, OWNER, "graft")).toEqual(["magnolia-auth", "magnolia-ssh"]);
  });

  it("does not leak credentials or accept userinfo-bearing foreign hosts", () => {
    const text = "url = https://user:pw@evil.example.com/Magnolia-Tech-Services-LLC/x.git";
    expect(parseSameOwnerSubmoduleRepos(text, OWNER, "graft")).toEqual([]);
  });

  it("honours a GitHub Enterprise host for absolute URLs", () => {
    const text = [
      "url = https://ghe.example.com/acme/lib.git",
      "url = https://github.com/acme/public.git",
      "url = ../rel.git",
    ].join("\n");
    expect(parseSameOwnerSubmoduleRepos(text, "acme", "app", "ghe.example.com")).toEqual(["lib", "rel"]);
  });
});

describe("gitmodulesTextFromContentsBody", () => {
  it("decodes the Contents API base64 envelope", () => {
    const raw = "[submodule \"a\"]\n\turl = ../magnolia-auth.git\n";
    const b64 = Buffer.from(raw).toString("base64");
    const body = JSON.stringify({ encoding: "base64", content: b64.match(/.{1,20}/g)!.join("\n") });
    expect(gitmodulesTextFromContentsBody(body)).toBe(raw);
  });

  it("passes raw text through", () => {
    expect(gitmodulesTextFromContentsBody("url = ../x.git")).toBe("url = ../x.git");
  });
});

describe("installationTokenRepositories", () => {
  it("keeps upstream's exact [repo] narrowing when there are no extras", () => {
    expect(installationTokenRepositories("canopy", undefined)).toEqual(["canopy"]);
    expect(installationTokenRepositories("canopy", [])).toEqual(["canopy"]);
    expect(installationTokenRepositories(undefined, undefined)).toBeUndefined();
  });

  it("puts the parent first and de-duplicates case-insensitively", () => {
    expect(installationTokenRepositories("Graft", ["magnolia-auth", "graft", " Magnolia-Auth ", ""])).toEqual([
      "Graft",
      "magnolia-auth",
    ]);
  });

  it("caps the list at parent + MAX_SUBMODULE_REPOS", () => {
    const many = Array.from({ length: 100 }, (_, i) => `r${i}`);
    const out = installationTokenRepositories("parent", many)!;
    expect(out).toHaveLength(MAX_SUBMODULE_REPOS + 1);
    expect(out[0]).toBe("parent");
  });
});
