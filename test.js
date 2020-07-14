var Assert = require('assert');
var Crypto = require('crypto');
var Queue = require('@ronomon/queue');
var Quorum = require('./index.js');

var Random = Math.random.bind(Math);

var RandomBuffer = (function() {
  var key = Crypto.randomBytes(32);
  var iv = Crypto.randomBytes(16);
  var cipher = Crypto.createCipheriv('AES-256-CTR', key, iv);
  var buffer = Buffer.alloc(1024 * 1024);
  return function(size) {
    Assert(Number.isInteger(size));
    if (size > buffer.length) return cipher.update(Buffer.alloc(size));
    return cipher.update(buffer.slice(0, size));
  };
})();

var Generate = {};

Generate.args = function() {
  var self = this;
  var args = {};
  args.objects = self.choose(1, 32);
  args.objectSize = self.choose(Quorum.VECTOR, 256);
  args.vectorOffset = self.choose(0, args.objectSize - Quorum.VECTOR);
  args.sourceOffset = self.choose(0, 512);
  args.sourceSize = args.objects * args.objectSize;
  args.sourcesLength = self.choose(Quorum.SOURCES_MIN, Quorum.SOURCES_MAX);
  args.sources = self.sources(
    args.vectorOffset,
    args.objectSize,
    args.sourceOffset,
    args.sourceSize,
    args.sourcesLength
  );
  args.hashes = args.sources.map(
    function(source) {
      return Hash(source);
    }
  );
  args.quorumOffset = self.choose(0, 512);
  args.quorumSize = args.objects * Quorum.SIZE;
  args.quorum = RandomBuffer(
    args.quorumOffset + args.quorumSize + self.choose(0, 512)
  );
  args.quorumReference = Buffer.from(args.quorum);
  args.quorumPrefix = Hash(args.quorum.slice(0, args.quorumOffset));
  args.quorumSuffix = Hash(
    args.quorum.slice(args.quorumOffset + args.quorumSize)
  );
  args.targetOffset = self.choose(0, 512);
  args.target = RandomBuffer(
    args.targetOffset + args.sourceSize + self.choose(0, 512)
  );
  args.targetReference = Buffer.from(args.target);
  args.targetPrefix = Hash(args.target.slice(0, args.targetOffset));
  args.targetSuffix = Hash(
    args.target.slice(args.targetOffset + args.sourceSize)
  );
  return args;
};

Generate.argsOverride = function(override) {
  var self = this;
  var args = [
    0,
    Quorum.VECTOR,
    0,
    Quorum.VECTOR,
    Generate.vectors([[1, 2]]),
    Buffer.alloc(Quorum.SIZE),
    0,
    Buffer.alloc(Quorum.VECTOR),
    0
  ];
  if (override.vectorOffset !== undefined) args[0] = override.vectorOffset;
  if (override.objectSize !== undefined) args[1] = override.objectSize;
  if (override.sourceOffset !== undefined) args[2] = override.sourceOffset;
  if (override.sourceSize !== undefined) args[3] = override.sourceSize;
  if (override.sources !== undefined) args[4] = override.sources;
  if (override.quorum !== undefined) args[5] = override.quorum;
  if (override.quorumOffset !== undefined) args[6] = override.quorumOffset;
  if (override.target !== undefined) args[7] = override.target;
  if (override.targetOffset !== undefined) args[8] = override.targetOffset;
  if (override.callback !== undefined) args[9] = override.callback;
  return args;
};

Generate.sources = function(
  vectorOffset,
  objectSize,
  sourceOffset,
  sourceSize,
  sourcesLength
) {
  var self = this;
  Assert(Number.isInteger(vectorOffset));
  Assert(Number.isInteger(objectSize));
  Assert(Number.isInteger(sourceOffset));
  Assert(Number.isInteger(sourceSize));
  Assert(Number.isInteger(sourcesLength));
  Assert(sourceSize % objectSize === 0);
  var sources = [];
  var entropy = RandomBuffer(sourceOffset + sourceSize + self.choose(0, 512));
  for (var index = 0; index < sourcesLength; index++) {
    var copy = Buffer.from(entropy);
    copy.INDEX = index;
    sources.push(copy);
  }
  var objects = sourceSize / objectSize;
  Assert(Number.isInteger(objects));
  for (var index = 0; index < objects; index++) {
    self.evolve(
      sources,
      sourceOffset + (index * objectSize) + vectorOffset,
      sources.length
    );
  }
  sources.sort(
    function(a, b) {
      if (a.INDEX < b.INDEX) return -1;
      if (b.INDEX < a.INDEX) return 1;
      return 0;
    }
  );
  return sources;
};

