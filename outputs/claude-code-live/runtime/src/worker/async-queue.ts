// Minimal async queue used as the SDK streaming-input iterable.
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as unknown as T, done: true });
  }

  get isEnded(): boolean {
    return this.ended;
  }

  iterable(): AsyncIterable<T> {
    const next = (): Promise<IteratorResult<T>> => {
      if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
      if (this.ended) return Promise.resolve({ value: undefined as unknown as T, done: true });
      return new Promise((resolve) => this.waiters.push(resolve));
    };
    return {
      [Symbol.asyncIterator]: () => ({
        next,
        return: async () => {
          this.end();
          return { value: undefined as unknown as T, done: true };
        },
      }),
    };
  }
}
