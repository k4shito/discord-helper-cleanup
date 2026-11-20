import assert from "node:assert/strict";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Cleanup, matchingFingerprint } from "../src/cleanup.js";
import { readConfig } from "../src/config.js";
import { Queue } from "../src/queue.js";

const env = {
  DISCORD_TOKEN: "fake-test-token",
  DISCORD_GUILD_ID: "111111111111111111",
  MUSIC_CHANNEL_IDS: "222222222222222222",
  MUSIC_BOT_IDS: "333333333333333333",
};
const example = {
  id: "first-message",
  guildId: env.DISCORD_GUILD_ID,
  channelId: "444444444444444444",
  channelName: "general",
  authorId: "555555555555555555",
  content: "M!play example",
  timestamp: 1000,
};

test("validates configured IDs and requires explicit permission to delete", () => {
  const config = readConfig(env);
  assert.equal(config.mode, "preview");
  assert.equal(config.delayMs, 60_000);
  assert.throws(
    () => readConfig({ ...env, MUSIC_CHANNEL_IDS: "" }),
    /MUSIC_CHANNEL_IDS/,
  );
  assert.throws(
    () => readConfig({ ...env, MUSIC_BOT_IDS: "123, " }),
    /MUSIC_BOT_IDS/,
  );
  assert.throws(
    () => readConfig({ ...env, DELETE_DELAY_SECONDS: "NaN" }),
    /DELETE_DELAY_SECONDS/,
  );
});

test("excludes music channels, inherited exceptions, pinned and foreign messages", () => {
  const config = readConfig(env);
  for (const override of [
    { guildId: "other-server" },
    { channelId: env.MUSIC_CHANNEL_IDS, channelName: "renamed" },
    { parentId: env.MUSIC_CHANNEL_IDS },
    { parentName: "🎵・music" },
    { pinned: true },
    { authorId: "helper" },
    { content: "m!player" },
    { content: "hello m!play" },
  ])
    assert.equal(
      matchingFingerprint({ ...example, ...override }, config, "helper"),
      null,
    );
  assert.ok(matchingFingerprint(example, config, "helper"));
});

test("channel allow-list includes threads and excludes other channels", () => {
  const config = readConfig({ ...env, CLEANUP_CHANNEL_IDS: example.channelId });
  assert.ok(matchingFingerprint(example, config, "helper"));
  assert.ok(
    matchingFingerprint(
      { ...example, channelId: "thread", parentId: example.channelId },
      config,
      "helper",
    ),
  );
  assert.equal(
    matchingFingerprint(
      { ...example, channelId: "another-channel" },
      config,
      "helper",
    ),
    null,
  );
});

test("recognizes only selected bots and checks the application ID of webhook replies", () => {
  const config = readConfig(env);
  const botMessage = {
    ...example,
    bot: true,
    webhook: true,
    authorId: env.MUSIC_BOT_IDS,
  };
  assert.equal(matchingFingerprint(botMessage, config, "helper"), null);
  assert.equal(
    matchingFingerprint(
      { ...botMessage, applicationId: env.MUSIC_BOT_IDS },
      config,
      "helper",
    ),
    "bot",
  );
  assert.equal(
    matchingFingerprint({ ...example, bot: true }, config, "helper"),
    null,
  );
});

test("preview reports matches and never enqueues deletions", async () => {
  const config = readConfig(env);
  const queue = new Queue(":memory:", config.guildId);
  const preview = [];
  try {
    const worker = new Cleanup(
      config,
      queue,
      { ownId: "helper" },
      { info: (line) => preview.push(line) },
    );
    worker.onMessage(example);
    await worker.tick(100_000);
    assert.equal(preview.length, 1);
    assert.doesNotMatch(preview[0], /example/);
    assert.equal(queue.take(100_000), undefined);
  } finally {
    queue.close();
  }
});

test("waits one minute, deduplicates events and rechecks edited messages", async () => {
  const config = readConfig({ ...env, CLEANUP_MODE: "delete" });
  const queue = new Queue(":memory:", config.guildId);
  const deleted = [];
  const discord = {
    ownId: "helper",
    ready: () => true,
    fetchMessage: async (_channel, id) => ({
      ...example,
      id,
      content: id === "edited" ? "edited" : example.content,
    }),
    deleteMessage: async (message) => deleted.push(message.id),
  };
  try {
    const cleanup = new Cleanup(config, queue, discord);
    cleanup.onMessage(example);
    cleanup.onMessage(example);
    cleanup.onMessage({ ...example, id: "edited" });
    await cleanup.tick(60_999);
    assert.deepEqual(deleted, []);
    await Promise.all([cleanup.tick(61_000), cleanup.tick(61_000)]);
    await cleanup.tick(62_000);
    assert.deepEqual(deleted, [example.id]);
  } finally {
    queue.close();
  }
});

test("persistent queue survives restart without retrying claimed or expired jobs", () => {
  const directory = mkdtempSync(join(tmpdir(), "discord-helper-"));
  const databasePath = join(directory, "queue.sqlite");
  let queue = new Queue(databasePath, example.guildId);
  try {
    queue.enqueue(example, "bot", 61_000);
    queue.close();
    queue = new Queue(databasePath, example.guildId);
    assert.equal(queue.take(61_000).messageId, example.id);
    queue.close();
    queue = new Queue(databasePath, example.guildId);
    queue.enqueue(example, "bot", 61_000);
    assert.equal(queue.take(61_000), undefined);
    queue.enqueue({ ...example, id: "expired" }, "bot", 61_000);
    const nextDay = 24 * 60 * 60 * 1000 + example.timestamp;
    assert.equal(queue.take(nextDay), undefined);
    queue.enqueue(
      { ...example, id: "cancelled", timestamp: nextDay },
      "bot",
      nextDay,
    );
    queue.cancel();
    assert.equal(queue.take(nextDay), undefined);
  } finally {
    queue.close();
    rmSync(databasePath, { force: true });
    rmdirSync(directory);
  }
});
