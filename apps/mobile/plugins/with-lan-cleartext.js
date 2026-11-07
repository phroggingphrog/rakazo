// Lets a release build reach a self-hosted server over http:// on the LAN, without permitting
// cleartext to every host: Android denies it by default and allows it only for the hosts a build
// names. JS (lib/endpoint.ts) applies the same rule at runtime.
//
// Name hosts through the plugin props or `extra.lanCleartextHosts`, e.g.
//   ["./plugins/with-lan-cleartext", { hosts: ["192.168.1.20", "nas.local"] }]
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

/** Device loopback and the emulator's alias for the host machine; neither leaves the device. */
const BUILT_IN_HOSTS = ["localhost", "10.0.2.2"];

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function normalizeCleartextHosts(entries) {
  const list = toArray(entries);
  const hosts = new Set(BUILT_IN_HOSTS);
  for (const entry of list) {
    hosts.add(normalizeEntry(entry));
  }
  return [...hosts].sort();
}

function normalizeEntry(entry) {
  if (typeof entry !== "string") throw new Error("Cleartext hosts must be strings.");
  let value = entry.trim();
  if (!value) throw new Error("Cleartext hosts cannot be empty.");

  if (SCHEME.test(value)) value = new URL(value).hostname;
  else if (/^[^:[\]]+:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));

  value = value.toLowerCase().replace(/\.$/, "");
  if (value.startsWith("[") || value.includes(":")) {
    throw new Error(
      `Cleartext host ${entry} is an IPv6 address. Use a hostname or a .local name instead.`,
    );
  }

  if (IPV4.test(value)) {
    if (!isPrivateIpv4(value)) {
      throw new Error(
        `Cleartext host ${entry} is a public address. Public servers need https://, so it cannot be allowed here.`,
      );
    }
    return value;
  }

  if (!HOSTNAME.test(value))
    throw new Error(`Cleartext host ${entry} is not a hostname or address.`);
  if (value !== "localhost" && !value.endsWith(".local")) {
    throw new Error(
      `Cleartext host ${entry} is not on a local network. Use a private address, localhost, or a .local name.`,
    );
  }
  return value;
}

function isPrivateIpv4(value) {
  const octets = IPV4.exec(value).slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b] = octets;
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return a === 100 && b >= 64 && b <= 127;
}

function buildNetworkSecurityConfig(hosts) {
  const domains = hosts
    .map((host) => `    <domain includeSubdomains="false">${escapeXml(host)}</domain>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<network-security-config>",
    '  <base-config cleartextTrafficPermitted="false" />',
    '  <domain-config cleartextTrafficPermitted="true">',
    domains,
    // mDNS names are link-local by definition, so a server addressed as `<name>.local` needs no
    // build-time entry. This is the same rule lib/endpoint.ts applies.
    '    <domain includeSubdomains="true">local</domain>',
    "  </domain-config>",
    "</network-security-config>",
    "",
  ].join("\n");
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function configuredHosts(config, props) {
  return [...toArray(props?.hosts), ...toArray(config?.extra?.lanCleartextHosts)];
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("lanCleartextHosts must be an array of hostnames.");
  return value;
}

module.exports = function withLanCleartext(config, props) {
  const hosts = normalizeCleartextHosts(configuredHosts(config, props));
  const xml = buildNetworkSecurityConfig(hosts);
  const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

  const withManifest = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) {
      app.$["android:networkSecurityConfig"] = "@xml/network_security_config";
      // Ignored on API 24+ while the config above is present; denies cleartext on older devices.
      app.$["android:usesCleartextTraffic"] = "false";
    }
    return cfg;
  });

  return withDangerousMod(withManifest, [
    "android",
    (cfg) => {
      const directory = join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml",
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "network_security_config.xml"), xml);
      return cfg;
    },
  ]);
};

module.exports.buildNetworkSecurityConfig = buildNetworkSecurityConfig;
module.exports.normalizeCleartextHosts = normalizeCleartextHosts;
