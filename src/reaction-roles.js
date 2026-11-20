import { emojiKey } from "./config.js";

const minute = 60_000;

export class ReactionRoles {
  constructor(database, guildId, posts, discord, log = console) {
    this.guildId = guildId;
    this.posts = posts;
    this.discord = discord;
    this.log = log;
    this.ownRemovals = new Map();
    this.themeIds = new Set(posts.themes?.bindings.values());
    this.roleIds = new Set(this.themeIds);
    if (posts.rules) this.roleIds.add(posts.rules.roleId);

    database.exec(`
      CREATE TABLE IF NOT EXISTS role_reactions (
        guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER, desired INTEGER, source TEXT, revision INTEGER NOT NULL DEFAULT 1,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id, role_id)
      );
      CREATE INDEX IF NOT EXISTS role_reaction_jobs
        ON role_reactions(guild_id, next_at) WHERE desired IS NOT NULL;
    `);
    this.read = database.prepare(`SELECT * FROM role_reactions
      WHERE guild_id=? AND user_id=? AND role_id=?`);
    this.memberSince = database.prepare(`SELECT joined_at FROM role_reactions
      WHERE guild_id=? AND user_id=? AND joined_at IS NOT NULL LIMIT 1`);
    this.enqueue = database.prepare(`
      INSERT INTO role_reactions(guild_id,user_id,role_id,desired,source) VALUES(?,?,?,?,?)
      ON CONFLICT(guild_id,user_id,role_id) DO UPDATE SET desired=excluded.desired,source=excluded.source,
        revision=revision+1,attempts=0,next_at=0 WHERE blocked=0
    `);
    this.block = database.prepare(`
      INSERT INTO role_reactions(guild_id,user_id,role_id,blocked) VALUES(?,?,?,1)
      ON CONFLICT(guild_id,user_id,role_id) DO UPDATE SET blocked=1,desired=NULL,
        revision=revision+1 WHERE blocked=0
    `);
    this.next = database.prepare(`SELECT * FROM role_reactions AS r
      WHERE guild_id=? AND desired IS NOT NULL AND next_at<=? AND NOT EXISTS (
        SELECT 1 FROM role_reactions WHERE guild_id=r.guild_id AND user_id=r.user_id AND role_id=''
      ) ORDER BY next_at,rowid LIMIT 1`);
    this.cancel =
      database.prepare(`UPDATE role_reactions SET desired=NULL,revision=revision+1
      WHERE guild_id=? AND role_id=? AND desired IS NOT NULL`);
    this.record =
      database.prepare(`UPDATE role_reactions SET owned=?,joined_at=?
      WHERE guild_id=? AND user_id=? AND role_id=? AND blocked=0`);
    this.finish = database.prepare(`UPDATE role_reactions SET desired=NULL
      WHERE guild_id=? AND user_id=? AND role_id=? AND revision=?`);
    this.retry =
      database.prepare(`UPDATE role_reactions SET attempts=attempts+1,next_at=?
      WHERE guild_id=? AND user_id=? AND role_id=? AND revision=?`);
  }

  onRaw({ t, d: event }) {
    if (event?.guild_id !== this.guildId) return;
    if (t === "GUILD_MEMBER_REMOVE" || t === "GUILD_BAN_ADD") {
      if (event.user?.id) this.block.run(this.guildId, event.user.id, "");
      return;
    }

    const onPost = (post) =>
      post &&
      event.channel_id === post.channelId &&
      event.message_id === post.messageId;
    const emoji = event.emoji?.id ? "" : emojiKey(event.emoji?.name ?? "");
    const { rules, themes } = this.posts;
    const onThemes = onPost(themes);
    const themeRole = onThemes ? themes.bindings.get(emoji) : undefined;
    if (onThemes && t === "MESSAGE_REACTION_REMOVE_ALL") {
      for (const roleId of this.themeIds) this.cancel.run(this.guildId, roleId);
      return;
    }
    if (themeRole && t === "MESSAGE_REACTION_REMOVE_EMOJI") {
      this.cancel.run(this.guildId, themeRole);
      return;
    }
    const userId = event.user_id;
    if (!userId || userId === this.discord.ownId || event.member?.user?.bot)
      return;
    const added = t === "MESSAGE_REACTION_ADD";
    if (!added && t !== "MESSAGE_REACTION_REMOVE") return;
    const roleId =
      themeRole ??
      (added && emoji === "✅" && onPost(rules) ? rules.roleId : undefined);
    if (!roleId || this.read.get(this.guildId, userId, "")) return;
    this.enqueue.run(
      this.guildId,
      userId,
      roleId,
      Number(added),
      `${event.message_id}:${emoji}`,
    );
  }

