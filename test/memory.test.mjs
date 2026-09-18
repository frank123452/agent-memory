import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  AgentMemory,
  Bm25Index,
  FileStorage,
  MemoryStorage,
  RecallIndex,
  tokenize,
} from "../dist/index.js";

const tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "agent-memory-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe("tokenizer", () => {
  it("expands CJK runs into character n-grams", () => {
    const tokens = tokenize("我喜欢打游戏");
    assert.ok(tokens.includes("游戏"), `expected 游戏 in ${JSON.stringify(tokens)}`);
    assert.ok(tokens.includes("打游戏"));
  });

  it("keeps latin words and handles mixed script", () => {
    const tokens = tokenize("hello world 你好");
    assert.ok(tokens.includes("hello"));
    assert.ok(tokens.includes("world"));
    assert.ok(tokens.includes("你好"));
  });

  it("drops stop words", () => {
    const tokens = tokenize("the quick brown fox");
    assert.ok(!tokens.includes("the"));
    assert.ok(tokens.includes("quick"));
  });

  it("returns no duplicates", () => {
    const tokens = tokenize("火锅火锅火锅");
    assert.equal(new Set(tokens).size, tokens.length);
  });
});

describe("Bm25Index", () => {
  const docs = [
    { id: "a", text: "user: 我最近在准备考研 assistant: 加油", tokens: tokenize("我最近在准备考研 加油") },
    { id: "b", text: "user: 今天吃了火锅 assistant: 好馋", tokens: tokenize("今天吃了火锅 好馋") },
    { id: "c", text: "user: preparing for an exam assistant: good luck", tokens: tokenize("preparing for an exam good luck") },
  ];

  it("ranks the matching document first", () => {
    const hits = new Bm25Index(docs).search(tokenize("考研"), 3);
    assert.ok(hits.length > 0);
    assert.equal(hits[0].id, "a");
  });

  it("matches latin queries", () => {
    const hits = new Bm25Index(docs).search(tokenize("exam"), 3);
    assert.equal(hits[0].id, "c");
  });

  it("returns nothing for an unrelated query", () => {
    const hits = new Bm25Index(docs).search(tokenize("quantum chromodynamics"), 3);
    assert.equal(hits.length, 0);
  });

  it("handles an empty index", () => {
    assert.deepEqual(new Bm25Index([]).search(tokenize("anything"), 3), []);
  });
});

describe("AgentMemory — long-term entries", () => {
  it("stores and returns entries", async () => {
    const memory = new AgentMemory({ scope: "t1", storage: new MemoryStorage() });
    await memory.remember("User's name is Alex", { pinned: true });
    const entries = await memory.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, "User's name is Alex");
  });

  it("replaces the value of a slot instead of accumulating contradictions", async () => {
    const memory = new AgentMemory({ scope: "t2", storage: new MemoryStorage() });
    await memory.remember("Lives in Berlin", { slot: "location", pinned: true });
    await memory.remember("Lives in Lisbon", { slot: "location", pinned: true });

    assert.equal(await memory.getState("location"), "Lives in Lisbon");
    const entries = await memory.getEntries();
    assert.equal(entries.filter((entry) => entry.slot === "location").length, 1);
  });

  it("de-duplicates near-identical entries", async () => {
    const memory = new AgentMemory({ scope: "t3", storage: new MemoryStorage() });
    await memory.remember("Works as a backend engineer at a fintech");
    await memory.remember("Works as a backend engineer at a fintech");
    const entries = await memory.getEntries();
    assert.equal(entries.length, 1);
  });

  it("forgets by id", async () => {
    const memory = new AgentMemory({ scope: "t4", storage: new MemoryStorage() });
    const entry = await memory.remember("temporary fact");
    assert.equal(await memory.forget(entry.id), true);
    assert.equal((await memory.getEntries()).length, 0);
    assert.equal(await memory.forget("does-not-exist"), false);
  });

  it("exposes slots as a map", async () => {
    const memory = new AgentMemory({ scope: "t5", storage: new MemoryStorage() });
    await memory.setState("location", "Berlin");
    await memory.setState("job", "engineer");
    assert.deepEqual(await memory.getStates(), {
      location: "Berlin",
      job: "engineer",
    });
  });
});

