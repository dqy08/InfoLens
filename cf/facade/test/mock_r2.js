/** 测试用 R2 / ExecutionContext 替身。 */

export function mockR2({ failPut = false } = {}) {
  const objects = new Map();
  return {
    objects,
    async put(key, value, opts = {}) {
      if (failPut) throw new Error('R2 put failed');
      const body = typeof value === 'string' ? value : new TextDecoder().decode(value);
      objects.set(key, { body, opts });
    },
    async get(key) {
      const hit = objects.get(key);
      if (!hit) return null;
      return {
        text: async () => hit.body,
        json: async () => JSON.parse(hit.body),
      };
    },
  };
}

export function mockCtx() {
  const pending = [];
  return {
    waitUntil(p) {
      pending.push(Promise.resolve(p));
    },
    async flush() {
      await Promise.all(pending);
    },
  };
}

export function r2Records(bucket) {
  return [...bucket.objects.entries()].map(([key, v]) => ({
    key,
    record: JSON.parse(v.body),
  }));
}
