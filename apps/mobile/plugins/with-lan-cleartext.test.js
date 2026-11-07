import { describe, expect, it } from "vitest";
import plugin from "./with-lan-cleartext.js";

const { buildNetworkSecurityConfig, normalizeCleartextHosts } = plugin;

describe("with-lan-cleartext", () => {
  it("denies cleartext to everything except the hosts a build names", () => {
    const hosts = normalizeCleartextHosts(["192.168.1.20", "nas.local"]);
    const xml = buildNetworkSecurityConfig(hosts);
    expect(hosts).toEqual(["10.0.2.2", "192.168.1.20", "localhost", "nas.local"]);
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false" />');
    for (const host of hosts) {
      expect(xml).toContain(`<domain includeSubdomains="false">${host}</domain>`);
    }
    expect(xml.match(/cleartextTrafficPermitted="true"/g)).toHaveLength(1);
  });

  it("allows only device loopback when no hosts are configured", () => {
    expect(normalizeCleartextHosts([])).toEqual(["10.0.2.2", "localhost"]);
  });

  it("accepts a full URL or host:port and keeps just the host", () => {
    expect(normalizeCleartextHosts(["http://192.168.1.20:3100"])).toContain("192.168.1.20");
    expect(normalizeCleartextHosts(["NAS.Local:3100"])).toContain("nas.local");
  });

  it("refuses a public host, since a cleartext build must not reach one", () => {
    expect(() => normalizeCleartextHosts(["example.com"])).toThrow(/not on a local network/);
    expect(() => normalizeCleartextHosts(["8.8.8.8"])).toThrow(/public address/);
  });

  it("refuses IPv6 literals rather than emitting a rule Android may not match", () => {
    expect(() => normalizeCleartextHosts(["[fd00::1]"])).toThrow(/IPv6/);
  });

  it("refuses a non-array host list", () => {
    expect(() => normalizeCleartextHosts("192.168.1.20")).toThrow(/must be an array/);
  });
});
