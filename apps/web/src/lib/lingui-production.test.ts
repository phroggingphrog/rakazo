import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import macro from "@lingui/babel-plugin-lingui-macro";
import { createCompiledCatalog, getCatalogs } from "@lingui/cli/api";
import { makeConfig } from "@lingui/conf";
import { setupI18n } from "@lingui/core";
import { I18nProvider, Trans } from "@lingui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import linguiConfig from "../../lingui.config";
import { activateUiLocale, i18n as appI18n, setCatalogLoadersForTests } from "./i18n";

vi.mock("./apply-ui-direction", () => ({ applyUiDirection: vi.fn() }));

type Descriptor = { id: string; message: string };
const config = makeConfig({
  ...linguiConfig,
  rootDir: fileURLToPath(new URL("../../", import.meta.url)),
});

async function compiledCatalog(locale: string) {
  const [catalog] = await getCatalogs(config);
  if (!catalog) throw new Error("Missing Lingui catalog");
  const { messages } = await catalog.getTranslations(locale, {
    fallbackLocales: config.fallbackLocales,
    sourceLocale: config.sourceLocale,
  });
  const compiled = createCompiledCatalog(locale, messages, { namespace: "json" });
  expect(compiled.errors).toEqual([]);
  return JSON.parse(compiled.source).messages as Parameters<typeof appI18n.load>[1];
}

function productionDescriptors(file: string): Descriptor[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const transformed = transformSync(source, {
    filename: fileURLToPath(new URL(file, import.meta.url)),
    babelrc: false,
    configFile: false,
    ast: true,
    plugins: [
      [
        macro,
        {
          descriptorFields: "all",
          linguiConfig: config,
        },
      ],
    ],
    parserOpts: { plugins: ["jsx", "typescript"] },
  });
  const descriptors: Descriptor[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
      const fields = new Map<string, string>();
      for (const property of node.properties) {
        const entry = property as {
          key?: { name?: string };
          value?: { type?: string; value?: string };
        };
        if (entry.key?.name && entry.value?.type === "StringLiteral" && entry.value.value)
          fields.set(entry.key.name, entry.value.value);
      }
      const id = fields.get("id");
      const message = fields.get("message");
      if (id && message) descriptors.push({ id, message });
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(transformed?.ast?.program);
  return descriptors;
}

describe("production Lingui fallback", () => {
  it("compiles current setup messages including interpolation and plurals", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const english = await compiledCatalog("en");
      const descriptors = [
        ...productionDescriptors("../pages/shell/email-monitor-setup.tsx"),
        ...productionDescriptors("../pages/shell/message-cards.tsx"),
        ...productionDescriptors("../pages/shell/message-view.tsx"),
      ];
      for (const entry of descriptors) {
        expect(english, `missing compiled English catalog entry: ${entry.message}`).toHaveProperty(
          entry.id,
        );
      }
      const descriptor = (message: string) => {
        const found = descriptors.find((entry) => entry.message === message);
        expect(found, `missing production descriptor for ${message}`).toBeDefined();
        return found!;
      };
      const heading = descriptor("Set up source monitor");
      const state = descriptor("Setup changed; source not verified");
      const assignment = descriptor("Assignment saved");
      const name = descriptor("Assign MCP server “{name}”");
      const plural = descriptor(
        "{count, plural, one {# message with {peer}} other {# messages with {peer}}}",
      );
      const i18n = setupI18n();
      i18n.setMessagesCompiler(undefined as never);
      for (const locale of [
        "en",
        "de",
        "ko",
        "tr",
        "hi",
        "pt-BR",
        "zh-CN",
        "zh-TW",
        "es",
        "ru",
        "fr",
        "he",
        "nl",
        "ja",
      ]) {
        i18n.loadAndActivate({ locale, messages: english });
        expect(i18n._({ id: assignment.id })).toBe("Assignment saved");
        expect(i18n._({ id: state.id })).toBe("Setup changed; source not verified");
        expect(i18n._({ id: name.id, values: { name: "Mail" } })).toBe("Assign MCP server “Mail”");
        expect(i18n._({ id: plural.id, values: { count: 2, peer: "Writer" } })).toBe(
          "2 messages with Writer",
        );
        expect(
          renderToStaticMarkup(
            createElement(I18nProvider, { i18n }, createElement(Trans, { id: heading.id })),
          ),
        ).toContain("Set up source monitor");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses English for missing locale entries while preserving translations", async () => {
    const [english, german] = await Promise.all([compiledCatalog("en"), compiledCatalog("de")]);
    setCatalogLoadersForTests({
      en: async () => ({ messages: english }),
      de: async () => ({ messages: { ...german, translated: ["Übersetzt"] } }),
    } as unknown as Parameters<typeof setCatalogLoadersForTests>[0]);
    try {
      const heading = productionDescriptors("../pages/shell/email-monitor-setup.tsx").find(
        (entry) => entry.message === "Set up source monitor",
      )!;
      expect(await activateUiLocale("de")).toBe("de");
      expect(appI18n._({ id: heading.id })).toBe("Set up source monitor");
      expect(appI18n._({ id: "translated" })).toBe("Übersetzt");
    } finally {
      setCatalogLoadersForTests(null);
    }
  });
});
