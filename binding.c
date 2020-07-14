#include <assert.h>
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define QUORUM_THROW(env, message)                                             \
  do {                                                                         \
    napi_throw_error((env), NULL, (message));                                  \
    return NULL;                                                               \
  } while (0)

#define QUORUM_TRY(env, call)                                                  \
  do {                                                                         \
    if ((call) != napi_ok) {                                                   \
      const napi_extended_error_info *error;                                   \
      napi_get_last_error_info((env), &error);                                 \
      bool pending;                                                            \
      napi_is_exception_pending((env), &pending);                              \
      if (!pending) {                                                          \
        const char* message = (                                                \
          error->error_message != NULL ? error->error_message : "napi error"   \
        );                                                                     \
        napi_throw_error((env), NULL, message);                                \
      }                                                                        \
      return NULL;                                                             \
    }                                                                          \
  } while (0)

#define QUORUM_GE(env, value, bound, value_string, bound_string)               \
  do {                                                                         \
    if ((value) < (bound)) {                                                   \
      QUORUM_THROW((env), value_string " must be at least " bound_string);     \
    }                                                                          \
  } while (0)

#define QUORUM_LE(env, value, bound, value_string, bound_string)               \
  do {                                                                         \
    if ((value) > (bound)) {                                                   \
      QUORUM_THROW((env), value_string " must be at most " bound_string);      \
    }                                                                          \
  } while (0)

#define QUORUM_SOURCES_MIN 1
#define QUORUM_SOURCES_MAX 255
#define QUORUM_ID 16
#define QUORUM_NODE 36 // Flags, Index, Length, Dependencies, ID, Dependency.
#define QUORUM_NODES (QUORUM_NODE * 2 * QUORUM_SOURCES_MAX)
#define QUORUM_VECTOR 32

#define QUORUM_DEPENDENT 1 // Node is dependent on another node.
#define QUORUM_TEMPORARY 2 // Node is part of a cyclic graph.
#define QUORUM_PERMANENT 4 // Node is already part of a partially ordered set.

#define QUORUM_ERROR_UNDEFINED -99
#define QUORUM_ERROR_COMPLETED -98

#define QUORUM_LEADER_OFFSET 0
#define QUORUM_LENGTH_OFFSET 1
#define QUORUM_REPAIR_OFFSET 2
#define QUORUM_FORKED_OFFSET 3
#define QUORUM_SIZE 4

static inline int quorum_equal(const uint8_t* a, const uint8_t* b) {
  if (a[ 0] != b[ 0]) return 0;
  if (a[ 1] != b[ 1]) return 0;
  if (a[ 2] != b[ 2]) return 0;
  if (a[ 3] != b[ 3]) return 0;
  if (a[ 4] != b[ 4]) return 0;
  if (a[ 5] != b[ 5]) return 0;
  if (a[ 6] != b[ 6]) return 0;
  if (a[ 7] != b[ 7]) return 0;
  if (a[ 8] != b[ 8]) return 0;
  if (a[ 9] != b[ 9]) return 0;
  if (a[10] != b[10]) return 0;
  if (a[11] != b[11]) return 0;
  if (a[12] != b[12]) return 0;
  if (a[13] != b[13]) return 0;
  if (a[14] != b[14]) return 0;
  if (a[15] != b[15]) return 0;
  return 1;
}

static int64_t quorum_node(
  const uint8_t* nodes,
  const int64_t nodesLength,
  const uint8_t* vector
) {
  int64_t nodesOffset = 0;
  while (nodesOffset < nodesLength) {
    if (quorum_equal(nodes + nodesOffset + 4, vector)) return nodesOffset;
    nodesOffset += QUORUM_NODE;
  }
  // Assert free space remains for an insert:
  assert(nodesLength < QUORUM_NODES);
  return -(nodesLength + 1);
};

