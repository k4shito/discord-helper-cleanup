import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { Queue } from "../src/queue.js";
import { ReactionRoles } from "../src/reaction-roles.js";

const env = {
  DISCORD_TOKEN: "fake-test-token",
  DISCORD_GUILD_ID: "111111111111111111",
  MUSIC_CHANNEL_IDS: "222222222222222222",
  RULES_CHANNEL_ID: "333333333333333333",
  RULES_MESSAGE_ID: "444444444444444444",
  ACCESS_ROLE_ID: "555555555555555555",
  THEME_ROLES_CHANNEL_ID: "666666666666666666",
  THEME_ROLES_MESSAGE_ID: "777777777777777777",
  THEME_ROLE_BINDINGS: '{"🎮":"888888888888888888"}',
};
const userId = "999999999999999999";
const theme = "888888888888888888";
const access = env.ACCESS_ROLE_ID;

function fixture(t) {
  const { guildId, rolePosts } = readConfig(env);
  const queue = new Queue(":memory:", guildId);
  t.after(() => queue.close());
  const assigned = new Set();
  const writes = [];
  const member = {
    bot: false,
    pending: false,
    joinedAt: 1_000,
    roles: assigned,
  };
  let reacted = false;
  const discord = {
    ownId: "helper",
    ready: () => true,
    reacted: async () => reacted,
    member: async () => member,
    checkRole: async () => {},
    setRole: async (_userId, roleId, add) => {
      writes.push([roleId, add]);
      if (add) assigned.add(roleId);
      else assigned.delete(roleId);
    },
  };
  let service;
  const restart = (posts = rolePosts) =>
    (service = new ReactionRoles(queue.database, guildId, posts, discord));
  restart();
  return {
    assigned,
    writes,
    member,
    discord,
    restart,
    rolePosts,
    get service() {
      return service;
    },
    event(added, rules = false, override = {}) {
      const post = rules ? rolePosts.rules : rolePosts.themes;
      if (!rules) reacted = added;
      service.onRaw({
        t: added ? "MESSAGE_REACTION_ADD" : "MESSAGE_REACTION_REMOVE",
        d: {
          guild_id: guildId,
          user_id: userId,
          channel_id: post.channelId,
          message_id: post.messageId,
          emoji: { name: rules ? "✅" : "🎮" },
          ...override,
        },
      });
    },
    depart(type, guild = guildId) {
      service.onRaw({ t: type, d: { guild_id: guild, user: { id: userId } } });
    },
    tick: () => service.tick(100_000),
  };
}

test("role posts are optional and role groups require complete, separate configuration", () => {
  assert.deepEqual(
    readConfig({
      DISCORD_TOKEN: env.DISCORD_TOKEN,
      DISCORD_GUILD_ID: env.DISCORD_GUILD_ID,
      MUSIC_CHANNEL_IDS: env.MUSIC_CHANNEL_IDS,
    }).rolePosts,
    { rules: null, themes: null },
  );
  assert.throws(
    () => readConfig({ ...env, RULES_MESSAGE_ID: "" }),
    /RULES_MESSAGE_ID/,
  );
  assert.throws(
    () => readConfig({ ...env, THEME_ROLE_BINDINGS: `{"🎮":"${access}"}` }),
    /THEME_ROLE_BINDINGS/,
  );
  assert.throws(
    () => readConfig({ ...env, THEME_ROLES_MESSAGE_ID: env.RULES_MESSAGE_ID }),
    /разные сообщения/,
  );
});

test("a check mark grants access once and removing it leaves the role in place", async (t) => {
  const f = fixture(t);
  f.event(true, true);
  f.event(false, true);
  await f.tick();
  f.restart();
  f.event(true, true);
  await f.tick();
  assert.deepEqual(f.writes, [[access, true]]);
});

test("theme role follows an individual reaction, including re-add after its own removal", async (t) => {
  const f = fixture(t);
  f.event(true);
  await f.tick();
  f.event(false);
  await f.tick();
  f.service.onMemberUpdate(userId, new Set([theme]), new Set(), 101_000);
  f.event(true);
  await f.tick();
  assert.deepEqual(f.writes, [
    [theme, true],
    [theme, false],
    [theme, true],
  ]);
});

test("a manually assigned theme survives removal of a reaction and bulk cleanup", async (t) => {
  const f = fixture(t);
  f.assigned.add(theme);
  f.event(true);
  await f.tick();
  f.event(false);
  await f.tick();
  f.service.onRaw({
    t: "MESSAGE_REACTION_REMOVE_ALL",
    d: {
      guild_id: env.DISCORD_GUILD_ID,
      channel_id: env.THEME_ROLES_CHANNEL_ID,
      message_id: env.THEME_ROLES_MESSAGE_ID,
    },
  });
  assert.equal(f.assigned.has(theme), true);
  assert.deepEqual(f.writes, []);
});

test("bulk removal cancels even an already queued removal of a bot-assigned theme", async (t) => {
  const f = fixture(t);
  f.event(true);
  await f.tick();
  f.event(false);
  f.service.onRaw({
    t: "MESSAGE_REACTION_REMOVE_ALL",
    d: {
      guild_id: env.DISCORD_GUILD_ID,
      channel_id: env.THEME_ROLES_CHANNEL_ID,
      message_id: env.THEME_ROLES_MESSAGE_ID,
    },
  });
  await f.tick();
  assert.deepEqual(f.writes, [[theme, true]]);
});

test("moderator removal and missing previously granted roles block subsequent reactions", async (t) => {
  const f = fixture(t);
  f.event(true);
  f.event(true, true);
  await f.tick();
  await f.tick();
  f.assigned.clear();
  f.service.onMemberUpdate(userId, new Set([theme]), new Set());
  f.restart();
  f.event(false);
  f.event(true);
  f.event(true, true);
  await f.tick();
  await f.tick();
  assert.deepEqual(f.writes, [
    [theme, true],
    [access, true],
  ]);
  assert.equal(f.assigned.size, 0);
});

for (const type of ["GUILD_MEMBER_REMOVE", "GUILD_BAN_ADD"]) {
  test(`${type} cancels pending work and persists across restarts`, async (t) => {
    const f = fixture(t);
    f.event(true);
    f.event(true, true);
    f.depart(type);
    await f.tick();
    f.restart();
    f.event(true);
    f.event(true, true);
    await f.tick();
    assert.deepEqual(f.writes, []);
  });
}

test("membership changes detected after downtime block further role grants", async (t) => {
  const f = fixture(t);
  f.event(true);
  await f.tick();
  f.restart();
  f.member.joinedAt = 2_000;
  f.assigned.clear();
  f.event(true, true);
  await f.tick();
  assert.deepEqual(f.writes, [[theme, true]]);
});

test("ignores mismatched reaction events and moderations between read and write", async (t) => {
  const f = fixture(t);
  f.event(true, false, { guild_id: "other-guild" });
  f.event(true, false, { message_id: "other-message" });
  await f.tick();
  f.event(true);
  f.discord.member = async () => {
    f.service.onMemberUpdate(userId, new Set([theme]), new Set());
    return f.member;
  };
  await f.tick();
  assert.deepEqual(f.writes, []);
});
