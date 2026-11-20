import { PermissionFlagsBits, Routes } from "discord.js";
import { ConfigError, emojiKey } from "./config.js";

const cleanupPermissions = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
];
const staffPermissions = Object.entries(PermissionFlagsBits)
  .filter(([name]) =>
    /^(Administrator|Manage|Ban|Kick|Moderate|MentionEveryone|Mute|Deafen|Move|PrioritySpeaker|ViewAuditLog|ViewGuildInsights|Bypass)/.test(
      name,
    ),
  )
  .map(([, flag]) => flag);

export function normalizeMessage(message) {
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    channelName: message.channel.name,
    parentId: message.channel.isThread() ? message.channel.parentId : null,
    parentName: message.channel.isThread()
      ? message.channel.parent?.name
      : null,
    authorId: message.author.id,
    applicationId: message.applicationId,
    bot: message.author.bot,
    webhook: Boolean(message.webhookId),
    pinned: message.pinned,
    content: message.content,
    timestamp: message.createdTimestamp,
    raw: message,
  };
}

export function createRoleAdapter(client, guild) {
  async function fetchPost(post) {
    const channel = await guild.channels.fetch(post.channelId, { force: true });
    if (
      !channel?.isTextBased() ||
      !channel
        .permissionsFor(guild.members.me)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
        ])
    )
      throw new ConfigError(
        "Проверьте канал поста и права бота на его просмотр.",
      );
    return channel.messages.fetch({
      message: post.messageId,
      force: true,
      cache: false,
    });
  }

  async function checkRole(roleId, theme) {
    const [role, channels] = await Promise.all([
      guild.roles.fetch(roleId, { force: true }),
      guild.channels.fetch(),
    ]);
    const unsafeOverwrite = [...channels.values()].some((channel) => {
      const overwrite = channel?.permissionOverwrites?.cache.get(roleId);
      return overwrite && (theme || overwrite.allow.any(staffPermissions));
    });
    if (
      !role ||
      role.id === guild.id ||
      !role.editable ||
      role.permissions.any(staffPermissions) ||
      unsafeOverwrite
    ) {
      throw Object.assign(
        new ConfigError(
          "Проверьте настроенную роль. Она должна быть ниже роли бота и без прав модерации. Для тематических ролей используйте роли без переопределений в каналах.",
        ),
        { status: 403 },
      );
    }
  }

  return {
    get ownId() {
      return client.user.id;
    },
    ready: () => client.isReady() && guild.available,
    async checkPosts({ rules, themes }) {
      try {
        if (rules) {
          await fetchPost(rules);
          await checkRole(rules.roleId, false);
        }
        if (themes) {
          await fetchPost(themes);
          for (const roleId of themes.bindings.values())
            await checkRole(roleId, true);
        }
      } catch (error) {
        if ([10003, 10008, 50001, "GuildChannelUnowned"].includes(error?.code))
          throw new ConfigError(
            "Проверьте ID канала и сообщения поста ролей и доступ бота к ним.",
          );
        throw error;
      }
    },
    checkRole,
    async member(userId) {
      const member = await guild.members.fetch({ user: userId, force: true });
      return {
        bot: member.user.bot,
        pending: member.pending,
        joinedAt: member.joinedTimestamp,
        roles: new Set(member.roles.cache.keys()),
      };
    },
    async reacted(post, emoji, userId) {
      const message = await fetchPost(post);
      const reaction = message.reactions.cache.find(
        (entry) =>
          !entry.emoji.id && emojiKey(entry.emoji.name ?? "") === emoji,
      );
      if (!reaction) return false;
      for (const type of [0, 1]) {
        if (type === 1 && !reaction.countDetails.burst) continue;
        let after;
        for (let page = 0; ; page++) {
          const users = await reaction.users.fetch({ type, limit: 100, after });
          if (users.has(userId)) return true;
          if (users.size < 100) break;
          if (page === 9) throw new Error("REACTION_LIST_INCOMPLETE");
          after = [...users.keys()].reduce((max, id) =>
            BigInt(id) > BigInt(max) ? id : max,
          );
        }
      }
      return false;
    },
    async setRole(userId, roleId, add) {
      const route = Routes.guildMemberRole(guild.id, userId, roleId);
      const options = { reason: "Discord Helper: выбор роли по реакции" };
      if (add) await client.rest.put(route, options);
      else await client.rest.delete(route, options);
    },
  };
}

export async function configuredGuild(client, config) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild?.available) {
    throw new ConfigError(
      "DISCORD_GUILD_ID: сервер недоступен. Проверьте ID и добавьте на сервер этого бота.",
    );
  }

  for (const [key, ids] of [
    ["MUSIC_CHANNEL_IDS", config.excludedChannelIds],
    ["CLEANUP_CHANNEL_IDS", config.cleanupChannelIds],
  ]) {
    for (const id of ids) {
      let channel;
      try {
        channel = await guild.channels.fetch(id);
      } catch (error) {
        if (![10003, 50001, "GuildChannelUnowned"].includes(error.code))
          throw error;
      }
      if (!channel?.isTextBased() && !channel?.isThreadOnly()) {
        throw new ConfigError(
          `${key}: канал ${id} недоступен или не принимает сообщения на этом сервере.`,
        );
      }
    }
  }

  return guild;
}

export function createDiscordAdapter(client, guild) {
  return {
    get ownId() {
      return client.user.id;
    },
    ready: () => client.isReady() && guild.available,
    async fetchMessage(channelId, messageId) {
      const channel = await guild.channels.fetch(channelId, { force: true });
      if (!channel?.isTextBased()) return null;
      const member = guild.members.me;
      if (!member || !channel.permissionsFor(member)?.has(cleanupPermissions)) {
        throw Object.assign(new Error("Missing channel permissions"), {
          status: 403,
        });
      }

      const message = normalizeMessage(
        await channel.messages.fetch({ message: messageId, force: true }),
      );
      if (message.parentId) {
        const parent = await guild.channels.fetch(message.parentId, {
          force: true,
        });
        if (!parent) return null;
        message.parentName = parent.name;
      }
      return message;
    },
    async deleteMessage(message) {
      await message.raw.delete();
    },
  };
}
