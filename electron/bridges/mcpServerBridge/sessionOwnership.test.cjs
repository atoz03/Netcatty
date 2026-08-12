"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionOwnershipRegistry } = require("./sessionOwnership.cjs");

test("session ownership is isolated by AI scope", () => {
  const ownership = createSessionOwnershipRegistry();
  ownership.register("chat-a", "session-1");

  assert.equal(ownership.validate("chat-a", "session-1").ok, true);
  assert.equal(ownership.validate("chat-b", "session-1").ok, false);
  assert.match(ownership.validate("chat-b", "session-1").error, /not opened/i);
});

test("listOwned returns sessions registered for a chat scope", () => {
  const ownership = createSessionOwnershipRegistry();
  ownership.register("chat-a", "session-1");
  ownership.register("chat-a", "session-2");
  ownership.register("chat-b", "session-3");

  assert.deepEqual(ownership.listOwned("chat-a").sort(), ["session-1", "session-2"]);
  assert.deepEqual(ownership.listOwned("chat-b"), ["session-3"]);
  assert.deepEqual(ownership.listOwned("missing"), []);
  assert.deepEqual(ownership.listOwned(""), []);
});

test("forgetSession revokes ownership from every scope", () => {
  const ownership = createSessionOwnershipRegistry();
  ownership.register("chat-a", "session-1");
  ownership.register("chat-b", "session-1");
  ownership.forgetSession("session-1");

  assert.equal(ownership.validate("chat-a", "session-1").ok, false);
  assert.equal(ownership.validate("chat-b", "session-1").ok, false);
});

test("releaseScopeOwnership clears retained ids without revoking generations", () => {
  const ownership = createSessionOwnershipRegistry();
  const generation = ownership.captureGeneration("chat-a");
  ownership.register("chat-a", "session-1", generation);
  ownership.register("chat-b", "session-2");

  ownership.releaseScopeOwnership("chat-a");

  assert.deepEqual(ownership.listOwned("chat-a"), []);
  assert.equal(ownership.validate("chat-a", "session-1").ok, false);
  assert.equal(ownership.validate("chat-b", "session-2").ok, true);
  // Late host_open for the same generation must still be allowed.
  assert.equal(ownership.register("chat-a", "session-3", generation), true);
  assert.deepEqual(ownership.listOwned("chat-a"), ["session-3"]);
});

test("clearScope only revokes the deleted chat scope", () => {
  const ownership = createSessionOwnershipRegistry();
  ownership.register("chat-a", "session-1");
  ownership.register("chat-b", "session-2");
  ownership.clearScope("chat-a");

  assert.equal(ownership.validate("chat-a", "session-1").ok, false);
  assert.equal(ownership.validate("chat-b", "session-2").ok, true);
});

test("a host open that finishes after scope cleanup cannot restore ownership", () => {
  const ownership = createSessionOwnershipRegistry();
  const generation = ownership.captureGeneration("chat-a");
  ownership.clearScope("chat-a");

  assert.equal(ownership.register("chat-a", "session-1", generation), false);
  assert.equal(ownership.validate("chat-a", "session-1").ok, false);

  const nextGeneration = ownership.captureGeneration("chat-a");
  assert.equal(ownership.register("chat-a", "session-2", nextGeneration), true);
});

test("cleared scope generations are released without allowing a late host open", () => {
  const ownership = createSessionOwnershipRegistry();
  const staleGenerations = [];

  for (let index = 0; index < 100; index += 1) {
    const scopeId = `chat-${index}`;
    staleGenerations.push([scopeId, ownership.captureGeneration(scopeId)]);
    ownership.clearScope(scopeId);
  }

  assert.equal(ownership.getTrackedGenerationCountForTests(), 0);
  for (const [scopeId, generation] of staleGenerations) {
    assert.equal(ownership.register(scopeId, `late-${scopeId}`, generation), false);
  }
});