describe("AgentMemory — memory block", () => {
  it("separates pinned facts from ordinary notes", async () => {
    const memory = new AgentMemory({ scope: "t6", storage: new MemoryStorage() });
    await memory.remember("Name is Alex", { pinned: true });
    await memory.remember("Mentioned liking rainy days");

    const block = await memory.formatMemoryBlock();
    assert.match(block, /Always relevant:/);
    assert.match(block, /- Name is Alex/);
    assert.match(block, /Remembered details:/);
    // Notes carry the date they were recorded, so a stale observation is
    // distinguishable from a current one once it reaches the model.
    assert.match(block, /- \[\d{4}-\d{2}-\d{2}\] Mentioned liking rainy days/);
    // Pinned entries assert something currently true and must not be dated.
    assert.doesNotMatch(block, /\[\d{4}-\d{2}-\d{2}\] Name is Alex/);
  });

  it("states the precedence rule between memory sections", async () => {
    const memory = new AgentMemory({ scope: "t9", storage: new MemoryStorage() });
    await memory.remember("Name is Alex", { pinned: true });
    const block = await memory.formatMemoryBlock();
    // Without an explicit ordering the model receives several layers with equal
    // authority and has to guess which wins when they disagree.
    assert.match(block, /Dated notes are observations/);
  });

  it("can omit note timestamps", async () => {
    const memory = new AgentMemory({
      scope: "t10",
      storage: new MemoryStorage(),
      includeEntryTimestamps: false,
    });
    await memory.remember("Mentioned liking rainy days");
    const block = await memory.formatMemoryBlock();
    assert.match(block, /- Mentioned liking rainy days/);
    assert.doesNotMatch(block, /\[\d{4}-\d{2}-\d{2}\]/);
  });

  it("lets the precedence guidance be replaced or removed", async () => {
    const memory = new AgentMemory({
      scope: "t11",
      storage: new MemoryStorage(),
      labels: { factsGuidance: "" },
    });
    await memory.remember("Name is Alex", { pinned: true });
    const block = await memory.formatMemoryBlock();
    assert.doesNotMatch(block, /Dated notes are observations/);
    assert.match(block, /- Name is Alex/);
  });

  it("honours custom labels so the block can be emitted in another language", async () => {
    const memory = new AgentMemory({
      scope: "t7",
      storage: new MemoryStorage(),
      labels: { factsHeader: "你记得这些", pinnedHeader: "重要", notesHeader: "其他" },
    });
    await memory.remember("名字是阿哲", { pinned: true });
    const block = await memory.formatMemoryBlock();
    assert.match(block, /你记得这些/);
    assert.match(block, /- 名字是阿哲/);
  });

  it("returns an empty block when there is nothing to say", async () => {
    const memory = new AgentMemory({ scope: "t8", storage: new MemoryStorage() });
    assert.equal(await memory.formatMemoryBlock(), "");
  });
});

describe("AgentMemory — event rules", () => {
  const rules = [
    {
      type: "sleep",
      match: (message) => /insomnia|can'?t sleep/i.test(message),
      render: (quote) => `Sleep trouble: "${quote}"`,
      mergeWindowDays: 7,
      expireDays: 15,
    },
  ];

  it("records a matching event", async () => {
    const memory = new AgentMemory({
      scope: "e1",
      storage: new MemoryStorage(),
      events: rules,
    });
    const added = await memory.recordEvents("I have had insomnia all week");
    assert.equal(added.length, 1);
    assert.equal((await memory.getEvents()).length, 1);
  });

  it("merges repeated events inside the merge window", async () => {
    const memory = new AgentMemory({
      scope: "e2",
      storage: new MemoryStorage(),
      events: rules,
    });
    await memory.recordEvents("insomnia again");
    await memory.recordEvents("still insomnia");
    assert.equal((await memory.getEvents()).length, 1, "expected merge, not append");
  });

  it("ignores non-matching messages", async () => {
    const memory = new AgentMemory({
      scope: "e3",
      storage: new MemoryStorage(),
      events: rules,
    });
    assert.deepEqual(await memory.recordEvents("the weather is nice"), []);
  });

  it("records events automatically when turns are added", async () => {
    const memory = new AgentMemory({
      scope: "e4",
      storage: new MemoryStorage(),
      events: rules,
    });
    await memory.addTurn({ role: "user", content: "I can't sleep at all" });
    assert.equal((await memory.getEvents()).length, 1);
  });
});

