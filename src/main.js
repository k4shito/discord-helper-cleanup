import { once } from "node:events";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { Cleanup } from "./cleanup.js";
import { ConfigError, loadLocalEnvironment, readConfig } from "./config.js";
import {
  configuredGuild,
  createDiscordAdapter,
  normalizeMessage,
} from "./discord.js";
import { Queue } from "./queue.js";

async function run(config) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    rest: { retries: 0, timeout: 10_000 },
  });
  const shutdown = new AbortController();
  let queue, timer, inFlight;

  async function stop() {
    if (shutdown.signal.aborted) return;
    shutdown.abort();
    clearInterval(timer);
    await inFlight;
    try {
      await client.destroy();
    } finally {
      queue?.close();
    }
  }

  function handleSignal() {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  }

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  client.on(Events.Error, () =>
    console.warn("Сбой соединения с Discord. Проверьте сеть и журнал запуска."),
  );

  try {
    const ready = once(client, Events.ClientReady, {
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000)]),
    });
    await Promise.all([client.login(config.token), ready]);
    const guild = await configuredGuild(client, config);
    if (shutdown.signal.aborted) return;

    try {
      queue = new Queue(config.databasePath, config.guildId);
      queue.sweep(Date.now());
      if (config.mode === "preview") queue.cancel();
    } catch {
      throw new ConfigError(
        "DATABASE_PATH: проверьте доступ на запись и пригодность файла SQLite.",
      );
    }

    const cleanup = new Cleanup(
      config,
      queue,
      createDiscordAdapter(client, guild),
    );
    client.on(Events.MessageCreate, (message) => {
      if (shutdown.signal.aborted || message.guildId !== config.guildId) return;
      try {
        cleanup.onMessage(normalizeMessage(message));
      } catch {
        console.warn("Не удалось записать задание. Проверьте доступ к SQLite.");
      }
    });

    if (config.mode === "delete") {
      let nextSweep = Date.now() + 60 * 60 * 1000;
      timer = setInterval(() => {
        if (inFlight) return;
        const now = Date.now();
        inFlight = Promise.resolve()
          .then(async () => {
            if (now >= nextSweep) {
              queue.sweep(now);
              nextSweep = now + 60 * 60 * 1000;
            }
            await cleanup.tick(now);
          })
          .catch(() => {
            console.warn(
              "Не удалось обработать очередь. Проверьте доступ к SQLite.",
            );
          })
          .finally(() => {
            inFlight = undefined;
          });
      }, 400);
    }

    console.info(
      `Discord Helper подключён. Режим: ${config.mode}. Задержка: ${config.delayMs / 1000} с.`,
    );
  } catch (error) {
    if (shutdown.signal.aborted) return;
    await stop();
    throw error;
  }
}

try {
  loadLocalEnvironment();
  const config = readConfig();
  if (process.argv.includes("--check")) {
    console.info(
      `Формат настроек проверен. Режим: ${config.mode}. Подключение к Discord не выполнялось.`,
    );
  } else {
    await run(config);
  }
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exitCode = 78;
  } else if (error.code === "TokenInvalid" || error.status === 401) {
    console.error(
      "DISCORD_TOKEN: Discord отклонил токен бота. Проверьте токен в Discord Developer Portal.",
    );
    process.exitCode = 78;
  } else if (
    error.message === "Used disallowed intents" ||
    error.code === 4014
  ) {
    console.error(
      "Включите Message Content Intent в разделе Bot в Discord Developer Portal.",
    );
    process.exitCode = 78;
  } else {
    console.error(
      "Не удалось запустить бот. Проверьте соединение с Discord и состояние сервера.",
    );
    process.exitCode = 1;
  }
}
