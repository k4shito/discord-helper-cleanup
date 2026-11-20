import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const retention = 24 * 60 * 60 * 1000;

export class Queue {
  constructor(path, guildId) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, { timeout: 5000 });
    this.guildId = guildId;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cleanup_queue (
        guild_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created INTEGER NOT NULL,
        due INTEGER NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS cleanup_due ON cleanup_queue(guild_id, claimed, due);
    `);
    this.insert = this.database.prepare(`
      INSERT OR IGNORE INTO cleanup_queue
        (guild_id, message_id, channel_id, author_id, fingerprint, created, due)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // A single SQL statement prevents double claims. If the process stops during
    // deletion, the claimed row is retained as a deduplication record.
    this.claim = this.database.prepare(`
      UPDATE cleanup_queue SET claimed = 1 WHERE rowid = (
        SELECT rowid FROM cleanup_queue
        WHERE guild_id = ? AND claimed = 0 AND due <= ? AND created > ?
        ORDER BY due, message_id LIMIT 1
      ) RETURNING message_id AS messageId, channel_id AS channelId,
        author_id AS authorId, fingerprint
    `);
    this.expire = this.database.prepare(
      "DELETE FROM cleanup_queue WHERE created <= ?",
    );
    this.cancelPending = this.database.prepare(`
      UPDATE cleanup_queue SET claimed = 1 WHERE guild_id = ? AND claimed = 0
    `);
  }

  enqueue(message, fingerprint, due) {
    this.insert.run(
      this.guildId,
      message.id,
      message.channelId,
      message.authorId,
      fingerprint,
      message.timestamp,
      due,
    );
  }

  take(now) {
    return this.claim.get(this.guildId, now, now - retention);
  }

  sweep(now) {
    this.expire.run(now - retention);
  }

  cancel() {
    this.cancelPending.run(this.guildId);
  }

  close() {
    this.database.close();
  }
}
