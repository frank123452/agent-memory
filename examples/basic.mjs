/**
 * Runnable demo: `npm run build && node examples/basic.mjs`
 *
 * Simulates a long conversation and shows what the model actually receives.
 * No API key required — this is about context construction, not generation.
 */
import { AgentMemory, MemoryStorage, tokenize } from "../dist/index.js";

const memory = new AgentMemory({
  scope: "demo",
  storage: new MemoryStorage(),
  shortTermTurns: 4,
  events: [
    {
      type: "sleep",
      match: (message) => /insomnia|can'?t sleep/i.test(message),
      render: (quote) => `Sleep trouble: "${quote}"`,
    },
  ],
});

// --- early conversation: the details a user would be upset to repeat --------
await memory.remember("Sister is called Mia", { pinned: true });
await memory.setState("location", "Berlin");
await memory.remember("Allergic to shellfish", { category: "health", pinned: true });

await memory.addTurn({ role: "user", content: "my cat has been sick, I'm worried" });
await memory.addTurn({ role: "assistant", content: "that sounds stressful - has the vet seen her?" });

// --- later: the user moves, then talks about other things for a while -------
await memory.setState("location", "Lisbon");
await memory.remember("Gets insomnia when travelling");

const filler = [
  ["work has been completely overwhelming this sprint", "worth flagging to your manager?"],
  ["I think I'm going to take a few days off", "that sounds like a good call"],
  ["what should I cook tonight", "something simple - pasta?"],
  ["I finished that book finally", "how was the ending?"],
  ["thinking about getting a dog", "a dog would suit you"],
  ["the weather is finally nice here", "about time"],
];

for (const [user, assistant] of filler) {
  await memory.addTurn({ role: "user", content: user });
  await memory.addTurn({ role: "assistant", content: assistant });
}

// --- what the model sees when the cat comes up again ------------------------
const question = "is my cat going to be ok? I can't sleep";
const { messages, memoryBlock, archivedTurns } = await memory.buildContext({
  systemPrompt: "You are a warm, concise assistant.",
  query: question,
});

console.log("=".repeat(72));
console.log("MEMORY BLOCK (injected as a system message)");
console.log("=".repeat(72));
console.log(memoryBlock);

console.log(`\n${"=".repeat(72)}`);
console.log(`MESSAGES SENT TO THE MODEL  (${archivedTurns} earlier turns compressed)`);
console.log("=".repeat(72));
for (const [index, message] of messages.entries()) {
  const preview = message.content.replace(/\n/g, " | ").slice(0, 110);
  console.log(`${index}. [${message.role.padEnd(9)}] ${preview}`);
}

const approximateTokens = messages.reduce(
  (total, message) => total + Math.ceil(message.content.length / 2.5),
  0,
);
console.log(`\nApproximate prompt size: ${approximateTokens} tokens`);

console.log(`\n${"=".repeat(72)}`);
console.log("RETRIEVAL");
console.log("=".repeat(72));
for (const hit of await memory.retrieve(question, 2)) {
  console.log(`score ${hit.score.toFixed(2)}  ${hit.text.replace(/\n/g, " | ")}`);
}

console.log(`\n${"=".repeat(72)}`);
console.log("TOKENIZER (CJK + latin, no dictionary)");
console.log("=".repeat(72));
console.log(tokenize("我的猫生病了 worried about the vet").join(" "));

console.log(`\n${"=".repeat(72)}`);
console.log("STATS");
console.log("=".repeat(72));
console.log(await memory.stats());