Generate.choose = function(min, max) {
  var self = this;
  Assert(Number.isInteger(min));
  Assert(Number.isInteger(max));
  Assert(min >= 0);
  Assert(max >= 0);
  Assert(max >= min);
  if (Random() < 0.1) return (Random() < 0.7 ? min : max);
  if (Random() < 0.6) {
    var choice = min + Math.round(Random() * (max - min) / 4);
  } else {
    var choice = min + Math.round(Random() * (max - min));
  }
  Assert(choice >= min);
  Assert(choice <= max);
  return choice;
};

Generate.evolve = function(vectors, offset, vectorsLength) {
  var self = this;
  Assert(offset >= 0);
  if (vectors.length === 0) return;
  if (vectorsLength === vectors.length) {
    if (Random() < 0.5) {
      // Evolve all vectors if overlap is not needed.
      self.update(vectors, offset);
      self.evolve(vectors, offset, vectors.length - 1);
      return;
    }
  } else if (Random() < 0.1) {
    // Avoid too much recursion if the chain has evolved at least once.
    return;
  }
  var excluded = [];
  var included = self.subset(vectors, vectorsLength, excluded);
  if (included.length) {
    self.update(included, offset);
    self.evolve(included, offset, included.length - 1);
  }
  if (excluded.length) {
    self.evolve(excluded, offset, excluded.length);
  }
};

