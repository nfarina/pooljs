# Pool.js

Pool.js makes it easy to execute async tasks in parallel, with optional concurrency and/or rate limits for rate-limited APIs.

It's a lightweight, one-file solution with zero dependencies and works in both Node.js and the browser.

For more on why I wrote this, see [the blog post](https://medium.com/@nfarina/pool-js-your-new-concurrency-friend-1d0c8e545c90).

## Installation

```bash
npm install async-pool-js
```

## Usage

Pool.js works best with [async iterables](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for-await...of). Here's an example of using it with the Stripe API (uses my [helper function](https://gist.github.com/nfarina/076061118de5c343ccbc08bf8a1c5ce8) for getting async iterators from Stripe Lists).

```js
import { iterateWithPool } from "async-pool-js";
import { iterateList } from "./stripeiterators";

// This creates an async iterable that will iterate over all
// balance transactions in your Stripe account.
const balanceTransactions = iterateList((starting_after, limit) =>
  stripe.balanceTransactions.list({ starting_after, limit }),
);

// Here's the user-defined async task that will be called
// for each balance transaction.
async function processTransaction(transaction) {
  if (transaction.type === "payment") {
    const chargeId = transaction.source;
    const payment = await stripe.charges.retrieve(chargeId);
    console.log(payment.amount);
    // Do stuff
  }
}

// Kicks off the pool with 100 concurrent tasks and a
// rate limit of 100 tasks per second.
await iterateWithPool(
  balanceTransactions,
  { rate: 100, concurrency: 100 },
  processTransaction,
);
```

You can give Pool.js a maximum number of concurrent tasks, and/or a strict rate limit. The rate limit is implemented using a [token-bucket-like](https://en.wikipedia.org/wiki/Token_bucket) algorithm which matches what Stripe (any many other API rate limiters) uses internally.

In your task method, you can return false if you want to cancel execution entirely:

```js
async function processTransaction(transaction) {
  if (transaction.type !== "payment") {
    console.log("Unexpected transaction type!");
    return false; // Cancels execution without throwing an error!
  }
}
```

If any of your tasks throws an error, it will be captured and bubbled up to the caller of `iterateWithPool()` only after waiting for any pending tasks to complete.

## AsyncPool Class

If you can't use async iterators, or if you want more fine-grained control, you can use the `AsyncPool` class directly:

```js
import { AsyncPool } from "async-pool-js";

const pool = new AsyncPool(options);

// Example loop that adds tasks to the pool.
for (const item of items) {
  // Check if the pool has been canceled by a task.
  if (pool.stopped) break;

  // Add a task to the pool and wait until it's safe to add another.
  // This method may also throw an Error if one if the tasks threw one.
  await pool.add(async () => {
    // Call some user function to do some work. Pass along the pool instance
    // so the worker task can cancel() it if desired.
    await doSomeWork(pool, item);
  });
}

// We must wait for the pool to finish no matter what.
// This method may also throw an Error if one if the tasks threw one.
await pool.finish();
```