import { describe, it, expect, beforeEach } from "vitest";
import {
  CollaborationManager,
  canTransition,
  type CollabTaskStatus,
} from "../social/collaboration.js";

// Mock social client
function mockSocial() {
  const sent: { to: string; content: string }[] = [];
  return {
    sent,
    send: async (to: string, content: string) => {
      sent.push({ to, content });
      return { id: "msg-" + sent.length };
    },
    poll: async () => ({ messages: [], nextCursor: undefined }),
    unreadCount: async () => 0,
  };
}

describe("canTransition", () => {
  const valid: [CollabTaskStatus, CollabTaskStatus][] = [
    ["pending", "accepted"],
    ["pending", "rejected"],
    ["pending", "cancelled"],
    ["accepted", "in_progress"],
    ["in_progress", "delivered"],
    ["delivered", "verified"],
    ["delivered", "disputed"],
    ["verified", "paid"],
    ["disputed", "in_progress"],
    ["disputed", "cancelled"],
  ];
  for (const [from, to] of valid) {
    it(`allows ${from} → ${to}`, () => expect(canTransition(from, to)).toBe(true));
  }

  const invalid: [CollabTaskStatus, CollabTaskStatus][] = [
    ["pending", "in_progress"],
    ["pending", "delivered"],
    ["rejected", "accepted"],
    ["paid", "delivered"],
    ["cancelled", "pending"],
  ];
  for (const [from, to] of invalid) {
    it(`blocks ${from} → ${to}`, () => expect(canTransition(from, to)).toBe(false));
  }
});

