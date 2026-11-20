import { PermissionFlagsBits } from "discord.js";
import { ConfigError } from "./config.js";

const cleanupPermissions = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageMessages,
];

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
