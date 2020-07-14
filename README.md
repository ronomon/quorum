# Quorum

> "And though a man might prevail against one who is alone, two will withstand him—a threefold cord is not quickly broken." - Ecclesiastes 4:12

`@ronomon/quorum` calculates the longest quorum of replicas, from a set of replicas operating in relaxed lockstep, by topologically sorting the replicas, and finding the largest
partially ordered subset of agreeing replicas.

## Relaxed lockstep

Unlike many majority systems, `@ronomon/quorum` does not calculate quorum by counting the number of replicas which agree exactly, or which have precisely the same state:

**Strict lockstep** is inadequate even for simple failure scenarios, such as 1 out of 3 replicas offline, leaving 2 replicas online, followed by an interrupted transaction completed on only 1 of the 2 remaining replicas. In this scenario, strict lockstep would think that all replicas have diverged and would fail to find quorum. Yet this scenario is as common as a 3-drive RAID, with one drive down, and a write to the remaining drives interrupted by a power failure.

**Relaxed lockstep**, on the other hand, enables replicas to lag behind the leader of a quorum, by at most one transaction, while still forming part of a quorum.

If you imagine **strict lockstep** as a runner in a three-legged race:

* One leg can fail and be untied and left behind permanently.
* The other two legs can continue to form a quorum.
* However, both legs must now step forward at exactly the same time to avoid losing quorum.

If you imagine **relaxed lockstep** as a runner in a three-legged race:

* One leg can fail and be untied and left behind permanently.
* The other two legs can continue to form a quorum.
* One leg may step ahead of the other, provided it then waits for the other leg to catch up before taking a further step forward.

Relaxed lockstep thus **enables a degraded system to survive a crash without losing quorum**.

### Implementation

The actual implementation of relaxed lockstep **requires only two 128-bit random unique identifiers on each replica**. Together these two `IDs` are referred to as a `VECTOR`:

* The first `ID` reflects the current state (where the leg is at).
* The second `ID` reflects the previous state, on which the current state depends (where the leg was at).

Calculating quorum is then a matter of [topologically sorting](https://en.wikipedia.org/wiki/Topological_sorting) the replicas by [causal order](https://en.wikipedia.org/wiki/Causal_consistency). In other words, the order of steps taken by the replicas, as reflected by the two `IDs` or `VECTOR` of each replica. These `IDs` can be linked together across replicas to form chains of agreeing replicas, or [partially ordered subsets](https://en.wikipedia.org/wiki/Partially_ordered_set), where **the longest chain forms the quorum**.

A key performance insight is that, most of the time, all replicas will agree, or only one or two replicas will lag behind the rest, with no replicas disconnected. This means that **a fast path exists where the topological sort can be avoided**, reducing the complexity of the calculation to a single iteration across the replicas.

[Split-brain](https://en.wikipedia.org/wiki/Split-brain_%28computing%29) is detected in the event of a tie for the longest chain.

Finally, compared with a more complicated solution such as [vector clocks](https://en.wikipedia.org/wiki/Vector_clock), relaxed lockstep can be implemented in **constant space, independent of the number of replicas**.

## Usage

`@ronomon/quorum` maintains the following invariants:

* Each transaction `ID` must be random and unique.
* Similarly, within a `VECTOR`, each `ID` must be unique.
* An `ID` may not consist of only `0` bytes, as a safety precaution against programmer error.
* A `VECTOR` may not consist of duplicate `IDs`, and an `ID` may not be reused across transactions, since this would create cyclic references instead of a [directed acyclic graph](https://en.wikipedia.org/wiki/Directed_acyclic_graph).

### Updating a vector

```javascript
var Crypto = require('crypto');
var Quorum = require('@ronomon/quorum');

// An existing vector:
var vector = Crypto.randomBytes(Quorum.VECTOR);
var vectorOffset = 0;

// Generate a new ID:
var id = Crypto.randomBytes(Quorum.ID);

// Update all replicas which have the same vector:
// Lagging replicas must catch up first before being updated.
Quorum.update(vector, vectorOffset, id);
```

### Calculating quorum

```javascript

var Quorum = require('@ronomon/quorum');

// The number of objects within the source:
var objects = 10;

// Specify the offset into every object at which the VECTOR begins:
var vectorOffset = 0;

// Specify the size of each object within the source:
var objectSize = Quorum.VECTOR;

// Specify the offset into every source at which the first object begins:
var sourceOffset = 0;

// Specify the size, after this offset, of all objects:
var sourceSize = objects * objectSize;

// Specify an array of source buffers, one source for each replica:
var sources = [
  <Buffer>,
  <Buffer>,
  <Buffer>
];

// Allocate a quorum buffer (receives the quorum result for each object):
var quorum = Buffer.alloc(objects * Quorum.SIZE);

// Specify the offset into the quorum buffer at which the first result begins:
var quorumOffset = 0;

// Allocate a target buffer (receives the quorum source for each object):
var target = Buffer.alloc(sourceSize);

// Specify the offset into the target buffer at which the first object begins:
var targetOffset = 0;

Quorum.calculate(
  vectorOffset,
  objectSize,
  sourceOffset,
  sourceSize,
  sources,
  quorum,
  quorumOffset,
  target,
  targetOffset,
  // If a callback is provided, calculate() will execute asynchronously.
  // Otherwise, calculate() will execute synchronously.
  function(error) {
    if (error) throw error;
    for (var index = 0; index < objects; index++) {
      // The offset into the quorum buffer of the quorum result for this object:
      var offset = quorumOffset + (index * Quorum.SIZE);
      console.log(
        'OBJECT=' + index +
        // The index of the replica source which leads the longest quorum:
        ' LEADER=' + quorum[offset + Quorum.LEADER_OFFSET] +
        // The length of the longest quorum (may or may not be a majority):
        ' LENGTH=' + quorum[offset + Quorum.LENGTH_OFFSET] +
        // The number of replicas in the longest quorum which lag the leader:
        ' REPAIR=' + quorum[offset + Quorum.REPAIR_OFFSET] +
        // Whether split-brain was detected (0 or 1):
        // You should ignore the result of the quorum if FORKED=1.
        ' FORKED=' + quorum[offset + Quorum.FORKED_OFFSET]
      );
    }
  }
);

```

## Performance

```

  Intel(R) Xeon(R) CPU E31230 @ 3.20GHz

                NS PER OBJECT

  REPLICAS=1    FAST=15ns    SLOW=15ns
  REPLICAS=2    FAST=17ns    SLOW=18ns
  REPLICAS=4    FAST=38ns    SLOW=199ns
  REPLICAS=8    FAST=85ns    SLOW=444ns
  REPLICAS=16   FAST=161ns   SLOW=1143ns
  REPLICAS=32   FAST=295ns   SLOW=3187ns
  REPLICAS=64   FAST=527ns   SLOW=10572ns
  REPLICAS=128  FAST=1052ns  SLOW=37196ns

```

## Tests

```
node test.js
```

## Benchmark

```
node benchmark.js
```
