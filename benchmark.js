var Crypto = require('crypto');
var Quorum = require('./index.js');

var objects = 1000;
var vectorOffset = 0;
var objectSize = Quorum.VECTOR;
var sourceOffset = 0;
var sourceSize = objects * objectSize;
var quorum = Buffer.alloc(objects * Quorum.SIZE);
var quorumOffset = 0;
var target = Buffer.alloc(sourceSize);
var targetOffset = 0;
var a = Crypto.randomBytes(sourceSize);
var b = Crypto.randomBytes(sourceSize);

function ns(time, runs) {
  var elapsed = process.hrtime(time);
  return Math.round(
    ((elapsed[0] * 1000 * 1000000) + elapsed[1]) / objects / runs
  );
}

console.log('');
console.log('  ' + require('os').cpus()[0].model);
console.log('');
console.log('                NS PER OBJECT');
console.log('');

for (var length = 1; length <= Quorum.SOURCES_MAX; length *= 2) {
  
  // Fast path:
  var sources = [];
  for (var index = 0; index < length; index++) {
    sources.push(index % 3 ? a : b);
  }
  var time = process.hrtime();
  var runs = 100;
  for (var index = 0; index < runs; index++) {
    Quorum.calculate(
      vectorOffset,
      objectSize,
      sourceOffset,
      sourceSize,
      sources,
      quorum,
      quorumOffset,
      target,
      targetOffset
    );
  }
  var fast = ns(time, runs);

  // Slow path:
  var sources = [];
  for (var index = 0; index < length; index++) {
    sources.push(Crypto.randomBytes(sourceSize));
  }
  var time = process.hrtime();
  var runs = 10;
  for (var index = 0; index < runs; index++) {
    Quorum.calculate(
      vectorOffset,
      objectSize,
      sourceOffset,
      sourceSize,
      sources,
      quorum,
      quorumOffset,
      target,
      targetOffset
    );
  }
  var slow = ns(time, runs);
  if (slow < fast) slow = fast;

  console.log(
    '  REPLICAS=' + length.toString().padEnd(4, ' ') +
    ' FAST=' + (fast + 'ns').padEnd(7, ' ') +
    ' SLOW=' + (slow + 'ns')
  );
}
console.log('');