static int64_t quorum_nodes(
  uint8_t** vectors,
  const int64_t vectorsLength,
  const int64_t vectorOffset,
  uint8_t* nodes
) {
  assert(vectorsLength >= QUORUM_SOURCES_MIN);
  assert(vectorsLength <= QUORUM_SOURCES_MAX);
  assert(vectorOffset >= 0);
  int64_t nodesLength = 0;
  for (int64_t index = 0; index < vectorsLength; index++) {
    const uint8_t* vector = vectors[index] + vectorOffset;
    int64_t nodesOffset = quorum_node(nodes, nodesLength, vector);
    if (nodesOffset < 0) {
      nodesOffset = -(nodesOffset + 1);
      nodes[nodesOffset + 0] = QUORUM_DEPENDENT;
      nodes[nodesOffset + 1] = (uint8_t) index;
      nodes[nodesOffset + 2] = 1;
      nodes[nodesOffset + 3] = 0;
      memcpy(nodes + nodesOffset + 4, vector, QUORUM_VECTOR);
      nodesLength += QUORUM_NODE;
    } else {
      nodes[nodesOffset + 2]++;
      if ((nodes[nodesOffset] & QUORUM_DEPENDENT) == 0) {
        nodes[nodesOffset] |= QUORUM_DEPENDENT;
        memcpy(
          nodes + nodesOffset + 4 + QUORUM_ID,
          vector + QUORUM_ID,
          QUORUM_ID
        );
      }
    }
    nodesOffset = quorum_node(nodes, nodesLength, vector + QUORUM_ID);
    if (nodesOffset < 0) {
      nodesOffset = -(nodesOffset + 1);
      nodes[nodesOffset + 0] = 0;
      nodes[nodesOffset + 1] = 0;
      nodes[nodesOffset + 2] = 0;
      nodes[nodesOffset + 3] = 0;
      memcpy(nodes + nodesOffset + 4, vector + QUORUM_ID, QUORUM_ID);
      nodesLength += QUORUM_NODE;
    }
  }
  return nodesLength;
};

static int quorum_visit(
  uint8_t* nodes,
  const int64_t nodesOffset,
  const int64_t nodesLength,
  uint8_t* quorum,
  uint8_t* count
) {
  assert(nodesOffset >= 0); // A dependency was not found.
  assert(nodesLength > 0);
  if (nodes[nodesOffset] & QUORUM_PERMANENT) {
    *count = nodes[nodesOffset + 2];
    return 0;
  }
  if (nodes[nodesOffset] & QUORUM_TEMPORARY) return 1;
  nodes[nodesOffset] |= QUORUM_TEMPORARY;
  if (nodes[nodesOffset] & QUORUM_DEPENDENT) {
    int error = quorum_visit(
      nodes,
      quorum_node(nodes, nodesLength, nodes + nodesOffset + 4 + QUORUM_ID),
      nodesLength,
      quorum,
      nodes + nodesOffset + 3
    );
    if (error) return error;
    assert(nodes[nodesOffset + 2] + nodes[nodesOffset + 3] <= UINT8_MAX);
    nodes[nodesOffset + 2] += nodes[nodesOffset + 3];
  }
  nodes[nodesOffset] |= QUORUM_PERMANENT;
  if (quorum[QUORUM_LENGTH_OFFSET] < nodes[nodesOffset + 2]) {
    quorum[QUORUM_LEADER_OFFSET] = nodes[nodesOffset + 1];
    quorum[QUORUM_LENGTH_OFFSET] = nodes[nodesOffset + 2];
    quorum[QUORUM_REPAIR_OFFSET] = nodes[nodesOffset + 3];
    quorum[QUORUM_FORKED_OFFSET] = 0;
  } else if (quorum[QUORUM_LENGTH_OFFSET] == nodes[nodesOffset + 2]) {
    quorum[QUORUM_FORKED_OFFSET] = 1;
  }
  *count = nodes[nodesOffset + 2];
  return 0;
};

