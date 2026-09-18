import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StorageAdapter } from "./types.js";

/**
 * Default adapter. Keeps everything in process memory, which is fine for tests
 * and for short-lived sessions, but loses state on restart.
 */
export class MemoryStorage implements StorageAdapter {
  private readonly map = new Map<string, unknown>();

  async read<T>(key: string): Promise<T | null> {
    const value = this.map.get(key);
    return value === undefined ? null : (structuredClone(value) as T);
  }

  async write<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
}

/**
 * JSON-file adapter, one file per key. Good enough for thousands of users on a
 * single box; swap in a real database adapter when you outgrow it.
 *
 * Two properties it guarantees, both of which matter more here than speed:
 *
 * 1. Writes are serialized per key, so concurrent calls cannot interleave and
 *    truncate each other.
 * 2. Writes are atomic. The payload goes to a temporary file which is renamed
 *    over the target, so a crash or a full disk mid-write leaves the previous
 *    good document in place rather than a half-written one that fails to parse
 *    on the next boot.
 */
export class FileStorage implements StorageAdapter {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = root;
  }

  private pathFor(key: string): string {
    return join(this.root, `${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  }

  async read<T>(key: string): Promise<T | null> {
    try {
      const raw = await readFile(this.pathFor(key), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async write<T>(key: string, value: T): Promise<void> {
    const path = this.pathFor(key);
    const body = async (): Promise<void> => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(temporary, path);
    };
    // The rejected branch is handled so one failed write does not poison every
    // subsequent write for this key.
    const next = (this.locks.get(key) ?? Promise.resolve()).then(body, body);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    await next;
  }
}
