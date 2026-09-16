import { settleAllWithConcurrency } from "./concurrency";

describe("settleAllWithConcurrency", () => {
    it("keeps input order and per-task settled shape", async () => {
        const results = await settleAllWithConcurrency(
            [() => Promise.resolve("a"), () => Promise.reject(new Error("boom")), () => Promise.resolve(3)] as const,
            2,
        );

        expect(results[0]).toEqual({ status: "fulfilled", value: "a" });
        expect(results[1].status).toBe("rejected");
        expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
    });

    it("never runs more than `concurrency` tasks at once", async () => {
        let inFlight = 0;
        let peak = 0;
        const task = async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 1));
            inFlight -= 1;
            return null;
        };

        await settleAllWithConcurrency(
            Array.from({ length: 12 }, () => task),
            3,
        );

        expect(peak).toBe(3);
    });

    it("does not start a task before a slot frees up", async () => {
        const started: number[] = [];
        const tasks = [0, 1, 2].map((i) => async () => {
            started.push(i);
            await new Promise((resolve) => setTimeout(resolve, 5));
            return i;
        });

        const pending = settleAllWithConcurrency(tasks, 1);
        expect(started).toEqual([0]);
        await pending;
        expect(started).toEqual([0, 1, 2]);
    });
});
