// Child process used by store.test.ts: hammers one trip with upserts.
import { TripStore } from "../store.js";

const [file, prefix, count] = process.argv.slice(2);
const store = new TripStore(file);
await store.load();
for (let i = 0; i < Number(count); i++) {
  await store.upsertExpense("trip", { id: `${prefix}-${i}`, updatedAt: 1, amount: 1 });
}
store.close();