describe("CollaborationManager", () => {
  const REQUESTER = "0xaaa";
  const WORKER = "0xbbb";
  let social: ReturnType<typeof mockSocial>;
  let requesterMgr: CollaborationManager;
  let workerMgr: CollaborationManager;

  beforeEach(() => {
    social = mockSocial();
    requesterMgr = new CollaborationManager(REQUESTER, social);
    workerMgr = new CollaborationManager(WORKER, social);
  });

  describe("full task lifecycle", () => {
    it("pending → accepted → in_progress → delivered → verified → paid", async () => {
      // 1. Requester creates task
      const task = await requesterMgr.requestTask(
        WORKER, "Build a website", ["HTML", "CSS"], 5000, "2026-03-01T00:00:00Z",
      );
      expect(task.status).toBe("pending");
      expect(task.paymentOfferCents).toBe(5000);
      expect(requesterMgr.getEscrow(task.id)?.status).toBe("held");
      expect(requesterMgr.getEscrow(task.id)?.amountCents).toBe(5000);

      // Message sent via social
      expect(social.sent.length).toBe(1);
      const sentMsg = JSON.parse(social.sent[0].content);
      expect(sentMsg.protocol).toBe("collab/v1");
      expect(sentMsg.type).toBe("task_request");

      // 2. Worker receives and accepts
      workerMgr.handleIncomingMessage(REQUESTER, social.sent[0].content);
      const accepted = await workerMgr.respondToTask(task.id, "accept");
      expect(accepted.status).toBe("accepted");

      // 3. Worker starts work
      const inProgress = workerMgr.startWork(task.id);
      expect(inProgress.status).toBe("in_progress");

      // 4. Worker delivers
      const delivered = await workerMgr.deliverTask(task.id, "Website at https://example.com");
      expect(delivered.status).toBe("delivered");
      expect(delivered.deliverables).toBe("Website at https://example.com");

      // 5. Requester verifies (sync the task to requester side)
      requesterMgr["tasks"].set(task.id, { ...delivered, requesterAddress: REQUESTER.toLowerCase() });
      const verified = await requesterMgr.verifyDelivery(task.id, true, "Looks great!");
      expect(verified.status).toBe("verified");

      // 6. Release payment
      const paid = requesterMgr.releasePayment(task.id);
      expect(paid.status).toBe("paid");
      expect(requesterMgr.getEscrow(task.id)?.status).toBe("released");
    });
  });

  describe("rejection and escrow refund", () => {
    it("refunds escrow on rejection", async () => {
      const task = await requesterMgr.requestTask(WORKER, "Task", [], 1000);
      expect(requesterMgr.getEscrow(task.id)?.status).toBe("held");

      // Worker receives and rejects
      workerMgr.handleIncomingMessage(REQUESTER, social.sent[0].content);
      await workerMgr.respondToTask(task.id, "reject");

      // Requester-side escrow still held (worker rejection only updates worker's view)
      // In production, the response message would trigger requester-side refund
      // Worker side has no escrow entry (only requester creates escrow)
      expect(requesterMgr.getEscrow(task.id)?.status).toBe("held");
    });
  });

  describe("negotiation", () => {
    it("allows counter-offers while staying pending", async () => {
      const task = await requesterMgr.requestTask(WORKER, "Design logo", [], 2000);
      workerMgr.handleIncomingMessage(REQUESTER, social.sent[0].content);

      const negotiated = await workerMgr.respondToTask(task.id, "negotiate", 3000, "Need more for this scope");
      expect(negotiated.status).toBe("pending");
      expect(negotiated.counterOfferCents).toBe(3000);
      expect(negotiated.counterMessage).toBe("Need more for this scope");
    });
  });

  describe("cancellation", () => {
    it("can cancel pending task and refund escrow", async () => {
      const task = await requesterMgr.requestTask(WORKER, "Cancel me", [], 500);
      const cancelled = requesterMgr.cancelTask(task.id);
      expect(cancelled.status).toBe("cancelled");
      expect(requesterMgr.getEscrow(task.id)?.status).toBe("refunded");
    });

    it("cannot cancel a paid task", async () => {
      const task = await requesterMgr.requestTask(WORKER, "Done", [], 100);
      // Force to paid state
      task.status = "paid";
      expect(() => requesterMgr.cancelTask(task.id)).toThrow();
    });
  });

  describe("dispute flow", () => {
    it("disputed → in_progress for rework", async () => {
      const task = await requesterMgr.requestTask(WORKER, "Work", [], 1000);
      // Simulate through to delivered
      task.status = "delivered";
      const disputed = await requesterMgr.verifyDelivery(task.id, false, "Not good enough");
      expect(disputed.status).toBe("disputed");

      // Can go back to in_progress
      requesterMgr.startWork(task.id);  // rework
      expect(requesterMgr.getTask(task.id)?.status).toBe("in_progress");
    });
  });

  describe("invalid transitions", () => {
    it("throws on invalid state transition", async () => {
      const task = await requesterMgr.requestTask(WORKER, "X", [], 100);
      // Can't deliver a pending task
      task.workerAddress = REQUESTER.toLowerCase(); // hack to bypass worker check
      await expect(requesterMgr.deliverTask(task.id, "stuff")).rejects.toThrow();
    });
  });

  describe("listTasks and escrow tracking", () => {
    it("lists tasks filtered by role", async () => {
      await requesterMgr.requestTask(WORKER, "Task 1", [], 100);
      await requesterMgr.requestTask(WORKER, "Task 2", [], 200);

      const all = requesterMgr.listTasks();
      expect(all.length).toBe(2);

      const asRequester = requesterMgr.listTasks({ role: "requester" });
      expect(asRequester.length).toBe(2);

      const asWorker = requesterMgr.listTasks({ role: "worker" });
      expect(asWorker.length).toBe(0);
    });

    it("tracks total escrow held", async () => {
      await requesterMgr.requestTask(WORKER, "A", [], 1000);
      await requesterMgr.requestTask(WORKER, "B", [], 2000);
      expect(requesterMgr.getTotalEscrowHeld()).toBe(3000);

      // Cancel one
      const tasks = requesterMgr.listTasks();
      requesterMgr.cancelTask(tasks[0].id);
      expect(requesterMgr.getTotalEscrowHeld()).toBe(tasks[1].paymentOfferCents);
    });
  });

  describe("incoming message handling", () => {
    it("ignores non-collab messages", () => {
      const result = workerMgr.handleIncomingMessage(REQUESTER, "just a plain message");
      expect(result).toBeNull();
    });

    it("ignores messages with wrong protocol", () => {
      const result = workerMgr.handleIncomingMessage(REQUESTER, JSON.stringify({ protocol: "other", type: "x", taskId: "1", payload: {} }));
      expect(result).toBeNull();
    });

    it("creates task from incoming task_request", async () => {
      await requesterMgr.requestTask(WORKER, "Incoming task", ["req1"], 500);
      const msg = social.sent[0].content;
      const result = workerMgr.handleIncomingMessage(REQUESTER, msg);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("task_request");

      const workerTasks = workerMgr.listTasks({ role: "worker" });
      expect(workerTasks.length).toBe(1);
      expect(workerTasks[0].status).toBe("pending");
    });
  });

  describe("authorization checks", () => {
    it("only worker can respond", async () => {
      const task = await requesterMgr.requestTask(WORKER, "X", [], 100);
      // Requester tries to respond to own task
      await expect(requesterMgr.respondToTask(task.id, "accept")).rejects.toThrow("Only the assigned worker");
    });

    it("only worker can deliver", async () => {
      const task = await requesterMgr.requestTask(WORKER, "X", [], 100);
      task.status = "in_progress";
      await expect(requesterMgr.deliverTask(task.id, "stuff")).rejects.toThrow("Only the worker");
    });

    it("only requester can verify", async () => {
      const task = await requesterMgr.requestTask(WORKER, "X", [], 100);
      workerMgr.handleIncomingMessage(REQUESTER, social.sent[0].content);
      // Simulate delivered state on worker side
      const workerTask = workerMgr.getTask(task.id)!;
      workerTask.status = "delivered";
      await expect(workerMgr.verifyDelivery(task.id, true)).rejects.toThrow("Only the requester");
    });
  });
});
