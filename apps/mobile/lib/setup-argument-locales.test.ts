import { afterEach, expect, it } from "vitest";
import { resetI18nForTests, t } from "./i18n";
import { UI_LOCALES } from "./ui-locale";

afterEach(() => resetI18nForTests("en"));

it("translates the guided field placeholder in every mobile locale", () => {
  for (const locale of UI_LOCALES) {
    resetI18nForTests(locale);
    const label = t("Not set");
    expect(label.trim()).toBeTruthy();
    if (locale === "en") expect(label).toBe("Not set");
    else expect(label, locale).not.toBe("Not set");
  }
});
