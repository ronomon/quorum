'use strict';

var Assert = require('assert');
var Quorum = require('./binding.node');

function equal(a, aOffset, b, bOffset) {
  var size = Quorum.ID;
  while (size--) if (a[aOffset++] !== b[bOffset++]) return false;
  return true;
}

function zero(buffer, offset) {
  var size = Quorum.ID;
  while (size--) if (buffer[offset++] !== 0) return false;
  return true;
}

// While Quorum.calculate() is written in C, it amortizes the call overhead.
// Quorum.update() is best written in JS since it will be called frequently.
Quorum.update = function(vector, vectorOffset, id) {
  if (!Buffer.isBuffer(vector)) {
    throw new Error('vector must be a buffer');
  }
  if (!Number.isInteger(vectorOffset)) {
    throw new Error('vectorOffset must be an integer');
  }
  if (vectorOffset < 0) {
    throw new Error('vectorOffset must not be negative');
  }
  if (vector.length < Quorum.VECTOR) {
    throw new Error('vector.length must be at least ' + Quorum.VECTOR);
  }
  if (vectorOffset + Quorum.VECTOR > vector.length) {
    throw new Error('vectorOffset must not overflow');
  }
  if (zero(vector, vectorOffset)) {
    throw new Error('vector[0] must not be zero');
  }
  if (zero(vector, vectorOffset + Quorum.ID)) {
    throw new Error('vector[1] must not be zero');
  }
  if (equal(vector, vectorOffset, vector, vectorOffset + Quorum.ID)) {
    throw new Error('vector[0] must not equal vector[1]');
  }
  if (!Buffer.isBuffer(id)) {
    throw new Error('id must be a buffer');
  }
  if (id.length !== Quorum.ID) {
    throw new Error('id.length must be ' + Quorum.ID);
  }
  if (zero(id, 0)) {
    throw new Error('id must not be zero');
  }
  if (equal(id, 0, vector, vectorOffset)) {
    throw new Error('id must not equal vector[0]');
  }
  if (equal(id, 0, vector, vectorOffset + Quorum.ID)) {
    throw new Error('id must not equal vector[1]');
  }
  Assert(
    vector.copy(
      vector,
      vectorOffset + Quorum.ID,
      vectorOffset,
      vectorOffset + Quorum.ID
    ) === Quorum.ID
  );
  Assert(equal(vector, vectorOffset, vector, vectorOffset + Quorum.ID));
  Assert(id.copy(vector, vectorOffset, 0, Quorum.ID) === Quorum.ID);
  Assert(equal(vector, vectorOffset, id, 0));
  return vector;
};

module.exports = Quorum;
