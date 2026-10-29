// Child process used by ratelimit.test.ts: fires hits at one shared limit and reports how many got through.
import { RateLimiter } from "../ratelimit.js";

const [file, attempts] = process.argv.slice(2);
const limiter = new RateLimiter(file);
let allowed = 0;
for (let i = 0; i < Number(attempts); i++) {
  if (limiter.hit("test", "shared", 60_000, 20).allowed) allowed++;
}
limiter.close();
console.log(allowed);