  onMemberUpdate(userId, before, after, now = Date.now()) {
    for (const roleId of this.roleIds) {
      if (before.has(roleId) === after.has(roleId)) continue;
      const key = `${userId}:${roleId}`;
      const expected = this.ownRemovals.get(key) ?? 0;
      this.ownRemovals.delete(key);
      if (before.has(roleId) && expected <= now)
        this.block.run(this.guildId, userId, roleId);
    }
  }

  async tick(now) {
    if (!this.discord.ready()) return;
    for (const [key, expires] of this.ownRemovals) {
      if (expires <= now) this.ownRemovals.delete(key);
    }
    const job = this.next.get(this.guildId, now);
    if (!job) return;
    const { user_id: userId, role_id: roleId, revision } = job;
    const args = [this.guildId, userId, roleId];
    const key = `${userId}:${roleId}`;
    try {
      await this.apply(job, now, args, key);
      this.finish.run(...args, revision);
    } catch (error) {
      if (error?.code === 10007) {
        this.block.run(this.guildId, userId, "");
        return;
      }
      if (error?.status >= 400 && error.status < 500)
        this.ownRemovals.delete(key);
      if (job.attempts >= 2 || error?.status === 403) {
        this.finish.run(...args, revision);
        this.log.warn(
          "Роль по реакции не обработана. Проверьте права, пост и положение роли.",
        );
      } else {
        this.retry.run(now + 2000 * 2 ** job.attempts, ...args, revision);
      }
    }
  }

  async apply(job, now, args, key) {
    const { user_id: userId, role_id: roleId } = job;
    const theme = this.themeIds.has(roleId);
    if (!this.roleIds.has(roleId)) return;

    const desired = job.desired === 1;
    if (theme) {
      const post = this.posts.themes;
      const [emoji] = [...post.bindings].find(([, id]) => id === roleId);
      if (job.source !== `${post.messageId}:${emoji}`) return;
      if ((await this.discord.reacted(post, emoji, userId)) !== desired) return;
    } else if (job.source !== `${this.posts.rules.messageId}:✅`) return;
    await this.discord.checkRole(roleId, theme);
    const member = await this.discord.member(userId);
    if (member.bot || member.pending || !this.discord.ready()) return;

    const current = this.read.get(...args);
    if (
      current?.revision !== job.revision ||
      current.blocked ||
      this.read.get(this.guildId, userId, "")
    )
      return;
    const hasRole = member.roles.has(roleId);
    const knownMember = this.memberSince.get(this.guildId, userId);
    if (knownMember && member.joinedAt !== knownMember.joined_at) {
      this.block.run(this.guildId, userId, "");
      return;
    }
    if (current.owned && !hasRole) {
      this.block.run(...args);
      return;
    }
    if (!desired && !current.owned) return;
    if (hasRole === desired) {
      if (desired)
        this.record.run(
          Number(!theme || current.owned),
          member.joinedAt,
          ...args,
        );
      return;
    }

    if (!desired) this.ownRemovals.set(key, now + minute);
    await this.discord.setRole(userId, roleId, desired);
    this.record.run(Number(desired), member.joinedAt, ...args);
  }
}
