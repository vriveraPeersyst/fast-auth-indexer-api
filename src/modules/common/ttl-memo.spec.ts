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
});