static int quorum_slow(
  uint8_t** vectors,
  const int64_t vectorsLength,
  const int64_t vectorOffset,
  uint8_t* nodes,
  uint8_t* quorum
) {
  assert(vectorsLength >= QUORUM_SOURCES_MIN);
  assert(vectorsLength <= QUORUM_SOURCES_MAX);
  assert(vectorOffset >= 0);
  quorum[QUORUM_LEADER_OFFSET] = 0; // Leader
  quorum[QUORUM_LENGTH_OFFSET] = 0; // Length
  quorum[QUORUM_REPAIR_OFFSET] = 0; // Repair
  quorum[QUORUM_FORKED_OFFSET] = 0; // Forked
  int64_t nodesOffset = 0;
  int64_t nodesLength = quorum_nodes(
    vectors,
    vectorsLength,
    vectorOffset,
    nodes
  );
  while (nodesOffset < nodesLength) {
    if ((nodes[nodesOffset] & (QUORUM_TEMPORARY | QUORUM_PERMANENT)) == 0) {
      uint8_t count = 0;
      int error = quorum_visit(nodes, nodesOffset, nodesLength, quorum, &count);
      if (error) return error;
    }
    nodesOffset += QUORUM_NODE;
  }
  if (quorum[QUORUM_FORKED_OFFSET] == 1) {
    quorum[QUORUM_LEADER_OFFSET] = 0;
    quorum[QUORUM_LENGTH_OFFSET] = 0;
    quorum[QUORUM_REPAIR_OFFSET] = 0;
  } else {
    assert(quorum[QUORUM_FORKED_OFFSET] == 0);
  }
  return 0;
};

static int quorum_fast(
  uint8_t** vectors,
  const int64_t vectorsLength,
  const int64_t vectorOffset,
  uint8_t* nodes,
  uint8_t* quorum
) {
  assert(vectorsLength >= QUORUM_SOURCES_MIN);
  assert(vectorsLength <= QUORUM_SOURCES_MAX);
  assert(vectorOffset >= 0);
  const uint8_t* a = NULL;
  const uint8_t* b = NULL;
  int64_t aIndex = 0;
  int64_t bIndex = 0;
  int64_t aLength = 0;
  int64_t bLength = 0;
  for (int64_t index = 0; index < vectorsLength; index++) {
    const uint8_t* vector = vectors[index] + vectorOffset;
    // Vector references itself as a dependency (cyclic reference):
    if (quorum_equal(vector, vector + QUORUM_ID)) return 1;
    if (aLength == 0) {
      a = vector;
      aIndex = index;
      aLength++;
    } else if (quorum_equal(vector, a)) {
      // The two vectors must be identical if the leading IDs are identical.
      // We assume that random IDs collide only for the same dependency.
      aLength++;
    } else if (
      quorum_equal(vector, a + QUORUM_ID) ||
      quorum_equal(a, vector + QUORUM_ID)
    ) {
      // The two vectors are part of the same chain, but an order exists.
      // We must exit the fast path and perform a topological sort.
      return quorum_slow(vectors, vectorsLength, vectorOffset, nodes, quorum);
    } else if (bLength == 0) {
      b = vector;
      bIndex = index;
      bLength++;
    } else if (quorum_equal(vector, b)) {
      bLength++;
    } else {
      // We have more than two chains, or require the second to be sorted.
      // We must exit the fast path and perform a topological sort.
      return quorum_slow(vectors, vectorsLength, vectorOffset, nodes, quorum);
    }
  }
  assert(aIndex <= UINT8_MAX);
  assert(bIndex <= UINT8_MAX);
  assert(aIndex < vectorsLength);
  assert(bIndex < vectorsLength);
  assert(aLength <= UINT8_MAX);
  assert(bLength <= UINT8_MAX);
  assert(aLength + bLength == vectorsLength);
  if (aLength == bLength) {
    quorum[QUORUM_LEADER_OFFSET] = 0;
    quorum[QUORUM_LENGTH_OFFSET] = 0;
    quorum[QUORUM_REPAIR_OFFSET] = 0;
    quorum[QUORUM_FORKED_OFFSET] = 1;
  } else if (aLength > bLength) {
    quorum[QUORUM_LEADER_OFFSET] = (uint8_t) aIndex;
    quorum[QUORUM_LENGTH_OFFSET] = (uint8_t) aLength;
    quorum[QUORUM_REPAIR_OFFSET] = 0;
    quorum[QUORUM_FORKED_OFFSET] = 0;
  } else {
    quorum[QUORUM_LEADER_OFFSET] = (uint8_t) bIndex;
    quorum[QUORUM_LENGTH_OFFSET] = (uint8_t) bLength;
    quorum[QUORUM_REPAIR_OFFSET] = 0;
    quorum[QUORUM_FORKED_OFFSET] = 0;
  }
  return 0;
}

