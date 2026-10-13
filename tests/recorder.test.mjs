import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const source = await readFile(
  new URL("../src-tauri/src/recorder.js", import.meta.url),
  "utf8",
);
test("manual recording captures actual form edits, redacts passwords and flushes before stop", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<form id="form" onsubmit="event.preventDefault()"><label>Name<input id="name" name="name"></label><label>Password<input id="pw" type="password"></label><select id="plan" name="type" size="2"><option value="basic">Basic</option><option value="pro">Pro</option></select><button id="save" onclick="document.querySelector(\'#result\').textContent=\'Saved\'">Save</button><div id="result"></div></form>',
    );
    await page.evaluate(() => {
      window.messages = [];
      window.__TAURI_INTERNALS__ = {
        invoke: async (name, { message }) => {
          await new Promise((r) => setTimeout(r, 10));
          window.messages.push(message);
          return { recordingId: null };
        },
      };
    });
    await page.evaluate(source);
    await page.evaluate(() =>
      window.__AUTO_BROWSER_RECORDER__.configure("record-1"),
    );
    await page.locator("#name").fill("Alice");
    await page.locator("#pw").fill("top-secret");
    await page.getByRole("option", { name: "Pro", exact: true }).click();
    await page.locator("#save").click();
    await page.waitForTimeout(180);
    await page.evaluate(() => window.__AUTO_BROWSER_RECORDER__.stop());
    const messages = await page.evaluate(() => window.messages),
      events = messages.filter((m) => m.kind === "record").map((m) => m.event);
    assert.ok(
      events.some(
        (e) =>
          ["input", "change"].includes(e.kind) &&
          e.target.selector === "#name" &&
          e.value === "Alice",
      ),
    );
    assert.ok(
      events.some(
        (e) =>
          e.kind === "change" &&
          e.target.selector === "#plan" &&
          e.value === "pro",
      ),
    );
    assert.ok(
      events.some((e) => e.kind === "click" && e.target.selector === "#save"),
    );
    assert.ok(
      events.some(
        (e) =>
          e.kind === "page_change" && e.afterContext.text.includes("Saved"),
      ),
    );
    assert.ok(
      events.some(
        (e) => e.target?.type === "password" && e.value === "[redacted]",
      ),
    );
    assert.equal(JSON.stringify(messages).includes("top-secret"), false);
    const submit = events.find((e) => e.kind === "submit");
    assert.ok(submit);
    assert.equal(submit.target.type, "");
    assert.equal(submit.target.name, "");
    assert.equal(messages.at(-1).kind, "recording_stopped");
    const count = messages.length;
    await page.locator("#name").fill("After stop");
    assert.equal((await page.evaluate(() => window.messages)).length, count);
  } finally {
    await browser.close();
  }
});
test("recording resumes after document initialization and captures SPA navigation", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.evaluate(() => {
      window.messages = [];
      window.__TAURI_INTERNALS__ = {
        invoke: async (name, { message }) => {
          window.messages.push(message);
          return { recordingId: "continued" };
        },
      };
    });
    await page.evaluate(source);
    await page.waitForFunction(() =>
      window.messages.some((m) => m.kind === "record"),
    );
    await page.evaluate(() => {
      history.pushState({}, "", "#next");
    });
    await page.evaluate(() => window.__AUTO_BROWSER_RECORDER__.stop());
    const events = await page.evaluate(() =>
      window.messages.filter((m) => m.kind === "record").map((m) => m.event),
    );
    assert.equal(events[0].kind, "page_context");
    assert.ok(
      events.some(
        (e) => e.kind === "navigation" && e.pageUrl.endsWith("#next"),
      ),
    );
  } finally {
    await browser.close();
  }
});

test("page readiness survives same-document navigation without starting a recording", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.evaluate(() => {
      window.messages = [];
      window.__TAURI_INTERNALS__ = {
        invoke: async (_name, { message }) => {
          window.messages.push(message);
          return { recordingId: null };
        },
      };
    });
    await page.evaluate(source);
    await page.waitForFunction(() =>
      window.messages.some((message) => message.kind === "page_rendered"),
    );
    await page.evaluate(() => {
      location.hash = "section";
    });
    await page.waitForFunction(() =>
      window.messages.some(
        (message) =>
          message.kind === "page_rendered" && message.url.endsWith("#section"),
      ),
    );
    await page.evaluate(() => {
      history.pushState({}, "", "#next");
    });
    await page.waitForFunction(() =>
      window.messages.some(
        (message) =>
          message.kind === "page_rendered" && message.url.endsWith("#next"),
      ),
    );
    await page.goBack();
    await page.waitForFunction(() => location.hash === "#section");
    await page.waitForFunction(
      () =>
        window.messages.at(-1)?.kind === "page_rendered" &&
        window.messages.at(-1)?.url.endsWith("#section"),
    );
    assert.equal(
      await page.evaluate(() =>
        window.messages.some((message) => message.kind === "record"),
      ),
      false,
    );
  } finally {
    await browser.close();
  }
});
