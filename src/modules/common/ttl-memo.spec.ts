import { TtlMemo } from "./ttl-memo";

describe("TtlMemo", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("serves the cached value within the TTL and refetches once it expires", async () => {
        const ttlMs = 1000;
        const memo = new TtlMemo<number>(ttlMs);
        const factory = jest.fn<Promise<number>, []>().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

        const first = await memo.get(factory);
        const cached = await memo.get(factory);

        expect(first).toBe(1);
        expect(cached).toBe(1);
        expect(factory).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(ttlMs + 1);

        const refreshed = await memo.get(factory);
        expect(refreshed).toBe(2);
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it("drops the entry when the factory rejects so the next caller can retry", async () => {
        const memo = new TtlMemo<number>(60_000);
        const failingFactory = jest.fn<Promise<number>, []>().mockRejectedValue(new Error("boom"));

        await expect(memo.get(failingFactory)).rejects.toThrow("boom");

        // Allow the swallowed `.catch` handler inside TtlMemo to run before
        // the retry path observes the cleared entry.
        await Promise.resolve();

        const succeedingFactory = jest.fn<Promise<number>, []>().mockResolvedValue(42);
        const retried = await memo.get(succeedingFactory);

        expect(retried).toBe(42);
        expect(failingFactory).toHaveBeenCalledTimes(1);
        expect(succeedingFactory).toHaveBeenCalledTimes(1);
    });

    it("collapses concurrent calls into a single in-flight factory invocation", async () => {
        const memo = new TtlMemo<string>(60_000);
        let resolveFactory: ((value: string) => void) | undefined;
        const factory = jest.fn<Promise<string>, []>(
            () =>
                new Promise<string>((resolve) => {
                    resolveFactory = resolve;
                }),
        );

        const firstCall = memo.get(factory);
        const secondCall = memo.get(factory);

        expect(factory).toHaveBeenCalledTimes(1);

        resolveFactory?.("shared");
        const [firstValue, secondValue] = await Promise.all([firstCall, secondCall]);

        expect(firstValue).toBe("shared");
        expect(secondValue).toBe("shared");
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("does not start a second factory while the first is still in-flight past the TTL", async () => {
        // Regression: a compute that outlives its TTL must NOT let the next
        // caller launch a parallel run. The original impl keyed only on
        // `expiresAt = start + ttl`, so once the TTL elapsed mid-flight every
        // subsequent request stampeded a fresh factory call.
        const ttlMs = 1000;
        const memo = new TtlMemo<string>(ttlMs);
        let resolveFirst: ((value: string) => void) | undefined;
        const factory = jest
            .fn<Promise<string>, []>()
            .mockImplementationOnce(
                () =>
                    new Promise<string>((resolve) => {
                        resolveFirst = resolve;
                    }),
            )
            .mockResolvedValue("second");

        const firstCall = memo.get(factory);
        expect(factory).toHaveBeenCalledTimes(1);

        // TTL elapses while the first factory call is STILL running.
        jest.advanceTimersByTime(ttlMs + 1);

        const secondCall = memo.get(factory);
        // Must reuse the in-flight promise, not spawn a second factory.
        expect(factory).toHaveBeenCalledTimes(1);

        resolveFirst?.("first");
        await expect(firstCall).resolves.toBe("first");
        await expect(secondCall).resolves.toBe("first");
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("measures the TTL from when the factory resolves, not when it started", async () => {
        // A slow compute (longer than the TTL) should still yield a usable
        // cache window afterwards, rather than being considered stale the
        // instant it resolves.
        const ttlMs = 1000;
        const memo = new TtlMemo<string>(ttlMs);
        let resolveFirst: ((value: string) => void) | undefined;
        const factory = jest
            .fn<Promise<string>, []>()
            .mockImplementationOnce(
                () =>
                    new Promise<string>((resolve) => {
                        resolveFirst = resolve;
                    }),
            )
            .mockResolvedValue("second");

        const firstCall = memo.get(factory);
        jest.advanceTimersByTime(ttlMs * 3); // factory runs far longer than the TTL
        resolveFirst?.("first");
        await firstCall;

        // Immediately after resolution we are within a fresh TTL window.
        const cached = await memo.get(factory);
        expect(cached).toBe("first");
        expect(factory).toHaveBeenCalledTimes(1);
    });
});