Generate.shuffle = function(array) {
  var self = this;
  for (var i = array.length - 1; i > 0; i--) {
    var j = Math.floor(Random() * (i + 1));
    var temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
};

Generate.subset = function(vectors, vectorsLength, excluded) {
  var self = this;
  self.shuffle(vectors);
  var subset = Math.round(Random() * vectorsLength);
  var included = [];
  for (var index = 0, length = vectorsLength; index < length; index++) {
    if (included.length < subset) {
      included.push(vectors[index]);
    } else {
      excluded.push(vectors[index]);
    }
  }
  return included;
};

Generate.update = function(vectors, offset) {
  var self = this;
  Assert(offset + Quorum.VECTOR <= vectors[0].length);
  var id = RandomBuffer(Quorum.ID);
  for (var index = 0, length = vectors.length; index < length; index++) {
    var vector = vectors[index];
    // Copy ID 0 to ID 1 and update ID 0:
    vector.copy(vector, offset + Quorum.ID, offset, offset + Quorum.ID);
    id.copy(vector, offset, 0, Quorum.ID);
  }
};

Generate.vectors = function(vectors) {
  var sources = [];
  vectors.forEach(
    function(vector, index) {
      var source = Buffer.concat([
        Buffer.alloc(Quorum.ID, vector[0]),
        Buffer.alloc(Quorum.ID, vector[1])
      ]);
      source.ID = index;
      sources.push(source);
    }
  );
  return sources;
};

var Hash = function(buffer) {
  return Crypto.createHash('SHA256').update(buffer).digest('hex').slice(0, 32);
};

var Inspect = {};

Inspect.pad = function(integer, width) {
  Assert(Number.isInteger(integer));
  Assert(Number.isInteger(width));
  return integer.toString().padStart(width, '0');
};

Inspect.quorum = function(quorum, offset) {
  var self = this;
  if (offset + Quorum.SIZE > quorum.length) throw new Error('bad offset');
  return [
    'LEADER=' + self.pad(quorum[offset + Quorum.LEADER_OFFSET], 3),
    'LENGTH=' + self.pad(quorum[offset + Quorum.LENGTH_OFFSET], 3),
    'REPAIR=' + self.pad(quorum[offset + Quorum.REPAIR_OFFSET], 3),
    'FORKED=' + self.pad(quorum[offset + Quorum.FORKED_OFFSET], 1)
  ].join(' ');
};

Inspect.vectors = function(vectors, offset) {
  var self = this;
  Assert(offset + Quorum.VECTOR <= vectors[0].length);
  var lines = [];
  for (var index = 0, length = vectors.length; index < length; index++) {
    var vector = vectors[index];
    var a = vector.toString('hex', offset, offset + Quorum.ID);
    var b = vector.toString('hex', offset + Quorum.ID, offset + Quorum.VECTOR);
    lines.push(self.pad(vector.INDEX, 3) + ' ' + a + ' ' + b);
  }
  return lines.join('\n');
};

var Reference = {};

Reference.calculate = function(args) {
  var self = this;
  for (var index = 0; index < args.objects; index++) {
    var objectOffset = index * args.objectSize;
    var quorumOffset = args.quorumOffset + (index * 4);
    self.calculateObject(
      args.sources,
      args.sourceOffset + objectOffset + args.vectorOffset,
      args.quorumReference,
      quorumOffset
    );
    if (args.quorumReference[quorumOffset + 1] > 0) {
      args.sources[args.quorumReference[quorumOffset + 0]].copy(
        args.targetReference,
        args.targetOffset + objectOffset,
        args.sourceOffset + objectOffset,
        args.sourceOffset + objectOffset + args.objectSize
      );
    } else {
      args.targetReference.fill(
        0,
        args.targetOffset + objectOffset,
        args.targetOffset + objectOffset + args.objectSize
      );
    }
  }
};

Reference.calculateObject = function(vectors, offset, quorum, quorumOffset) {
  var self = this;
  var map = {};
  var hash = {};
  var nodes = [];
  var dependencies = {};
  for (var index = 0, length = vectors.length; index < length; index++) {
    var vector = vectors[index];
    var a = vector.toString('hex', offset, offset + 16);
    var b = vector.toString('hex', offset + 16, offset + 32);
    if (!map.hasOwnProperty(a)) {
      var node = new Array(2);
      node[0] = 0;
      node[1] = a;
      map[a] = node;
      nodes.push(node);
    }
    if (!map.hasOwnProperty(b)) {
      var node = new Array(2);
      node[0] = 0;
      node[1] = b;
      map[b] = node;
      nodes.push(node);
    }
    if (!hash.hasOwnProperty(a)) hash[a] = [];
    hash[a].push(vector);
    if (a !== b) dependencies[a] = b;
  }
  var list = [];
  while (nodes.length) {
    var node = nodes.shift();
    if (node[0] > 0) continue;
    visit(node);
  }
  function visit(node) {
    if (node[0] === 2) return;
    if (node[0] === 1) throw new Error('graph is not a directed acyclic graph');
    node[0]++;
    if (dependencies.hasOwnProperty(node[1])) {
      visit(map[dependencies[node[1]]]);
    }
    node[0]++;
    list.unshift(node[1]);
  }
  function trace(id) {
    var vectors = [];
    while (dependencies.hasOwnProperty(id)) {
      vectors.push(...hash[id]);
      id = dependencies[id];
      seen[id] = true;
    }
    return vectors;
  }
  var seen = {};
  var chains = [];
  for (var index = 0, length = list.length; index < length; index++) {
    var id = list[index];
    if (seen.hasOwnProperty(id)) continue;
    var chain = trace(id);
    if (chain.length > 0) chains.push(chain);
  }
  chains.sort(
    function(a, b) {
      if (a.length > b.length) return -1;
      if (b.length > a.length) return 1;
      return 0;
    }
  );
  if (chains.length === 0) {
    quorum[quorumOffset + 0] = 0;
    quorum[quorumOffset + 1] = 0;
    quorum[quorumOffset + 2] = 0;
    quorum[quorumOffset + 3] = 0;
  } else if (chains.length > 1 && chains[0].length === chains[1].length) {
    quorum[quorumOffset + 0] = 0;
    quorum[quorumOffset + 1] = 0;
    quorum[quorumOffset + 2] = 0;
    quorum[quorumOffset + 3] = 1;
  } else {
    quorum[quorumOffset + 0] = vectors.indexOf(chains[0][0]);
    quorum[quorumOffset + 1] = chains[0].length;
    quorum[quorumOffset + 2] = 0;
    var a = chains[0][0].toString('hex', offset, offset + 16);
    chains[0].forEach(
      function(vector, index) {
        if (index === 0) return;
        var b = vector.toString('hex', offset, offset + 16);
        if (b === a) return;
        quorum[quorumOffset + 2]++;
      }
    );
    quorum[quorumOffset + 3] = 0;
  }
};

// Test constants and methods:
Assert(Number.isInteger(Quorum.SOURCES_MIN));
Assert(Number.isInteger(Quorum.SOURCES_MAX));
Assert(Number.isInteger(Quorum.ID));
Assert(Number.isInteger(Quorum.VECTOR));
Assert(Number.isInteger(Quorum.LEADER_OFFSET));
Assert(Number.isInteger(Quorum.LENGTH_OFFSET));
Assert(Number.isInteger(Quorum.REPAIR_OFFSET));
Assert(Number.isInteger(Quorum.FORKED_OFFSET));
Assert(Number.isInteger(Quorum.SIZE));
Assert(Quorum.ID === 16);
Assert(Quorum.VECTOR === Quorum.ID * 2);
Assert(Quorum.LEADER_OFFSET === 0);
Assert(Quorum.LENGTH_OFFSET === 1);
Assert(Quorum.REPAIR_OFFSET === 2);
Assert(Quorum.FORKED_OFFSET === 3);
Assert(Quorum.SIZE === 4);
Assert(typeof Quorum.calculate === 'function');
Assert(typeof Quorum.update === 'function');

// Test method exceptions:
[
  [
    'calculate',
    new Array(8),
    'arguments.length must be at least 9'
  ],
  [
    'calculate',
    new Array(11),
    'arguments.length must be at most 10'
  ],
  [
    'calculate',
    Generate.argsOverride({ vectorOffset: -1 }),
    'vectorOffset must be at least 0'
  ],
  [
    'calculate',
    Generate.argsOverride({ objectSize: Quorum.VECTOR - 1 }),
    'objectSize must be at least VECTOR'
  ],
  [
    'calculate',
    Generate.argsOverride({ vectorOffset: 1 }),
    'objectSize must be at least vectorOffset + VECTOR'
  ],
  [
    'calculate',
    Generate.argsOverride({ sourceOffset: -1 }),
    'sourceOffset must be at least 0'
  ],
  [
    'calculate',
    Generate.argsOverride({ sourceSize: Quorum.VECTOR - 1 }),
    'sourceSize must be at least objectSize'
  ],
  [
    'calculate',
    Generate.argsOverride({ sourceSize: Quorum.VECTOR + 1 }),
    'sourceSize must be a multiple of objectSize'
  ],
  [
    'calculate',
    Generate.argsOverride({ sources: {} }),
    'sources must be an array'
  ],
  [
    'calculate',
    Generate.argsOverride({ sources: new Array(Quorum.SOURCES_MIN - 1) }),
    'sources.length must be at least SOURCES_MIN'
  ],
  [
    'calculate',
    Generate.argsOverride({ sources: new Array(Quorum.SOURCES_MAX + 1) }),
    'sources.length must be at most SOURCES_MAX'
  ],
  [
    'calculate',
    Generate.argsOverride({ sources: [0] }),
    'sources must be an array of buffers'
  ],
  [
    'calculate',
    Generate.argsOverride({
      sources: [ Buffer.alloc(Quorum.VECTOR - 1) ]
    }),
    'source.length must be at least sourceOffset + sourceSize'
  ],
  [
    'calculate',
    Generate.argsOverride({
      sources: [ Buffer.alloc(Quorum.VECTOR), Buffer.alloc(Quorum.VECTOR * 2) ]
    }),
    'sources must have the same length'
  ],
  [
    'calculate',
    Generate.argsOverride({ quorum: new Array(1) }),
    'quorum must be a buffer'
  ],
  [
    'calculate',
    Generate.argsOverride({ quorumOffset: -1 }),
    'quorumOffset must be at least 0'
  ],
  [
    'calculate',
    Generate.argsOverride({ quorumOffset: 1 }),
    'quorum.length must be at least quorumOffset + ' +
    '(sourceSize / objectSize * QUORUM_SIZE)'
  ],
  [
    'calculate',
    Generate.argsOverride({ target: new Array(1) }),
    'target must be a buffer'
  ],
  [
    'calculate',
    Generate.argsOverride({ targetOffset: -1 }),
    'targetOffset must be at least 0'
  ],
  [
    'calculate',
    Generate.argsOverride({ targetOffset: 1 }),
    'target.length must be at least targetOffset + sourceSize'
  ],
  [
    'calculate',
    Generate.argsOverride({ callback: {} }),
    'callback must be a function'
  ],
  [
    'calculate',
    Generate.argsOverride({ sources: Generate.vectors([[2, 2]]) }), // Fast path
    'vectors must not have cyclic references'
  ],
  [
    'calculate',
    Generate.argsOverride({
      sources: Generate.vectors([[4, 3], [3, 1], [1, 2], [2, 1]]), // Slow path
    }),
    'vectors must not have cyclic references'
  ],
  [
    'calculate',
    Generate.argsOverride({
      sources: Generate.vectors([[4, 3], [3, 1], [1, 1]]), // Slow path
    }),
    'vectors must not have cyclic references'
  ],
  [
    'update',
    [ new Uint8Array(Quorum.VECTOR), 0, Buffer.alloc(Quorum.ID, 1) ],
    'vector must be a buffer' // We need buffer methods such as copy().
  ],
  [
    'update',
    [ Generate.vectors([[2, 1]])[0], -1.5, Buffer.alloc(Quorum.ID, 3) ],
    'vectorOffset must be an integer'
  ],
  [
    'update',
    [ Generate.vectors([[2, 1]])[0], -1, Buffer.alloc(Quorum.ID, 3) ],
    'vectorOffset must not be negative'
  ],
  [
    'update',
    [ Buffer.alloc(Quorum.VECTOR - 1), 0, Buffer.alloc(Quorum.ID, 3) ],
    'vector.length must be at least ' + Quorum.VECTOR
  ],
  [
    'update',
    [ Generate.vectors([[2, 1]])[0], 1, Buffer.alloc(Quorum.ID, 3) ],
    'vectorOffset must not overflow'
  ],
  [
    'update',
    [ Generate.vectors([[0, 1]])[0], 0, Buffer.alloc(Quorum.ID, 2) ],
    'vector[0] must not be zero'
  ],
  [
    'update',
    [ Generate.vectors([[1, 0]])[0], 0, Buffer.alloc(Quorum.ID, 2) ],
    'vector[1] must not be zero'
  ],
  [
    'update',
    [ Generate.vectors([[1, 1]])[0], 0, Buffer.alloc(Quorum.ID, 2) ],
    'vector[0] must not equal vector[1]'
  ],
  [
    'update',
    [ Generate.vectors([[2, 1]])[0], 0, new Uint8Array(Quorum.ID) ],
    'id must be a buffer'
  ],
  [
    'update',
    [ Generate.vectors([[2, 1]])[0], 0, Buffer.alloc(Quorum.ID - 1, 3) ],
    'id.length must be ' + Quorum.ID
  ],
  [
    'update',
    [ Generate.vectors([[2, 1]])[0], 0, Buffer.alloc(Quorum.ID + 1, 3) ],
    'id.length must be ' + Quorum.ID
  ],
  [
    'update',
    [ Generate.vectors([[2, 1]])[0], 0, Buffer.alloc(Quorum.ID, 0) ],
    'id must not be zero'
  ],
  [
    'update',
    [ Generate.vectors([[2, 1]])[0], 0, Buffer.alloc(Quorum.ID, 2) ],
    'id must not equal vector[0]'
  ],
  [
    'update',
    [ Generate.vectors([[2, 1]])[0], 0, Buffer.alloc(Quorum.ID, 1) ],
    'id must not equal vector[1]'
  ]
].forEach(
  function(test) {
    Assert(test.length === 3);
    try {
      var result = Quorum[test[0]](...test[1]);
    } catch (exception) {
      var error = exception.message;
    }
    if (error !== test[2]) {
      if (error !== undefined) {
        console.log('');
        console.log('Received exception: ' + JSON.stringify(error));
        console.log('');
      }
      throw new Error('Expected exception: ' + JSON.stringify(test[2]));
    }
  }
);

// Test update():
(function() {
  for (var test = 0; test < 100; test++) {
    var vectorOffset = Generate.choose(0, 1024);
    var vector = RandomBuffer(vectorOffset + Quorum.VECTOR);
    var id = RandomBuffer(Quorum.ID);
    var expect = Buffer.concat([
      id,
      vector.slice(vectorOffset, vectorOffset + Quorum.ID)
    ]);
    Quorum.update(vector, vectorOffset, id);
    Assert(
      vector.slice(vectorOffset, vectorOffset + Quorum.VECTOR).equals(expect)
    );
  }
})();

// Test calculate():
var queue = new Queue(8);
queue.onData = function(test, end) {
  var args = Generate.args();
  function execute(...parameters) {
    if (Random() < 0.8) {
      Quorum.calculate.apply(Quorum, parameters); // Async
    } else {
      var callback = parameters.pop();
      Quorum.calculate.apply(Quorum, parameters); // Sync
      callback();
    }
  }
  execute(
    args.vectorOffset,
    args.objectSize,
    args.sourceOffset,
    args.sourceSize,
    args.sources,
    args.quorum,
    args.quorumOffset,
    args.target,
    args.targetOffset,
    function(error) {
      if (error) return end(error);
      Reference.calculate(args);
      console.log(new Array(69 + 1).join('='));
      for (var index = 0; index < args.objects; index++) {
        if (index > 0) console.log(new Array(69 + 1).join('-'));
        console.log(
          Inspect.vectors(
            args.sources,
            args.sourceOffset + (index * args.objectSize) + args.vectorOffset
          )
        );
        var quorumOffset = args.quorumOffset + (index * Quorum.SIZE);
        var quorumA = Inspect.quorum(args.quorum, quorumOffset);
        var quorumB = Inspect.quorum(args.quorumReference, quorumOffset);
        console.log('');
        console.log('    QUORUM ' + quorumA);
        console.log('');
        if (quorumA !== quorumB) {
          throw new Error('expected ' + quorumB);
        }
        var max = args.sources.length;
        if (args.quorum[quorumOffset + Quorum.FORKED_OFFSET] === 0) {
          Assert(args.quorum[quorumOffset + Quorum.LEADER_OFFSET] < max);
          Assert(args.quorum[quorumOffset + Quorum.LENGTH_OFFSET] <= max);
          Assert(
            args.quorum[quorumOffset + Quorum.REPAIR_OFFSET] <
            args.quorum[quorumOffset + Quorum.LENGTH_OFFSET]
          );
        } else {
          Assert(args.quorum[quorumOffset + Quorum.FORKED_OFFSET] === 1);
          Assert(args.quorum[quorumOffset + Quorum.LEADER_OFFSET] === 0);
          Assert(args.quorum[quorumOffset + Quorum.LENGTH_OFFSET] === 0);
          Assert(args.quorum[quorumOffset + Quorum.REPAIR_OFFSET] === 0);
        }
      }
      for (var index = 0; index < args.sources.length; index++) {
        Assert(Hash(args.sources[index]) === args.hashes[index]);
      }
      Assert(
        Hash(args.quorum.slice(0, args.quorumOffset)) ===
        args.quorumPrefix
      );
      Assert(
        Hash(args.quorum.slice(args.quorumOffset + args.quorumSize)) ===
        args.quorumSuffix
      );
      Assert(args.quorum.equals(args.quorumReference));
      Assert(
        Hash(args.target.slice(0, args.targetOffset)) ===
        args.targetPrefix
      );
      Assert(
        Hash(args.target.slice(args.targetOffset + args.sourceSize)) ===
        args.targetSuffix
      );
      Assert(args.target.equals(args.targetReference));
      end();
    }
  );
};
queue.onEnd = function(error) {
  if (error) throw error;
  console.log('================');
  console.log('PASSED ALL TESTS');
  console.log('================');
};
for (var test = 0; test < 500; test++) queue.push(test);
queue.end();