describe("AgentMemory — compression", () => {
  async function seed(memory, turns) {
    const history = [];
    for (let i = 0; i < turns; i++) {
      history.push({ role: "user", content: `question number ${i} about topic ${i}` });
      history.push({ role: "assistant", content: `answer number ${i}` });
    }
    await memory.setMessages(history);
    return history;
  }

  it("leaves short histories untouched", async () => {
    const memory = new AgentMemory({
      scope: "c1",
      storage: new MemoryStorage(),
      shortTermTurns: 12,
    });
    const history = await seed(memory, 3);
    const result = await memory.compress(history, "anything");
    assert.equal(result.archivedTurns, 0);
    assert.equal(result.messages.length, history.length);
  });

  it("archives older turns and keeps the newest verbatim", async () => {
    const memory = new AgentMemory({
      scope: "c2",
      storage: new MemoryStorage(),
      shortTermTurns: 5,
    });
    const history = await seed(memory, 20);
    const result = await memory.compress(history, "topic 3");

    assert.equal(result.archivedTurns, 15);
    const last = result.messages.at(-1);
    assert.equal(last.content, "answer number 19");
    assert.ok((await memory.stats()).rounds > 0, "expected archived rounds");
  });

  it("always tells the model that earlier turns exist", async () => {
    const memory = new AgentMemory({
      scope: "c3",
      storage: new MemoryStorage(),
      shortTermTurns: 3,
    });
    const history = await seed(memory, 20);
    const result = await memory.compress(history, "completely unrelated zebra query");
    const joined = result.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    assert.match(joined, /earlier turns/, "truncation must announce itself");
  });

  it("is idempotent — recompressing does not duplicate the archive", async () => {
    const memory = new AgentMemory({
      scope: "c4",
      storage: new MemoryStorage(),
      shortTermTurns: 3,
    });
    const history = await seed(memory, 10);
    await memory.compress(history, "topic 1");
    const first = (await memory.stats()).rounds;
    await memory.compress(history, "topic 1");
    assert.equal((await memory.stats()).rounds, first);
  });
});

describe("AgentMemory — retrieval", () => {
  it("recalls the archived round that matches the query", async () => {
    const memory = new AgentMemory({
      scope: "r1",
      storage: new MemoryStorage(),
      shortTermTurns: 2,
    });
    const history = [
      { role: "user", content: "我的猫生病了，很担心" },
      { role: "assistant", content: "要不要带它去看兽医" },
      { role: "user", content: "今天天气不错" },
      { role: "assistant", content: "适合出门走走" },
      { role: "user", content: "晚饭吃什么" },
      { role: "assistant", content: "随便点点吧" },
      { role: "user", content: "最近在学吉他" },
      { role: "assistant", content: "加油练习" },
    ];
    await memory.setMessages(history);
    await memory.compress(history, "猫");

    const hits = await memory.retrieve("猫 生病", 3);
    assert.ok(hits.length > 0, "expected a recalled round");
    assert.match(hits[0].text, /猫生病/);
  });
});

describe("AgentMemory — buildContext", () => {
  it("puts the static system prompt first so it stays cacheable", async () => {
    const memory = new AgentMemory({ scope: "b1", storage: new MemoryStorage() });
    await memory.remember("Name is Alex", { pinned: true });
    await memory.addTurn({ role: "user", content: "hello" });

    const context = await memory.buildContext({
      systemPrompt: "You are a helpful assistant.",
      query: "hello",
    });

    assert.equal(context.messages[0].role, "system");
    assert.equal(context.messages[0].content, "You are a helpful assistant.");
    assert.equal(context.messages[1].role, "system");
    assert.match(context.messages[1].content, /- Name is Alex/);
    assert.equal(context.messages.at(-1).content, "hello");
    assert.match(context.memoryBlock, /Name is Alex/);
  });

  it("can skip memory injection", async () => {
    const memory = new AgentMemory({ scope: "b2", storage: new MemoryStorage() });
    await memory.remember("Name is Alex", { pinned: true });
    const context = await memory.buildContext({
      query: "hi",
      systemPrompt: "sys",
      includeMemories: false,
    });
    assert.equal(context.memoryBlock, "");
    assert.equal(context.messages.length, 1);
  });
});

