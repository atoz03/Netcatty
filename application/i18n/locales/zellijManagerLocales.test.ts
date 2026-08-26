import test from "node:test";
import assert from "node:assert/strict";

import en from "./en.ts";
import ru from "./ru.ts";
import es from "./es.ts";
import zhCN from "./zh-CN.ts";
import zhTW from "./zh-TW.ts";

/**
 * The zellij panel was shipped translated only in en/ru/zh-CN while every other
 * systemManager panel covered all five bundled locales, so Spanish and
 * Traditional Chinese users saw raw English in it. This pins the whole panel,
 * not just the keys added alongside it.
 */
const zellijKeys = [
  "systemManager.errors.loadZellij",
  "systemManager.errors.loadZellijDetails",
  "systemManager.zellij.new",
  "systemManager.zellij.search",
  "systemManager.zellij.empty",
  "systemManager.zellij.unavailable",
  "systemManager.zellij.meta",
  "systemManager.zellij.newSessionTitle",
  "systemManager.zellij.newSessionDesc",
  "systemManager.zellij.newSessionName",
  "systemManager.zellij.newSessionPlaceholder",
  "systemManager.zellij.newSessionRequired",
  "systemManager.zellij.session",
  "systemManager.zellij.current",
  "systemManager.zellij.exited",
  "systemManager.zellij.attach",
  "systemManager.zellij.attachSplit",
  "systemManager.zellij.resurrect",
  "systemManager.zellij.rename",
  "systemManager.zellij.renameSessionPrompt",
  "systemManager.zellij.killSession",
  "systemManager.zellij.deleteSession",
  "systemManager.zellij.confirmKillSession",
  "systemManager.zellij.confirmDeleteSession",
  "systemManager.zellij.tabs",
  "systemManager.zellij.tabList",
  "systemManager.zellij.tabName",
  "systemManager.zellij.newTab",
  "systemManager.zellij.newTabPlaceholder",
  "systemManager.zellij.noTabs",
  "systemManager.zellij.clients",
  "systemManager.zellij.loadingDetails",
] as const;

const locales = { en, ru, es, zhCN, zhTW };

test("zellij manager copy exists in every bundled locale", () => {
  for (const [locale, messages] of Object.entries(locales)) {
    for (const key of zellijKeys) {
      assert.equal(typeof messages[key], "string", `${locale} is missing ${key}`);
      assert.notEqual(messages[key], "", `${locale} has empty ${key}`);
    }
  }
});

test("killing and deleting a zellij session read as different outcomes", () => {
  // The panel's only destructive button used to be labelled "kill" while it ran
  // `delete-session --force`. The two confirms must not be interchangeable copy.
  for (const [locale, messages] of Object.entries(locales)) {
    assert.notEqual(
      messages["systemManager.zellij.killSession"],
      messages["systemManager.zellij.deleteSession"],
      `${locale} labels kill and delete identically`,
    );
    assert.notEqual(
      messages["systemManager.zellij.confirmKillSession"],
      messages["systemManager.zellij.confirmDeleteSession"],
      `${locale} confirms kill and delete identically`,
    );
    for (const key of ["systemManager.zellij.confirmKillSession", "systemManager.zellij.confirmDeleteSession"] as const) {
      assert.match(messages[key], /\{\{name\}\}/, `${locale} ${key} must name the session`);
    }
  }
});
