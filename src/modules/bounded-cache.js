'use strict';

class BoundedCache extends Map {
  constructor(limit) { super(); this.limit = limit; }
  get(key) {
    if (!super.has(key)) return undefined;
    const value = super.get(key);
    super.delete(key);
    super.set(key, value);
    return value;
  }
  set(key, value) {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.limit) super.delete(this.keys().next().value);
    return this;
  }
}

module.exports = { BoundedCache };