describe("persistence", () => {
  it("survives a new instance sharing the same FileStorage", async () => {
    const dir = await makeTempDir();
    const first = new AgentMemory({ scope: "p1", storage: new FileStorage(dir) });
    await first.remember("Persisted fact", { pinned: true });
    await first.setState("location", "Berlin");
    await first.addTurn({ role: "user", content: "hello" });

    const second = new AgentMemory({ scope: "p1", storage: new FileStorage(dir) });
    const entries = await second.getEntries();
    assert.equal(entries.length, 2);
    assert.equal(await second.getState("location"), "Berlin");
    assert.equal((await second.getMessages()).length, 1);
  });

  it("keeps scopes isolated", async () => {
    const dir = await makeTempDir();
    const storage = new FileStorage(dir);
    const alice = new AgentMemory({ scope: "alice", storage });
    const bob = new AgentMemory({ scope: "bob", storage });

    await alice.remember("Alice fact", { pinned: true });
    await bob.remember("Bob fact", { pinned: true });

    assert.equal((await alice.getEntries())[0].text, "Alice fact");
    assert.equal((await bob.getEntries())[0].text, "Bob fact");
  });

  it("clears a scope", async () => {
    const memory = new AgentMemory({ scope: "p2", storage: new MemoryStorage() });
    await memory.remember("x", { pinned: true });
    await memory.clear();
    assert.equal((await memory.getEntries()).length, 0);
    assert.deepEqual(await memory.stats(), {
      scope: "p2",
      entries: 0,
      pinnedEntries: 0,
      slots: 0,
      rounds: 0,
      shortTermMessages: 0,
      events: 0,
    });
  });

  it("writes atomically, leaving no temporary file behind", async () => {
    const dir = await makeTempDir();
    const memory = new AgentMemory({ scope: "atomic", storage: new FileStorage(dir) });
    await memory.remember("fact", { pinned: true });

    const files = await readdir(dir);
    assert.deepEqual(files, ["agent-memory_atomic.json"]);
  });

  it("overwrites in place rather than appending duplicates", async () => {
    const dir = await makeTempDir();
    const storage = new FileStorage(dir);
    const memory = new AgentMemory({ scope: "twice", storage });
    await memory.remember("first", { pinned: true });
    await memory.remember("second", { pinned: true });

    const reloaded = new AgentMemory({ scope: "twice", storage: new FileStorage(dir) });
    assert.equal((await reloaded.getEntries()).length, 2);
  });

  it("trims the short-term buffer to the configured turn count", async () => {
    const memory = new AgentMemory({
      scope: "p3",
      storage: new MemoryStorage(),
      shortTermTurns: 3,
    });
    for (let i = 0; i < 10; i++) {
      await memory.addTurn({ role: "user", content: `u${i}` });
      await memory.addTurn({ role: "assistant", content: `a${i}` });
    }
    const messages = await memory.getMessages();
    assert.equal(messages.filter((message) => message.role === "user").length, 3);
  });
});

// Regressions found by running examples/basic.mjs end to end. Each one was a
// real defect: retrieval silently returned nothing, the buffer began with an
// orphaned assistant reply, and slot values rendered without their key.
describe("regressions", () => {
  it("archives each round as it arrives, so retrieval is never empty", async () => {
    const memory = new AgentMemory({
      scope: "reg1",
      storage: new MemoryStorage(),
      shortTermTurns: 3,
    });
    for (let i = 0; i < 6; i++) {
      await memory.addTurn({ role: "user", content: `question ${i}` });
      await memory.addTurn({ role: "assistant", content: `answer ${i}` });
    }
    assert.equal((await memory.stats()).rounds, 6);
    const hits = await memory.retrieve("question 1", 3);
    assert.ok(hits.length > 0, "archived rounds must be retrievable");
  });

  it("never leaves an assistant reply whose question was trimmed away", async () => {
    const memory = new AgentMemory({
      scope: "reg2",
      storage: new MemoryStorage(),
      shortTermTurns: 2,
    });
    for (let i = 0; i < 8; i++) {
      await memory.addTurn({ role: "user", content: `u${i}` });
      await memory.addTurn({ role: "assistant", content: `a${i}` });
    }
    const messages = await memory.getMessages();
    assert.equal(messages[0].role, "user", "buffer must start on a user turn");
    assert.equal(messages[0].content, "u6");
    assert.equal(messages.length, 4);
  });

  it("renders a slot with its key so the value is self-describing", async () => {
    const memory = new AgentMemory({ scope: "reg3", storage: new MemoryStorage() });
    await memory.setState("location", "Berlin");
    const block = await memory.formatMemoryBlock();
    assert.match(block, /- location: Berlin/);
  });

  it("injects recalled older rounds into the built context", async () => {
    const memory = new AgentMemory({
      scope: "reg4",
      storage: new MemoryStorage(),
      shortTermTurns: 2,
    });
    await memory.addTurn({ role: "user", content: "我的猫生病了，很担心" });
    await memory.addTurn({ role: "assistant", content: "带它去看兽医吧" });
    for (let i = 0; i < 4; i++) {
      await memory.addTurn({ role: "user", content: `无关话题 ${i}` });
      await memory.addTurn({ role: "assistant", content: `回应 ${i}` });
    }

    const context = await memory.buildContext({
      systemPrompt: "sys",
      query: "猫 生病",
    });

    assert.ok(context.archivedTurns > 0);
    const systemText = context.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    assert.match(systemText, /Earlier in this conversation/);
    assert.match(systemText, /猫生病/);
  });
});