static int quorum_iterate(
  const int64_t vectorOffset,
  const int64_t objectSize,
  const int64_t sourceSize,
  uint8_t** sources,
  const int64_t sourcesLength,
  uint8_t* quorum,
  uint8_t* target
) {
  assert(vectorOffset >= 0);
  assert(objectSize >= 0);
  assert(objectSize >= vectorOffset + QUORUM_VECTOR);
  assert(sourceSize >= 0);
  assert(sourceSize >= objectSize);
  assert(sourceSize % objectSize == 0);
  assert(sourcesLength >= QUORUM_SOURCES_MIN);
  assert(sourcesLength <= QUORUM_SOURCES_MAX);
  assert(sourcesLength <= UINT8_MAX);
  assert(sourcesLength <= 255);
  int64_t sourceOffset = 0;
  uint8_t* nodes = malloc(QUORUM_NODES);
  assert(nodes != NULL);
  int error = 0;
  while (sourceOffset < sourceSize) {
    assert(sourceOffset + objectSize <= sourceSize);
    assert(sourceOffset + vectorOffset + QUORUM_VECTOR <= sourceSize);
    error = quorum_fast(
      sources,
      sourcesLength,
      sourceOffset + vectorOffset,
      nodes,
      quorum
    );
    if (error) break;
    if (quorum[QUORUM_LENGTH_OFFSET] > 0) {
      assert(sourcesLength > 0);
      memcpy(
        target,
        sources[quorum[QUORUM_LEADER_OFFSET]] + sourceOffset,
        objectSize
      );
    } else {
      memset(target, 0, objectSize);
    }
    sourceOffset += objectSize;
    quorum += QUORUM_SIZE;
    target += objectSize;
  }
  if (nodes != NULL) {
    free(nodes);
    nodes = NULL;
  }
  return error;
}

struct quorum_context {
  int64_t vectorOffset;
  int64_t objectSize;
  int64_t sourceSize;
  uint8_t* sources[255];
  int64_t sourcesLength;
  uint8_t* quorum;
  uint8_t* target;
  int error;
  napi_ref ref_sources;
  napi_ref ref_quorum;
  napi_ref ref_target;
  napi_ref ref_callback;
  napi_async_work async_work;
};

napi_value quorum_error(napi_env env, int error) {
  assert(error != 0);
  assert(error == 1);
  napi_value code;
  napi_value message;
  napi_value result;
  assert(
    napi_create_string_utf8(
      env,
      "ERR_CYCLIC_REFERENCES",
      NAPI_AUTO_LENGTH,
      &code
    ) == napi_ok
  );
  assert(
    napi_create_string_utf8(
      env,
      "vectors must not have cyclic references",
      NAPI_AUTO_LENGTH,
      &message
    ) == napi_ok
  );
  napi_create_error(env, code, message, &result);
  return result;
}

void quorum_async_execute(napi_env env, void* data) {
  struct quorum_context* ctx = data;
  assert(ctx->error != QUORUM_ERROR_COMPLETED);
  assert(ctx->error == QUORUM_ERROR_UNDEFINED);
  ctx->error = quorum_iterate(
    ctx->vectorOffset,
    ctx->objectSize,
    ctx->sourceSize,
    ctx->sources,
    ctx->sourcesLength,
    ctx->quorum,
    ctx->target
  );
  assert(ctx->error == 0 || ctx->error == 1);
}

void quorum_async_complete(napi_env env, napi_status status, void* data) {
  struct quorum_context* ctx = data;
  assert(ctx->error != QUORUM_ERROR_COMPLETED);
  assert(ctx->error != QUORUM_ERROR_UNDEFINED);
  assert(ctx->error == 0 || ctx->error == 1);
  napi_value scope;
  assert(napi_get_global(env, &scope) == napi_ok);
  napi_value callback;
  assert(
    napi_get_reference_value(env, ctx->ref_callback, &callback) == napi_ok
  );
  int argc = 0;
  napi_value argv[1];
  if (ctx->error) argv[argc++] = quorum_error(env, ctx->error);
  ctx->error = QUORUM_ERROR_COMPLETED;
  // Do not assert the return status of napi_call_function():
  // If the user throws our error, then the return status will not be napi_ok.
  napi_value result;
  napi_call_function(env, scope, callback, argc, argv, &result);
  assert(napi_delete_reference(env, ctx->ref_sources) == napi_ok);
  assert(napi_delete_reference(env, ctx->ref_quorum) == napi_ok);
  assert(napi_delete_reference(env, ctx->ref_target) == napi_ok);
  assert(napi_delete_reference(env, ctx->ref_callback) == napi_ok);
  assert(napi_delete_async_work(env, ctx->async_work) == napi_ok);
  free(ctx);
  ctx = NULL;
}

