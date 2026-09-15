import { describe, expect, it } from "vitest";
import { pkgverOf } from "../src/updates";
import { pkgbuildFields } from "../src/requests";
import { parseProjectUrl } from "../src/routes/contributors";

describe("bumps", () => {
  it("turns a release tag into a pkgver", () => {
    expect(pkgverOf("v1.2.3")).toBe("1.2.3");
    expect(pkgverOf("2024-01-05")).toBe("2024.01.05");
    expect(pkgverOf("release/1.0")).toBe("1.0");
    expect(pkgverOf("V3.0-rc1")).toBe("3.0.rc1");
  });
});

describe("package requests", () => {
  it("reads the project's home, the tag and the source from the URL a contributor pastes", () => {
    expect(parseProjectUrl("https://github.com/Owner/Tool.git")).toEqual({ project: "https://github.com/Owner/Tool", github: { owner: "Owner", repo: "Tool" }, tag: null, source: null });
    expect(parseProjectUrl("https://github.com/kyoheiu/felix/archive/refs/tags/v2.16.1.tar.gz")).toEqual({ project: "https://github.com/kyoheiu/felix", github: { owner: "kyoheiu", repo: "felix" }, tag: "v2.16.1", source: "https://github.com/kyoheiu/felix/archive/refs/tags/v2.16.1.tar.gz" });
    expect(parseProjectUrl("https://github.com/eradman/entr/releases/tag/5.8")).toMatchObject({ project: "https://github.com/eradman/entr", tag: "5.8", source: null });
    expect(parseProjectUrl("https://www.spotify.com/download/linux/")).toEqual({ project: "https://www.spotify.com/download/linux", github: null, tag: null, source: null });
    expect(parseProjectUrl("https://github.com/only-owner")).toMatchObject({ error: expect.stringContaining("repository") });
    expect(parseProjectUrl("http://example.org/x")).toMatchObject({ error: "url must be https" });
  });
  it("reads url, pkgdesc and license from a staged PKGBUILD (the backfill's source of truth)", () => {
    expect(pkgbuildFields("pkgname=felix\npkgdesc='tui file manager'\nurl=\"https://github.com/kyoheiu/felix\"\nlicense=('MIT')\n")).toEqual({ url: "https://github.com/kyoheiu/felix", pkgdesc: "tui file manager", license: "MIT" });
    expect(pkgbuildFields("pkgname=x\n")).toEqual({ url: null, pkgdesc: null, license: null });
    expect(pkgbuildFields('pkgdesc="The popular web browser by Google (Stable Channel)"\nurl=https://brave.com/origin/download\nlicense=(\'custom:chrome\')\n')).toEqual({ url: "https://brave.com/origin/download", pkgdesc: "The popular web browser by Google (Stable Channel)", license: "custom:chrome" });
  });
});