// The primitives are exported as public API, so they need coverage of their
// own. Exported-but-untested code is how a library rots.
describe("RecallIndex", () => {
  it("indexes, reports size and searches", () => {
    const index = new RecallIndex();
    assert.equal(index.size, 0);
    index.add("1", "user: 我想学吉他 assistant: 加油");
    index.add("2", "user: 今天加班到很晚 assistant: 辛苦了");
    assert.equal(index.size, 2);

    const hits = index.search("吉他", 2);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "1");
  });

  it("returns nothing once cleared", () => {
    const index = new RecallIndex();
    index.add("1", "something");
    index.clear();
    assert.equal(index.size, 0);
    assert.deepEqual(index.search("something", 3), []);
  });

  it("drops the oldest documents first when trimmed", () => {
    // Distinct vocabulary per document, so a hit can only come from that
    // document. Sharing a common word like "document" would match everything.
    const index = new RecallIndex();
    for (const word of ["alpha", "bravo", "charlie", "delta", "echo"]) {
      index.add(word, `user: ${word} assistant: noted`);
    }
    index.trim(2);

    assert.equal(index.size, 2);
    assert.equal(index.search("alpha", 5).length, 0, "oldest should be gone");
    assert.equal(index.search("bravo", 5).length, 0, "second oldest should be gone");
    assert.equal(index.search("echo", 5).length, 1, "newest should remain");
  });

  it("is a no-op when already within the limit", () => {
    const index = new RecallIndex();
    index.add("1", "only one");
    index.trim(10);
    assert.equal(index.size, 1);
  });

  it("widens recall using synonyms", () => {
    const index = new RecallIndex({
      synonyms: { layoffs: ["fired", "redundancy"] },
    });
    index.add("1", "user: I got fired today assistant: that is awful");
    const hits = index.search("layoffs", 3);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "1");
  });

  it("supports replacing the synonym map after construction", () => {
    const index = new RecallIndex();
    index.add("1", "user: I got fired assistant: sorry");
    assert.equal(index.search("layoffs", 3).length, 0);
    index.setSynonyms({ layoffs: ["fired"] });
    assert.equal(index.search("layoffs", 3).length, 1);
  });
});

// Persisted state is external input. A truncated or hand-edited document must
// degrade to whatever is still readable rather than throwing on the next render.
describe("robustness", () => {
  function corruptStorage(payload) {
    return {
      async read() {
        return payload;
      },
      async write() {},
    };
  }

  it("drops malformed records but keeps the readable ones", async () => {
    const memory = new AgentMemory({
      scope: "corrupt",
      storage: corruptStorage({
        version: 1,
        entries: [{ nope: true }, { text: "valid fact", createdAt: "2026-01-01T00:00:00.000Z" }],
        events: [{ type: "t", note: "kept", at: "2026-01-01" }, { bad: true }],
        shortTerm: [{ role: "user", content: "hi" }, { content: "   " }],
        archived: [{ id: "r1", text: "user: 我的猫病了\nassistant: 去看兽医" }],
        archivedHashes: ["h1", 99],
      }),
    });

    const entries = await memory.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, "valid fact");

    assert.equal((await memory.getMessages()).length, 1);
    assert.equal((await memory.getEvents()).length, 1);

    const stats = await memory.stats();
    assert.equal(stats.rounds, 1);

    // `userPrefix` was missing from the stored round and must be derived, or
    // compression will not recognise it as older history.
    const hits = await memory.retrieve("猫", 3);
    assert.equal(hits.length, 1);
  });

  it("falls back to empty state when the document is the wrong shape", async () => {
    const memory = new AgentMemory({
      scope: "wrong-shape",
      storage: corruptStorage({ version: 99, entries: "not an array" }),
    });
    assert.deepEqual(await memory.getEntries(), []);
    assert.deepEqual(await memory.stats(), {
      scope: "wrong-shape",
      entries: 0,
      pinnedEntries: 0,
      slots: 0,
      rounds: 0,
      shortTermMessages: 0,
      events: 0,
    });
  });

  it("survives a storage adapter whose writes always fail", async () => {
    const memory = new AgentMemory({
      scope: "failing",
      storage: {
        async read() {
          return null;
        },
        async write() {
          throw new Error("disk full");
        },
      },
    });
    await assert.rejects(() => memory.remember("will not persist"));
    // State is still usable in-process.
    assert.equal((await memory.getEntries()).length, 1);
  });
});