static napi_value quorum_calculate(napi_env env, napi_callback_info info) {
  size_t argc = 10;
  napi_value argv[10];
  QUORUM_TRY(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  QUORUM_GE(env, argc, 9, "arguments.length", "9");
  QUORUM_LE(env, argc, 10, "arguments.length", "10");
  // vectorOffset:
  int64_t vectorOffset;
  QUORUM_TRY(env, napi_get_value_int64(env, argv[0], &vectorOffset));
  QUORUM_GE(env, vectorOffset, 0, "vectorOffset", "0");
  // objectSize:
  int64_t objectSize;
  QUORUM_TRY(env, napi_get_value_int64(env, argv[1], &objectSize));
  QUORUM_GE(env, objectSize, 0, "objectSize", "0");
  QUORUM_GE(env, objectSize, QUORUM_VECTOR, "objectSize", "VECTOR");
  QUORUM_GE(
    env,
    objectSize,
    vectorOffset + QUORUM_VECTOR,
    "objectSize",
    "vectorOffset + VECTOR"
  );
  // sourceOffset:
  int64_t sourceOffset;
  QUORUM_TRY(env, napi_get_value_int64(env, argv[2], &sourceOffset));
  QUORUM_GE(env, sourceOffset, 0, "sourceOffset", "0");
  // sourceSize:
  int64_t sourceSize;
  QUORUM_TRY(env, napi_get_value_int64(env, argv[3], &sourceSize));
  QUORUM_GE(env, sourceSize, 0, "sourceSize", "0");
  QUORUM_GE(env, sourceSize, objectSize, "sourceSize", "objectSize");
  if (sourceSize % objectSize) {
    QUORUM_THROW(env, "sourceSize must be a multiple of objectSize");
  }
  // sources:
  bool sourcesIsArray;
  QUORUM_TRY(env, napi_is_array(env, argv[4], &sourcesIsArray));
  if (!sourcesIsArray) QUORUM_THROW(env, "sources must be an array");
  uint32_t sourcesLengthU32;
  QUORUM_TRY(env, napi_get_array_length(env, argv[4], &sourcesLengthU32));
  int64_t sourcesLength = (int64_t) sourcesLengthU32;
  QUORUM_GE(
    env,
    sourcesLength,
    QUORUM_SOURCES_MIN,
    "sources.length",
    "SOURCES_MIN"
  );
  QUORUM_LE(
    env,
    sourcesLength,
    QUORUM_SOURCES_MAX,
    "sources.length",
    "SOURCES_MAX"
  );
  QUORUM_LE(env, sourcesLength, UINT8_MAX, "sources.length", "UINT8_MAX");
  QUORUM_LE(env, sourcesLength, 255, "sources.length", "255");
  size_t sourceLength0;
  uint8_t* sources[255];
  for (int64_t index = 0; index < sourcesLength; index++) {
    napi_value element;
    QUORUM_TRY(env, napi_get_element(env, argv[4], index, &element));
    bool sourceIsBuffer;
    QUORUM_TRY(env, napi_is_buffer(env, element, &sourceIsBuffer));
    if (!sourceIsBuffer) {
      QUORUM_THROW(env, "sources must be an array of buffers");
    }
    uint8_t* source;
    size_t sourceLength;
    QUORUM_TRY(
      env,
      napi_get_buffer_info(env, element, (void**) &source, &sourceLength)
    );
    QUORUM_GE(
      env,
      (int64_t) sourceLength,
      sourceOffset + sourceSize,
      "source.length",
      "sourceOffset + sourceSize"
    );
    if (index == 0) {
      sourceLength0 = sourceLength;
    } else if (sourceLength != sourceLength0) {
      QUORUM_THROW(env, "sources must have the same length");
    }
    sources[index] = source + sourceOffset;
  }
  // quorum:
  bool quorumIsBuffer;
  QUORUM_TRY(env, napi_is_buffer(env, argv[5], &quorumIsBuffer));
  if (!quorumIsBuffer) QUORUM_THROW(env, "quorum must be a buffer");
  uint8_t* quorum;
  size_t quorumLength;
  QUORUM_TRY(
    env,
    napi_get_buffer_info(env, argv[5], (void**) &quorum, &quorumLength)
  );
  // quorumOffset:
  int64_t quorumOffset;
  QUORUM_TRY(env, napi_get_value_int64(env, argv[6], &quorumOffset));
  QUORUM_GE(env, quorumOffset, 0, "quorumOffset", "0");
  QUORUM_GE(
    env,
    (int64_t) quorumLength,
    quorumOffset + (sourceSize / objectSize * QUORUM_SIZE),
    "quorum.length",
    "quorumOffset + (sourceSize / objectSize * QUORUM_SIZE)"
  );
  quorum += quorumOffset;
  // target:
  bool targetIsBuffer;
  QUORUM_TRY(env, napi_is_buffer(env, argv[7], &targetIsBuffer));
  if (!targetIsBuffer) QUORUM_THROW(env, "target must be a buffer");
  uint8_t* target;
  size_t targetLength;
  QUORUM_TRY(
    env,
    napi_get_buffer_info(env, argv[7], (void**) &target, &targetLength)
  );
  // targetOffset:
  int64_t targetOffset;
  QUORUM_TRY(env, napi_get_value_int64(env, argv[8], &targetOffset));
  QUORUM_GE(env, targetOffset, 0, "targetOffset", "0");
  QUORUM_GE(
    env,
    (int64_t) targetLength,
    targetOffset + sourceSize,
    "target.length",
    "targetOffset + sourceSize"
  );
  target += targetOffset;
  // No callback (synchronous):
  if (argc < 10) {
    int error = quorum_iterate(
      vectorOffset,
      objectSize,
      sourceSize,
      sources,
      sourcesLength,
      quorum,
      target
    );
    if (error) assert(napi_throw(env, quorum_error(env, error)) == napi_ok);
    return NULL;
  }
  // callback:
  napi_valuetype callbackType;
  QUORUM_TRY(env, napi_typeof(env, argv[9], &callbackType));
  if (callbackType != napi_function) {
    QUORUM_THROW(env, "callback must be a function");
  }
  struct quorum_context* ctx = malloc(sizeof(struct quorum_context));
  if (!ctx) QUORUM_THROW(env, "context allocation failed");
  ctx->vectorOffset = vectorOffset;
  ctx->objectSize = objectSize;
  ctx->sourceSize = sourceSize;
  for (int64_t index = 0; index < sourcesLength; index++) {
    ctx->sources[index] = sources[index];
  }
  ctx->sourcesLength = sourcesLength;
  ctx->quorum = quorum;
  ctx->target = target;
  ctx->error = QUORUM_ERROR_UNDEFINED;
  napi_value resource_name;
  assert(
    napi_create_string_utf8(
      env,
      "@ronomon/quorum",
      NAPI_AUTO_LENGTH,
      &resource_name
    ) == napi_ok
  );
  assert(napi_create_reference(env, argv[4], 1, &ctx->ref_sources) == napi_ok);
  assert(napi_create_reference(env, argv[5], 1, &ctx->ref_quorum) == napi_ok);
  assert(napi_create_reference(env, argv[7], 1, &ctx->ref_target) == napi_ok);
  assert(napi_create_reference(env, argv[9], 1, &ctx->ref_callback) == napi_ok);
  assert(
    napi_create_async_work(
      env,
      NULL,
      resource_name,
      quorum_async_execute,
      quorum_async_complete,
      ctx,
      &ctx->async_work
    ) == napi_ok
  );
  assert(napi_queue_async_work(env, ctx->async_work) == napi_ok);
  return NULL;
}

void quorum_export_constant(
  napi_env env,
  napi_value exports,
  const char* key,
  const int64_t value
) {
  napi_value number;
  assert(value >= INT32_MIN);
  assert(value <= INT32_MAX);
  assert(napi_create_int32(env, (int32_t) value, &number) == napi_ok);
  assert(napi_set_named_property(env, exports, key, number) == napi_ok);
}

static napi_value Init(napi_env env, napi_value exports) {
  // Test constants:
  assert(QUORUM_SOURCES_MIN > 0);
  assert(QUORUM_SOURCES_MIN < QUORUM_SOURCES_MAX);
  assert(QUORUM_SOURCES_MAX > 0);
  assert(QUORUM_SOURCES_MAX <= 255);
  assert(QUORUM_SOURCES_MAX <= UINT8_MAX);
  assert(QUORUM_ID == 16); // Required by quorum_equal() for loop unrolling.
  assert(QUORUM_NODE == 4 + QUORUM_VECTOR);
  assert(QUORUM_NODES == QUORUM_NODE * 2 * QUORUM_SOURCES_MAX);
  assert(QUORUM_VECTOR == 32);
  assert(QUORUM_VECTOR == QUORUM_ID * 2);
  assert(QUORUM_DEPENDENT > 0);
  assert(QUORUM_TEMPORARY > 0);
  assert(QUORUM_PERMANENT > 0);
  assert(QUORUM_DEPENDENT != QUORUM_TEMPORARY);
  assert(QUORUM_DEPENDENT != QUORUM_PERMANENT);
  assert(QUORUM_TEMPORARY != QUORUM_PERMANENT);
  assert(QUORUM_LEADER_OFFSET >= 0);
  assert(QUORUM_LENGTH_OFFSET >= 0);
  assert(QUORUM_REPAIR_OFFSET >= 0);
  assert(QUORUM_FORKED_OFFSET >= 0);
  assert(QUORUM_LEADER_OFFSET != QUORUM_LENGTH_OFFSET);
  assert(QUORUM_LEADER_OFFSET != QUORUM_REPAIR_OFFSET);
  assert(QUORUM_LEADER_OFFSET != QUORUM_FORKED_OFFSET);
  assert(QUORUM_LENGTH_OFFSET != QUORUM_REPAIR_OFFSET);
  assert(QUORUM_LENGTH_OFFSET != QUORUM_FORKED_OFFSET);
  assert(QUORUM_REPAIR_OFFSET != QUORUM_FORKED_OFFSET);
  assert(QUORUM_SIZE == 4);
  // Test quorum_equal():
  uint8_t a[16];
  uint8_t b[16];
  int offset = 16;
  while (offset--) {
    memset(a, offset, 16);
    memset(b, offset, 16);
    assert(quorum_equal(a, b) == 1);
    a[offset] = offset + 1;
    assert(quorum_equal(a, b) == 0);
    b[offset] = offset + 1;
    a[offset] = offset;
    assert(quorum_equal(a, b) == 0);
    b[offset] = offset;
    assert(quorum_equal(a, b) == 1);
  }
  // Exports:
  napi_value method;
  assert(
    napi_create_function(env, NULL, 0, quorum_calculate, NULL, &method) ==
    napi_ok
  );
  assert(napi_set_named_property(env, exports, "calculate", method) == napi_ok);
  quorum_export_constant(env, exports, "SOURCES_MIN", QUORUM_SOURCES_MIN);
  quorum_export_constant(env, exports, "SOURCES_MAX", QUORUM_SOURCES_MAX);
  quorum_export_constant(env, exports, "ID", QUORUM_ID);
  quorum_export_constant(env, exports, "VECTOR", QUORUM_VECTOR);
  quorum_export_constant(env, exports, "LEADER_OFFSET", QUORUM_LEADER_OFFSET);
  quorum_export_constant(env, exports, "LENGTH_OFFSET", QUORUM_LENGTH_OFFSET);
  quorum_export_constant(env, exports, "REPAIR_OFFSET", QUORUM_REPAIR_OFFSET);
  quorum_export_constant(env, exports, "FORKED_OFFSET", QUORUM_FORKED_OFFSET);
  quorum_export_constant(env, exports, "SIZE", QUORUM_SIZE);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

// S.D.G.
